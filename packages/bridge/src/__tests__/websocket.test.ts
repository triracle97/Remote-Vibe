import { describe, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { attachWebSocket } from '../websocket.js';
import { SessionManager } from '../session.js';
import { EventEmitter } from 'node:events';

const TOKEN = 'a'.repeat(32);

class FakeProc extends EventEmitter {
  sendUserText = vi.fn();
  kill = vi.fn();
}

async function startServer(opts: {
  accounts?: Map<string, import('../accounts.js').CodexAccount>;
} = {}) {
  const procs: FakeProc[] = [];
  const mgr = new SessionManager({
    allowedDirs: ['/Users/test'],
    bufferCap: 100,
    driverFactory: () => {
      const p = new FakeProc();
      procs.push(p);
      return p as unknown as import('../session.js').AgentDriver;
    },
    realpath: async (p) => p,
    accounts: opts.accounts ?? new Map(),
  });
  const server = createServer();
  attachWebSocket({ server, token: TOKEN, sessionManager: mgr, accounts: opts.accounts ?? new Map() });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no addr');
  return {
    server: server as Server,
    port: addr.port,
    mgr,
    procs,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
}

function ws(url: string, headers: Record<string, string> = {}) {
  return new WebSocket(url, { headers });
}

function once<T>(emitter: EventEmitter, event: string): Promise<T> {
  return new Promise((r) => emitter.once(event, (v) => r(v as T)));
}

describe('websocket', () => {
  it('rejects upgrade without token', async () => {
    const { port, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`);
    const code = await new Promise<number>((r) => sock.on('unexpected-response', (_req, res) => r(res.statusCode ?? 0)));
    expect(code).toBe(401);
    await close();
  });

  it('rejects upgrade with wrong Origin and valid cookie', async () => {
    const { port, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: 'http://evil.com',
    });
    const code = await new Promise<number>((r) => sock.on('unexpected-response', (_req, res) => r(res.statusCode ?? 0)));
    expect(code).toBe(403);
    await close();
  });

  it('accepts upgrade with valid cookie and matching Origin and sends init', async () => {
    const { port, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    const opened = new Promise<void>((r) => sock.on('open', () => r()));
    await opened;
    const msg = await once<Buffer>(sock as unknown as EventEmitter, 'message');
    expect(JSON.parse(msg.toString())).toEqual({ type: 'system', event: 'init' });
    sock.close();
    await close();
  });

  it('routes start → session_created broadcast and forwards correlationId', async () => {
    const { port, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message'); // init

    const messages: unknown[] = [];
    sock.on('message', (raw) => messages.push(JSON.parse(raw.toString())));

    sock.send(
      JSON.stringify({
        type: 'start',
        agent: 'claude',
        projectPath: '/Users/test/proj',
        correlationId: 'cid-router-1',
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    const created = messages.find(
      (m) =>
        (m as { type: string; event?: string }).type === 'system' &&
        (m as { event?: string }).event === 'session_created',
    ) as { correlationId?: string } | undefined;
    expect(created).toBeTruthy();
    // Browser auto-navigation depends on this echo. Asserting it here
    // pins the websocket router to forwarding correlationId into
    // SessionManager.create — without this assertion, the unit test
    // for SessionManager would still pass even if the wiring broke.
    expect(created?.correlationId).toBe('cid-router-1');
    sock.close();
    await close();
  });

  it('routes input → process.sendUserText', async () => {
    const { port, mgr, procs, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message'); // init

    const session = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    sock.send(JSON.stringify({ type: 'input', sessionId: session.sessionId, text: 'hello' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(procs[0]!.sendUserText).toHaveBeenCalledWith('hello');
    sock.close();
    await close();
  });

  it('replies session_list to list_sessions', async () => {
    const { port, mgr, close } = await startServer();
    await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });

    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message'); // init

    const got = new Promise<unknown>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'session_list') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'list_sessions', correlationId: 'c1' }));
    const msg = (await got) as { type: string; sessions: unknown[]; correlationId?: string };
    expect(msg.type).toBe('session_list');
    expect(msg.sessions).toHaveLength(1);
    expect(msg.correlationId).toBe('c1');
    sock.close();
    await close();
  });

  it('returns error for malformed JSON input', async () => {
    const { port, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message'); // init

    const got = new Promise<{ type: string; code?: string }>((r) => {
      sock.on('message', (raw) => r(JSON.parse(raw.toString())));
    });
    sock.send('not json');
    const m = await got;
    expect(m.type).toBe('error');
    expect(m.code).toBe('unsupported_message');
    sock.close();
    await close();
  });

  it('list_accounts replies with name + isDefault, hides codexHome', async () => {
    const accounts = new Map([
      ['default', { name: 'default', codexHome: '/secret/path', isDefault: true }],
      ['work', { name: 'work', codexHome: '/another/secret', isDefault: false }],
    ]);
    const { port, close } = await startServer({ accounts });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{ type: string; accounts: Array<{ name: string; agent: string; isDefault: boolean }>; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'account_list') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'list_accounts', correlationId: 'c' }));
    const msg = await got;
    expect(msg.accounts).toHaveLength(2);
    const first = msg.accounts.find((a) => a.name === 'default')!;
    expect(first.isDefault).toBe(true);
    expect((first as unknown as { codexHome?: string }).codexHome).toBeUndefined();
    expect(msg.correlationId).toBe('c');
    sock.close();
    await close();
  });

  it('start { agent: "codex", account: "<bogus>" } returns unknown_account', async () => {
    const accounts = new Map([
      ['default', { name: 'default', codexHome: '/Users/test/.codex', isDefault: true }],
    ]);
    const { port, close } = await startServer({ accounts });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{ type: string; code?: string; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'error') r(m);
      });
    });
    sock.send(
      JSON.stringify({
        type: 'start',
        agent: 'codex',
        projectPath: '/Users/test/proj',
        account: 'nope',
        correlationId: 'cid-bogus',
      }),
    );
    const msg = await got;
    expect(msg.code).toBe('unknown_account');
    expect(msg.correlationId).toBe('cid-bogus');
    sock.close();
    await close();
  });

  it('start with single account uses default and echoes account name on session_created', async () => {
    const accounts = new Map([
      ['default', { name: 'default', codexHome: '/Users/test/.codex', isDefault: true }],
    ]);
    const { port, close } = await startServer({ accounts });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{ type: string; event?: string; account?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'system' && m.event === 'session_created') r(m);
      });
    });
    sock.send(
      JSON.stringify({
        type: 'start',
        agent: 'codex',
        projectPath: '/Users/test/proj',
        correlationId: 'cid-default',
      }),
    );
    const msg = await got;
    expect(msg.account).toBe('default');
    sock.close();
    await close();
  });

  it('get_history for unknown session replies with session_dead error carrying sessionId', async () => {
    const { port, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{ type: string; code?: string; sessionId?: string; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'error') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'get_history', sessionId: 'dead-session-id', correlationId: 'cid-hist' }));
    const msg = await got;
    expect(msg.code).toBe('session_dead');
    expect(msg.sessionId).toBe('dead-session-id');
    expect(msg.correlationId).toBe('cid-hist');
    sock.close();
    await close();
  });

  it('list_prompts replies with prompts_result (placeholder empty)', async () => {
    const { port, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{ type: string; prompts: unknown[]; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'prompts_result') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'list_prompts', correlationId: 'c-prompts' }));
    const msg = await got;
    expect(msg.type).toBe('prompts_result');
    expect(msg.prompts).toHaveLength(0);
    expect(msg.correlationId).toBe('c-prompts');
    sock.close();
    await close();
  });
});
