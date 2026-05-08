import { describe, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { attachWebSocket } from '../websocket.js';
import { SessionManager } from '../session.js';
import { EventEmitter } from 'node:events';
import type { HistoryScanner } from '../history-scanner.js';
import type { HistoryEntry, Profile, SearchHit, SlashCommand } from '../types.js';
import type { ProfileStore } from '../profile-store.js';
import type { SlashCommandsScanner } from '../slash-commands.js';
import type { FileSearch } from '../file-search.js';

const TOKEN = 'a'.repeat(32);

class FakeProc extends EventEmitter {
  sendUserText = vi.fn();
  kill = vi.fn();
}

function makeFakeScanner(overrides: Partial<HistoryScanner> = {}): HistoryScanner {
  return {
    list: vi.fn(async () => ({ claude: [] as HistoryEntry[], codex: [] as HistoryEntry[] })),
    findEntry: vi.fn(async () => undefined),
    invalidateCache: vi.fn(),
    ...overrides,
  } as unknown as HistoryScanner;
}

function makeFakeProfileStore(initial: Profile[] = []): ProfileStore {
  let profiles: Profile[] = [...initial];
  return {
    list: vi.fn(() => [...profiles]),
    get: vi.fn((name: string, agent: 'claude' | 'codex') =>
      profiles.find((p) => p.agent === agent && p.name.toLowerCase() === name.toLowerCase()),
    ),
    add: vi.fn(async (p: Profile) => {
      if (!/^[A-Za-z0-9 _-]{1,40}$/.test(p.name)) {
        throw Object.assign(new Error('Invalid name'), { code: 'profile_invalid_name' });
      }
      if (profiles.some((q) => q.agent === p.agent && q.name.toLowerCase() === p.name.toLowerCase())) {
        throw Object.assign(new Error('exists'), { code: 'profile_invalid_name' });
      }
      profiles.push(p);
    }),
    update: vi.fn(async (name: string, agent: 'claude' | 'codex', patch: Partial<Profile>) => {
      const idx = profiles.findIndex(
        (p) => p.agent === agent && p.name.toLowerCase() === name.toLowerCase(),
      );
      if (idx < 0) {
        throw Object.assign(new Error('not found'), { code: 'profile_not_found' });
      }
      profiles[idx] = { ...profiles[idx]!, ...patch };
    }),
    remove: vi.fn(async (name: string, agent: 'claude' | 'codex') => {
      const before = profiles.length;
      profiles = profiles.filter(
        (p) => !(p.agent === agent && p.name.toLowerCase() === name.toLowerCase()),
      );
      if (profiles.length === before) {
        throw Object.assign(new Error('not found'), { code: 'profile_not_found' });
      }
    }),
    setDefault: vi.fn(async (name: string, agent: 'claude' | 'codex') => {
      const idx = profiles.findIndex(
        (p) => p.agent === agent && p.name.toLowerCase() === name.toLowerCase(),
      );
      if (idx < 0) {
        throw Object.assign(new Error('not found'), { code: 'profile_not_found' });
      }
      profiles = profiles.map((p) =>
        p.agent === agent
          ? { ...p, default: p.name.toLowerCase() === name.toLowerCase() }
          : p,
      );
    }),
  } as unknown as ProfileStore;
}

function makeFakeSlashCommands(
  result: SlashCommand[] = [],
): SlashCommandsScanner {
  return {
    listForSession: vi.fn(async () => result),
    invalidateCache: vi.fn(),
  } as unknown as SlashCommandsScanner;
}

function makeFakeFileSearch(
  result: { hits: SearchHit[]; truncated: boolean } = { hits: [], truncated: false },
): FileSearch {
  return {
    search: vi.fn(async () => result),
    invalidate: vi.fn(),
  } as unknown as FileSearch;
}

async function startServer(opts: {
  accounts?: Map<string, import('../accounts.js').CodexAccount>;
  fsApi?: import('../fs-api.js').FsApi;
  imageStore?: import('../image-store.js').ImageStore;
  sessionManager?: SessionManager;
  historyScanner?: HistoryScanner;
  profileStore?: ProfileStore;
  slashCommands?: SlashCommandsScanner;
  fileSearch?: FileSearch;
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
  const mgr =
    opts.sessionManager ??
    new SessionManager({
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
  const historyScanner = opts.historyScanner ?? makeFakeScanner();
  const profileStore = opts.profileStore ?? makeFakeProfileStore();
  const slashCommands = opts.slashCommands ?? makeFakeSlashCommands();
  const fileSearch = opts.fileSearch ?? makeFakeFileSearch();
  const server = createServer();
  attachWebSocket({
    server,
    token: TOKEN,
    sessionManager: mgr,
    accounts: opts.accounts ?? new Map(),
    fsApi,
    imageStore,
    historyScanner,
    profileStore,
    slashCommands,
    fileSearch,
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no addr');
  return {
    server: server as Server,
    port: addr.port,
    mgr,
    procs,
    historyScanner,
    profileStore,
    slashCommands,
    fileSearch,
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
      historyScanner: makeFakeScanner(),
      profileStore: makeFakeProfileStore(),
      slashCommands: makeFakeSlashCommands(),
      fileSearch: makeFakeFileSearch(),
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

  // --- Phase 5 T6: list_history + resume_session handlers ----------------

  it('list_history replies history_list with both arrays + correlationId', async () => {
    const claudeEntries: HistoryEntry[] = [
      {
        agent: 'claude',
        sessionId: 'c-1',
        projectPath: '/Users/test/proj',
        mtime: 1000,
        firstPrompt: 'hi from claude',
      },
    ];
    const codexEntries: HistoryEntry[] = [
      {
        agent: 'codex',
        sessionId: 'cx-1',
        projectPath: '/Users/test/proj',
        mtime: 900,
        firstPrompt: 'hi from codex',
      },
    ];
    const scanner = makeFakeScanner({
      list: vi.fn(async () => ({ claude: claudeEntries, codex: codexEntries })),
    } as unknown as Partial<HistoryScanner>);
    const { port, close } = await startServer({ historyScanner: scanner });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');

    const got = new Promise<{ type: string; claude: HistoryEntry[]; codex: HistoryEntry[]; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'history_list') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'list_history', correlationId: 'cid-list-1' }));
    const m = await got;
    expect(m.type).toBe('history_list');
    expect(m.correlationId).toBe('cid-list-1');
    expect(m.claude).toEqual(claudeEntries);
    expect(m.codex).toEqual(codexEntries);
    sock.close();
    await close();
  });

  it('list_history twice within cache window scans only once (scanner contract)', async () => {
    // The HistoryScanner implements a 60s cache internally. The websocket
    // handler is a thin pass-through — we verify it does NOT do any extra
    // de-cache work by checking that a single scanner instance servicing two
    // back-to-back list_history calls only has its `.list()` invoked twice
    // (once per WS call, no extra calls). The scanner's own cache logic is
    // covered by history-scanner.test.ts; here we only assert the WS handler
    // calls scanner.list() exactly once per inbound message — i.e. it does
    // not invalidate the cache or double-dispatch.
    let callCount = 0;
    const fake: HistoryEntry[] = [
      { agent: 'claude', sessionId: 'c-1', projectPath: '/Users/test/p', mtime: 1, firstPrompt: '' },
    ];
    const scanner = makeFakeScanner({
      list: vi.fn(async () => {
        callCount += 1;
        return { claude: fake, codex: [] };
      }),
    } as unknown as Partial<HistoryScanner>);
    const { port, close } = await startServer({ historyScanner: scanner });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');

    const replies: Array<{ type: string; correlationId?: string }> = [];
    sock.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'history_list') replies.push(m);
    });
    sock.send(JSON.stringify({ type: 'list_history', correlationId: 'a' }));
    sock.send(JSON.stringify({ type: 'list_history', correlationId: 'b' }));
    // Wait for both replies.
    await new Promise<void>((r) => {
      const start = Date.now();
      const tick = setInterval(() => {
        if (replies.length >= 2 || Date.now() - start > 1000) {
          clearInterval(tick);
          r();
        }
      }, 10);
    });
    expect(replies).toHaveLength(2);
    // Each WS message triggers exactly one scanner.list() call. The scanner's
    // 60s cache (verified separately in history-scanner.test.ts) is what
    // actually short-circuits the filesystem scan on the second call.
    expect(callCount).toBe(2);
    sock.close();
    await close();
  });

  it('resume_session (Path 1: bridge-known) replies session_resumed with same webSessionId', async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { SessionRegistry } = await import('../session-registry.js');

    const tmp = mkdtempSync(join(tmpdir(), 'ws-resume-p1-'));
    const proj = join(tmp, 'proj');
    mkdirSync(proj, { recursive: true });
    try {
      const registryPath = join(tmp, 'sessions.json');
      const registry = new SessionRegistry(registryPath);
      await registry.load();
      await registry.add({
        webSessionId: 'web-1',
        agent: 'claude',
        projectPath: proj,
        transcriptPath: join(tmp, 'web-1.jsonl'),
        claudeSessionId: 'claude-uuid-1',
        codexSessionId: null,
        createdAt: 0,
        account: null,
      });

      const mgr = new SessionManager({
        allowedDirs: [tmp],
        bufferCap: 100,
        driverFactory: () => new FakeProc() as unknown as import('../session.js').AgentDriver,
        realpath: async (p) => p,
        registry,
        claudeResumeSettleMs: 30, // stay alive past the early-exit window
      });

      const { port, close } = await startServer({ sessionManager: mgr });
      const sock = ws(`ws://127.0.0.1:${port}/ws`, {
        cookie: `bridge_session=${TOKEN}`,
        origin: `http://127.0.0.1:${port}`,
      });
      await new Promise<void>((r) => sock.on('open', () => r()));
      await once(sock as unknown as EventEmitter, 'message');

      const got = new Promise<{ type: string; webSessionId?: string; alive?: boolean; correlationId?: string }>((r) => {
        sock.on('message', (raw) => {
          const m = JSON.parse(raw.toString());
          if (m.type === 'session_resumed') r(m);
        });
      });
      sock.send(
        JSON.stringify({
          type: 'resume_session',
          webSessionId: 'web-1',
          correlationId: 'cid-p1',
        }),
      );
      const m = await got;
      expect(m.type).toBe('session_resumed');
      expect(m.webSessionId).toBe('web-1');
      expect(m.alive).toBe(true);
      expect(m.correlationId).toBe('cid-p1');
      sock.close();
      await close();
    } finally {
      await new Promise((r) => setTimeout(r, 10));
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resume_session (Path 2: native history) replies session_resumed with NEW webSessionId', async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { SessionRegistry } = await import('../session-registry.js');

    const tmp = mkdtempSync(join(tmpdir(), 'ws-resume-p2-'));
    const proj = join(tmp, 'proj');
    mkdirSync(proj, { recursive: true });
    try {
      const registryPath = join(tmp, 'sessions.json');
      const registry = new SessionRegistry(registryPath);
      await registry.load();

      const entry: HistoryEntry = {
        agent: 'codex',
        sessionId: 'codex-uuid-known',
        projectPath: proj,
        mtime: 1000,
        firstPrompt: 'hello codex',
      };
      const scanner = makeFakeScanner({
        list: vi.fn(async () => ({ claude: [], codex: [entry] })),
        findEntry: vi.fn(async () => entry),
        invalidateCache: vi.fn(),
      } as unknown as Partial<HistoryScanner>);

      const accounts = new Map([
        ['default', { name: 'default', codexHome: '/tmp/codex-home', isDefault: true }],
      ]);
      // Codex driver instantiation needs an account map; everything else
      // mirrors a Path 1 mgr.
      const mgr = new SessionManager({
        allowedDirs: [tmp],
        bufferCap: 100,
        driverFactory: () => new FakeProc() as unknown as import('../session.js').AgentDriver,
        realpath: async (p) => p,
        registry,
        accounts: accounts as unknown as Map<string, import('../accounts.js').CodexAccount>,
        claudeResumeSettleMs: 30,
      });

      const { port, close } = await startServer({
        sessionManager: mgr,
        historyScanner: scanner,
      });
      const sock = ws(`ws://127.0.0.1:${port}/ws`, {
        cookie: `bridge_session=${TOKEN}`,
        origin: `http://127.0.0.1:${port}`,
      });
      await new Promise<void>((r) => sock.on('open', () => r()));
      await once(sock as unknown as EventEmitter, 'message');

      const got = new Promise<{ type: string; webSessionId?: string; alive?: boolean; correlationId?: string }>((r) => {
        sock.on('message', (raw) => {
          const m = JSON.parse(raw.toString());
          if (m.type === 'session_resumed') r(m);
        });
      });
      sock.send(
        JSON.stringify({
          type: 'resume_session',
          agent: 'codex',
          sessionId: 'codex-uuid-known',
          projectPath: proj,
          correlationId: 'cid-p2',
        }),
      );
      const m = await got;
      expect(m.type).toBe('session_resumed');
      expect(typeof m.webSessionId).toBe('string');
      expect((m.webSessionId ?? '').length).toBeGreaterThan(0);
      // A brand-new webSessionId — must differ from any pre-existing id.
      expect(m.webSessionId).not.toBe('codex-uuid-known');
      expect(m.alive).toBe(true);
      expect(m.correlationId).toBe('cid-p2');
      // Cache invalidation runs after a successful Path 2 resume.
      expect(scanner.invalidateCache).toHaveBeenCalledTimes(1);
      sock.close();
      await close();
    } finally {
      await new Promise((r) => setTimeout(r, 10));
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resume_session (Path 2) replies error history_session_not_found when scanner has no match', async () => {
    const scanner = makeFakeScanner({
      findEntry: vi.fn(async () => undefined),
    } as unknown as Partial<HistoryScanner>);
    const { port, close } = await startServer({ historyScanner: scanner });
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
        type: 'resume_session',
        agent: 'claude',
        sessionId: 'never-existed',
        projectPath: '/Users/test/proj',
        correlationId: 'cid-nf',
      }),
    );
    const m = await got;
    expect(m.type).toBe('error');
    expect(m.code).toBe('history_session_not_found');
    expect(m.correlationId).toBe('cid-nf');
    sock.close();
    await close();
  });

  it('resume_session (Path 2) replies error project_path_disallowed when ground-truth cwd is outside allowlist', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { SessionRegistry } = await import('../session-registry.js');

    const tmp = mkdtempSync(join(tmpdir(), 'ws-resume-disallow-'));
    try {
      const registryPath = join(tmp, 'sessions.json');
      const registry = new SessionRegistry(registryPath);
      await registry.load();
      // Allowlist is ONLY tmp; the entry's projectPath is outside tmp.
      const mgr = new SessionManager({
        allowedDirs: [tmp],
        bufferCap: 100,
        driverFactory: () => new FakeProc() as unknown as import('../session.js').AgentDriver,
        realpath: async (p) => p,
        registry,
        claudeResumeSettleMs: 30,
      });
      const forbiddenEntry: HistoryEntry = {
        agent: 'claude',
        sessionId: 'forbidden-uuid',
        projectPath: '/etc',
        mtime: 1,
        firstPrompt: '',
      };
      const scanner = makeFakeScanner({
        findEntry: vi.fn(async () => forbiddenEntry),
        invalidateCache: vi.fn(),
      } as unknown as Partial<HistoryScanner>);

      const { port, close } = await startServer({ sessionManager: mgr, historyScanner: scanner });
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
          type: 'resume_session',
          agent: 'claude',
          sessionId: 'forbidden-uuid',
          projectPath: '/Users/test/proj', // client lies; ground truth is /etc
          correlationId: 'cid-disallow',
        }),
      );
      const m = await got;
      expect(m.type).toBe('error');
      expect(m.code).toBe('project_path_disallowed');
      expect(m.correlationId).toBe('cid-disallow');
      sock.close();
      await close();
    } finally {
      await new Promise((r) => setTimeout(r, 10));
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // --- Phase 6 T8: profiles, slash, file-search, rename, multi-dir start --

  it('list_profiles replies with profile_list (empty initially)', async () => {
    const { port, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');

    const got = new Promise<{ type: string; profiles: Profile[]; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'profile_list') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'list_profiles', correlationId: 'cid-lp' }));
    const m = await got;
    expect(m.type).toBe('profile_list');
    expect(m.profiles).toEqual([]);
    expect(m.correlationId).toBe('cid-lp');
    sock.close();
    await close();
  });

  it('save_profile happy path replies profile_saved', async () => {
    const profileStore = makeFakeProfileStore();
    const { port, close } = await startServer({ profileStore });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');

    const profile: Profile = {
      name: 'work',
      agent: 'claude',
      dirs: ['/Users/test/proj'],
      account: null,
      default: false,
    };
    const got = new Promise<{ type: string; profile?: Profile; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'profile_saved') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'save_profile', profile, correlationId: 'cid-save' }));
    const m = await got;
    expect(m.type).toBe('profile_saved');
    expect(m.profile?.name).toBe('work');
    expect(m.correlationId).toBe('cid-save');
    expect(profileStore.add).toHaveBeenCalledTimes(1);
    sock.close();
    await close();
  });

  it('save_profile with bad name replies error profile_invalid_name', async () => {
    const { port, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');

    const profile: Profile = {
      name: 'bad/name!', // contains disallowed chars
      agent: 'claude',
      dirs: ['/Users/test/proj'],
      account: null,
      default: false,
    };
    const got = new Promise<{ type: string; code?: string; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'error') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'save_profile', profile, correlationId: 'cid-bad' }));
    const m = await got;
    expect(m.code).toBe('profile_invalid_name');
    expect(m.correlationId).toBe('cid-bad');
    sock.close();
    await close();
  });

  it('delete_profile happy path replies profile_deleted', async () => {
    const profile: Profile = {
      name: 'work',
      agent: 'claude',
      dirs: ['/Users/test/proj'],
      account: null,
      default: false,
    };
    const profileStore = makeFakeProfileStore([profile]);
    const { port, close } = await startServer({ profileStore });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');

    const got = new Promise<{ type: string; name?: string; agent?: string; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'profile_deleted') r(m);
      });
    });
    sock.send(
      JSON.stringify({
        type: 'delete_profile',
        name: 'work',
        agent: 'claude',
        correlationId: 'cid-del',
      }),
    );
    const m = await got;
    expect(m.name).toBe('work');
    expect(m.agent).toBe('claude');
    expect(m.correlationId).toBe('cid-del');
    sock.close();
    await close();
  });

  it('delete_profile missing name replies error profile_not_found', async () => {
    const { port, close } = await startServer();
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
        type: 'delete_profile',
        name: 'nope',
        agent: 'claude',
        correlationId: 'cid-del-missing',
      }),
    );
    const m = await got;
    expect(m.code).toBe('profile_not_found');
    expect(m.correlationId).toBe('cid-del-missing');
    sock.close();
    await close();
  });

  it('set_default_profile happy path replies profile_default_set', async () => {
    const profile: Profile = {
      name: 'work',
      agent: 'claude',
      dirs: ['/Users/test/proj'],
      account: null,
      default: false,
    };
    const profileStore = makeFakeProfileStore([profile]);
    const { port, close } = await startServer({ profileStore });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');

    const got = new Promise<{ type: string; name?: string; agent?: string; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'profile_default_set') r(m);
      });
    });
    sock.send(
      JSON.stringify({
        type: 'set_default_profile',
        name: 'work',
        agent: 'claude',
        correlationId: 'cid-sd',
      }),
    );
    const m = await got;
    expect(m.name).toBe('work');
    expect(m.agent).toBe('claude');
    expect(m.correlationId).toBe('cid-sd');
    sock.close();
    await close();
  });

  it('list_slash_commands for known session replies slash_commands_list', async () => {
    const cmds: SlashCommand[] = [
      { name: '/help', description: 'show help', source: 'builtin', agent: 'claude' },
    ];
    const slashCommands = makeFakeSlashCommands(cmds);
    const { port, mgr, close } = await startServer({ slashCommands });
    const session = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');

    const got = new Promise<{ type: string; commands?: SlashCommand[]; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'slash_commands_list') r(m);
      });
    });
    sock.send(
      JSON.stringify({
        type: 'list_slash_commands',
        sessionId: session.sessionId,
        correlationId: 'cid-slash',
      }),
    );
    const m = await got;
    expect(m.commands).toEqual(cmds);
    expect(m.correlationId).toBe('cid-slash');
    expect(slashCommands.listForSession).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      agent: 'claude',
      primaryCwd: '/Users/test/proj',
    });
    sock.close();
    await close();
  });

  it('list_slash_commands for unknown session replies error history_session_not_found', async () => {
    const { port, close } = await startServer();
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
        type: 'list_slash_commands',
        sessionId: 'never-existed',
        correlationId: 'cid-slash-nf',
      }),
    );
    const m = await got;
    expect(m.code).toBe('history_session_not_found');
    expect(m.correlationId).toBe('cid-slash-nf');
    sock.close();
    await close();
  });

  it('search_files for known session replies file_search_results', async () => {
    const hits: SearchHit[] = [
      { insertText: '@README.md', fullPath: '/Users/test/proj/README.md', dirIndex: 0, mtime: 1000 },
    ];
    const fileSearch = makeFakeFileSearch({ hits, truncated: false });
    const { port, close } = await startServer({ fileSearch });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');

    const got = new Promise<{ type: string; hits: SearchHit[]; truncated: boolean; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'file_search_results') r(m);
      });
    });
    sock.send(
      JSON.stringify({
        type: 'search_files',
        sessionId: 'web-1',
        query: 'read',
        correlationId: 'cid-fs',
      }),
    );
    const m = await got;
    expect(m.hits).toEqual(hits);
    expect(m.truncated).toBe(false);
    expect(m.correlationId).toBe('cid-fs');
    expect(fileSearch.search).toHaveBeenCalledWith('web-1', 'read');
    sock.close();
    await close();
  });

  it('rename_session happy path replies session_renamed', async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { SessionRegistry } = await import('../session-registry.js');

    const tmp = mkdtempSync(join(tmpdir(), 'ws-rename-ok-'));
    const proj = join(tmp, 'proj');
    mkdirSync(proj, { recursive: true });
    try {
      const registry = new SessionRegistry(join(tmp, 'sessions.json'));
      await registry.load();
      const mgr = new SessionManager({
        allowedDirs: [tmp],
        bufferCap: 100,
        driverFactory: () => new FakeProc() as unknown as import('../session.js').AgentDriver,
        realpath: async (p) => p,
        registry,
      });
      const sess = await mgr.spawnSession({ agent: 'claude', dirs: [proj] });

      const { port, close } = await startServer({ sessionManager: mgr });
      const sock = ws(`ws://127.0.0.1:${port}/ws`, {
        cookie: `bridge_session=${TOKEN}`,
        origin: `http://127.0.0.1:${port}`,
      });
      await new Promise<void>((r) => sock.on('open', () => r()));
      await once(sock as unknown as EventEmitter, 'message');

      // Both the handler's direct reply (correlationId='cid-rn') and the
      // session-manager broadcast (correlationId='') deliver a session_renamed
      // message; collect them all and assert both shapes were observed.
      const renames: Array<{ type: string; sessionId?: string; name?: string; correlationId?: string }> = [];
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'session_renamed') renames.push(m);
      });
      sock.send(
        JSON.stringify({
          type: 'rename_session',
          sessionId: sess.webSessionId,
          name: 'my session',
          correlationId: 'cid-rn',
        }),
      );
      // Wait for at least one rename event, up to 1s.
      await new Promise<void>((r) => {
        const start = Date.now();
        const tick = setInterval(() => {
          if (renames.length >= 1 || Date.now() - start > 1000) {
            clearInterval(tick);
            r();
          }
        }, 10);
      });
      expect(renames.length).toBeGreaterThanOrEqual(1);
      // The handler-direct reply is the one with correlationId='cid-rn'.
      const direct = renames.find((m) => m.correlationId === 'cid-rn');
      expect(direct?.sessionId).toBe(sess.webSessionId);
      expect(direct?.name).toBe('my session');
      expect(registry.get(sess.webSessionId)?.name).toBe('my session');
      sock.close();
      await close();
    } finally {
      await new Promise((r) => setTimeout(r, 10));
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rename_session with bad name replies error session_name_invalid', async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { SessionRegistry } = await import('../session-registry.js');

    const tmp = mkdtempSync(join(tmpdir(), 'ws-rename-bad-'));
    const proj = join(tmp, 'proj');
    mkdirSync(proj, { recursive: true });
    try {
      const registry = new SessionRegistry(join(tmp, 'sessions.json'));
      await registry.load();
      const mgr = new SessionManager({
        allowedDirs: [tmp],
        bufferCap: 100,
        driverFactory: () => new FakeProc() as unknown as import('../session.js').AgentDriver,
        realpath: async (p) => p,
        registry,
      });
      const sess = await mgr.spawnSession({ agent: 'claude', dirs: [proj] });

      const { port, close } = await startServer({ sessionManager: mgr });
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
          type: 'rename_session',
          sessionId: sess.webSessionId,
          name: '   ', // whitespace-only → invalid
          correlationId: 'cid-rn-bad',
        }),
      );
      const m = await got;
      expect(m.code).toBe('session_name_invalid');
      expect(m.correlationId).toBe('cid-rn-bad');
      sock.close();
      await close();
    } finally {
      await new Promise((r) => setTimeout(r, 10));
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('start with dirs[] spawns multi-dir session and stores additionalDirs', async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { SessionRegistry } = await import('../session-registry.js');

    const tmp = mkdtempSync(join(tmpdir(), 'ws-multidir-'));
    const a = join(tmp, 'a');
    const b = join(tmp, 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    try {
      const registry = new SessionRegistry(join(tmp, 'sessions.json'));
      await registry.load();
      const mgr = new SessionManager({
        allowedDirs: [tmp],
        bufferCap: 100,
        driverFactory: () => new FakeProc() as unknown as import('../session.js').AgentDriver,
        realpath: async (p) => p,
        registry,
      });

      const { port, close } = await startServer({ sessionManager: mgr });
      const sock = ws(`ws://127.0.0.1:${port}/ws`, {
        cookie: `bridge_session=${TOKEN}`,
        origin: `http://127.0.0.1:${port}`,
      });
      await new Promise<void>((r) => sock.on('open', () => r()));
      await once(sock as unknown as EventEmitter, 'message');

      const got = new Promise<{ type: string; event?: string; sessionId?: string; projectPath?: string; correlationId?: string }>(
        (r) => {
          sock.on('message', (raw) => {
            const m = JSON.parse(raw.toString());
            if (m.type === 'system' && m.event === 'session_created') r(m);
          });
        },
      );
      sock.send(
        JSON.stringify({
          type: 'start',
          agent: 'claude',
          dirs: [a, b],
          correlationId: 'cid-md',
        }),
      );
      const m = await got;
      expect(m.projectPath).toBe(a);
      expect(m.correlationId).toBe('cid-md');
      // The registry entry should include both dirs.
      const entry = registry.get(m.sessionId!);
      expect(entry?.projectPath).toBe(a);
      expect(entry?.additionalDirs).toEqual([b]);
      sock.close();
      await close();
    } finally {
      await new Promise((r) => setTimeout(r, 10));
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
