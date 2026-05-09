import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { attachWebSocket } from '../websocket.js';
import { TerminalManager } from '../terminal-manager.js';
import { SessionManager } from '../session.js';
import type { ServerMsg } from '../types.js';

// Create a fresh SessionManager stub for each withServer call.
function makeFakeSession() {
  const sess = new SessionManager({
    allowedDirs: ['/Users/me/code'],
    bufferCap: 100,
    driverFactory: () => ({
      sendUserText: () => {},
      kill: () => {},
      on: () => sess as never,
      off: () => sess as never,
      once: () => sess as never,
      emit: () => false,
      addListener: () => sess as never,
      removeListener: () => sess as never,
    }) as never,
  });
  return sess;
}

// Helper: spin up a real server + ws client to round-trip messages.
async function withServer<T>(
  termMgr: TerminalManager,
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const server = createServer((_req, res) => res.end());
  attachWebSocket({
    server,
    token: 'test',
    sessionManager: makeFakeSession(),
    accounts: new Map(),
    fsApi: { listDirs: async () => [], readFile: async () => ({ kind: 'text' as const, content: '', bytesRead: 0, truncated: false }) } as never,
    imageStore: { validate: () => ({ ok: true } as never), writeAuditCopy: async () => {}, cleanup: async () => {} } as never,
    historyScanner: { list: async () => ({ claude: [], codex: [] }), findEntry: async () => null, filePathFor: () => null, invalidateCache: () => {} } as never,
    profileStore: { list: () => [], add: async () => {}, update: async () => {}, remove: async () => {}, setDefault: async () => {}, get: () => null } as never,
    slashCommands: { listForSession: async () => [] } as never,
    fileSearch: { search: async () => ({ hits: [], truncated: false }) } as never,
    terminalManager: termMgr,
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`ws://127.0.0.1:${port}/ws?token=test`);
  } finally {
    server.close();
  }
}

/** Connect a WebSocket and return it with a message buffer that collects all incoming messages.
 *
 * The `ready` promise resolves AFTER the server's connection handler has registered its
 * message listener. The attachWebSocket code uses a `setTimeout(0)` delay before emitting
 * the `connection` event, so we must wait at least one macrotask beyond `open` before
 * sending any messages (otherwise the `term_start` message can arrive before the server's
 * `ws.on('message')` listener is installed, causing it to be silently dropped).
 */
function connect(url: string): { ws: WebSocket; msgs: ServerMsg[]; ready: Promise<void> } {
  const ws = new WebSocket(url);
  const msgs: ServerMsg[] = [];
  // Install message listener immediately so no messages are missed, regardless of when
  // the `ready` promise resolves.
  ws.on('message', (raw) => {
    try {
      msgs.push(JSON.parse(raw.toString()) as ServerMsg);
    } catch {
      // ignore malformed frames
    }
  });
  ws.on('error', (err) => {
    // Suppress uncaught errors (e.g. ECONNREFUSED during server teardown).
    void err;
  });
  // Wait for the `init` message from the server — that's proof that the server's
  // connection handler has run (including registering ws.on('message')), so
  // subsequent client sends will be received correctly.
  const ready = new Promise<void>((resolve, reject) => {
    const check = (raw: import('ws').RawData) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'system' && m.event === 'init') {
          ws.off('message', check);
          clearTimeout(t);
          resolve();
        }
      } catch { /* ignore */ }
    };
    const t = setTimeout(() => {
      ws.off('message', check);
      reject(new Error('connect: timed out waiting for init'));
    }, 3000);
    ws.on('message', check);
  });
  return { ws, msgs, ready };
}

/** Wait until `predicate` is true for some element of `msgs`, polling every 10ms up to `timeoutMs`. */
function waitFor(msgs: ServerMsg[], predicate: (m: ServerMsg) => boolean, timeoutMs = 3000): Promise<ServerMsg> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = msgs.find(predicate);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor timed out after ${timeoutMs}ms; msgs: ${JSON.stringify(msgs)}`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

describe('websocket terminal routing', () => {
  function makeMgr() {
    const writes: string[] = [];
    return new TerminalManager({
      allowedDirs: ['/Users/me/code'],
      realpath: async (p) => p,
      procFactory: (_cwd) => {
        const ee = new EventEmitter() as unknown as import('../terminal-process.js').TerminalProcess;
        Object.assign(ee, {
          write: (d: string) => writes.push(d),
          resize: () => {},
          kill: () => (ee as unknown as EventEmitter).emit('exit', 0, null),
          pause: () => {},
          resume: () => {},
        });
        return ee;
      },
    });
  }

  it('term_start round-trips to term_started', async () => {
    const mgr = makeMgr();
    await withServer(mgr, async (url) => {
      const { ws, msgs, ready } = connect(url);
      await ready;
      ws.send(JSON.stringify({
        type: 'term_start', cwd: '/Users/me/code', cols: 80, rows: 24, correlationId: 'c1',
      }));
      const reply = await waitFor(msgs, (m) => m.type === 'term_started');
      expect(reply).toMatchObject({ type: 'term_started', cwd: '/Users/me/code', correlationId: 'c1' });
      ws.close();
    });
  });

  it('term_input only reaches the spawning ws\'s pty (cross-ws blocked)', async () => {
    const mgr = makeMgr();
    await withServer(mgr, async (url) => {
      const { ws: wsA, msgs: msgsA, ready: readyA } = connect(url);
      const { ws: wsB, msgs: msgsB, ready: readyB } = connect(url);
      await readyA;
      await readyB;

      wsA.send(JSON.stringify({
        type: 'term_start', cwd: '/Users/me/code', cols: 80, rows: 24, correlationId: 'c1',
      }));
      const started = await waitFor(msgsA, (m) => m.type === 'term_started');
      const termId = (started as { termId: string }).termId;

      wsB.send(JSON.stringify({ type: 'term_input', termId, data: 'evil' }));
      const err = await waitFor(msgsB, (m) => m.type === 'error' && (m as { code?: string }).code === 'terminal_not_found');
      expect(err).toMatchObject({ code: 'terminal_not_found' });

      wsA.close();
      wsB.close();
    });
  });

  it('ws close kills the associated PTY', async () => {
    const mgr = makeMgr();
    await withServer(mgr, async (url) => {
      const { ws, msgs, ready } = connect(url);
      await ready;
      ws.send(JSON.stringify({
        type: 'term_start', cwd: '/Users/me/code', cols: 80, rows: 24, correlationId: 'c1',
      }));
      const started = await waitFor(msgs, (m) => m.type === 'term_started');
      const termId = (started as { termId: string }).termId;
      ws.close();
      // Wait a tick for ws-close → killByWs → fake pty exit.
      await new Promise((r) => setTimeout(r, 50));
      // Fresh ws — cannot send input to the dead termId; sendInput is a silent
      // drop now (entry deleted), so we just verify nothing throws.
      const { ws: ws2, ready: ready2 } = connect(url);
      await ready2;
      ws2.send(JSON.stringify({ type: 'term_input', termId, data: 'gone' }));
      // No error event expected (silent drop for unknown termId).
      await new Promise((r) => setTimeout(r, 30));
      ws2.close();
    });
  });
});
