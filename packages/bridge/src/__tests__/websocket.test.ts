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
  fsApi?: import('../fs-api.js').FsApi;
  imageStore?: import('../image-store.js').ImageStore;
} = {}) {
  const procs: FakeProc[] = [];
  const fsApi =
    opts.fsApi ??
    ({
      listDirs: async () => [],
      readFile: async () => ({ kind: 'text' as const, content: '', bytesRead: 0, truncated: false }),
    } as unknown as import('../fs-api.js').FsApi);
  const imageStore =
    opts.imageStore ??
    ({
      validate: () => ({ ok: true as const }),
      writeAuditCopy: async () => {},
      cleanup: async () => {},
    } as unknown as import('../image-store.js').ImageStore);
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
    imageStore,
  });
  const server = createServer();
  attachWebSocket({ server, token: TOKEN, sessionManager: mgr, accounts: opts.accounts ?? new Map(), fsApi, imageStore });

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

    expect(procs[0]!.sendUserText).toHaveBeenCalledWith('hello', undefined);
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

  it('list_prompts replies with the PromptStore contents', async () => {
    // Spin up a manager with a fake promptStore that returns 1 entry.
    const fakePromptStore = {
      add: () => {},
      list: () => [
        { hash: 'h', text: 'hi', lastUsedAt: 100, projectPaths: ['/p'], agents: ['claude'] as const },
      ],
    } as unknown as import('../prompt-store.js').PromptStore;
    const mgr = new SessionManager({
      allowedDirs: ['/Users/test'],
      bufferCap: 100,
      driverFactory: () => new FakeProc() as unknown as import('../session.js').AgentDriver,
      realpath: async (p) => p,
      promptStore: fakePromptStore,
    });
    const server = createServer();
    const fakeFsApi = {
      listDirs: async () => [],
      readFile: async () => ({ kind: 'text' as const, content: '', bytesRead: 0, truncated: false }),
    } as unknown as import('../fs-api.js').FsApi;
    const fakeImageStore = {
      validate: () => ({ ok: true as const }),
      writeAuditCopy: async () => {},
      cleanup: async () => {},
    } as unknown as import('../image-store.js').ImageStore;
    attachWebSocket({
      server,
      token: TOKEN,
      sessionManager: mgr,
      accounts: new Map(),
      promptStore: fakePromptStore,
      fsApi: fakeFsApi,
      imageStore: fakeImageStore,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');

    const sock = ws(`ws://127.0.0.1:${addr.port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${addr.port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{ type: string; prompts: Array<{ text: string }> }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'prompts_result') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'list_prompts', limit: 5 }));
    const msg = await got;
    expect(msg.prompts).toHaveLength(1);
    expect(msg.prompts[0]!.text).toBe('hi');
    sock.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('list_dirs replies with dirs_result on a happy path', async () => {
    const fakeFsApi = {
      listDirs: async (_path: string) => [
        { name: 'src', kind: 'dir' as const },
        { name: 'README.md', kind: 'file' as const, size: 42 },
      ],
      readFile: async () => ({ kind: 'text' as const, content: '', bytesRead: 0, truncated: false }),
    };
    const { port, close } = await startServer({ fsApi: fakeFsApi });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{ type: string; entries: unknown[]; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'dirs_result') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'list_dirs', path: '/Users/test/proj', correlationId: 'cd' }));
    const msg = await got;
    expect(msg.entries).toHaveLength(2);
    expect(msg.correlationId).toBe('cd');
    sock.close();
    await close();
  });

  it('list_dirs propagates path_outside_allowlist errors with correlationId', async () => {
    const fakeFsApi = {
      listDirs: async () => {
        const e = new Error('outside') as Error & { code?: string };
        e.code = 'path_outside_allowlist';
        throw e;
      },
      readFile: async () => ({ kind: 'text' as const, content: '', bytesRead: 0, truncated: false }),
    };
    const { port, close } = await startServer({ fsApi: fakeFsApi });
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
    sock.send(JSON.stringify({ type: 'list_dirs', path: '/etc', correlationId: 'cx' }));
    const m = await got;
    expect(m.code).toBe('path_outside_allowlist');
    expect(m.correlationId).toBe('cx');
    sock.close();
    await close();
  });

  it('read_file replies with file_result of the right kind', async () => {
    const fakeFsApi = {
      listDirs: async () => [],
      readFile: async (_path: string, _cap: number) => ({
        kind: 'text' as const,
        content: 'hello',
        bytesRead: 5,
        truncated: false,
      }),
    };
    const { port, close } = await startServer({ fsApi: fakeFsApi });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{ type: string; kind?: string; content?: string; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'file_result') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'read_file', path: '/Users/test/proj/README.md', correlationId: 'cf' }));
    const m = await got;
    expect(m.kind).toBe('text');
    expect(m.content).toBe('hello');
    expect(m.correlationId).toBe('cf');
    sock.close();
    await close();
  });

  it('input with codex session and images replies images_not_supported_for_agent', async () => {
    const fakeImageStore = {
      validate: (_imgs: unknown, agent: string) =>
        agent === 'codex'
          ? { ok: false, error: 'images_not_supported_for_agent' as const }
          : { ok: true as const },
      writeAuditCopy: async () => {},
      cleanup: async () => {},
    };
    const accounts = new Map([
      ['default', { name: 'default', codexHome: '/Users/test/.codex', isDefault: true }],
    ]);
    const { port, mgr, close } = await startServer({ accounts, imageStore: fakeImageStore });
    const session = await mgr.create({ agent: 'codex', projectPath: '/Users/test/proj' });
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
    sock.send(
      JSON.stringify({
        type: 'input',
        sessionId: session.sessionId,
        text: 'hi',
        images: [{ mime: 'image/png', base64: 'AAA=' }],
        correlationId: 'ci',
      }),
    );
    const m = await got;
    expect(m.code).toBe('images_not_supported_for_agent');
    expect(m.sessionId).toBe(session.sessionId);
    expect(m.correlationId).toBe('ci');
    sock.close();
    await close();
  });
});
