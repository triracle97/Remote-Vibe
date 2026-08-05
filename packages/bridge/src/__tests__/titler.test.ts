import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionTitler, sanitizeTitle, titlerConfigFromEnv } from '../titler.js';
import { SessionRegistry, type RegistryEntry } from '../session-registry.js';
import { SessionManager, type AgentDriver } from '../session.js';
import type { AgentEvent, ServerMsg } from '../types.js';

/** Fake `claude -p` process: captures stdin, emits stdout, then exits. */
function makeFakeChild(stdout: string, exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stdin: Writable;
    kill: (s: NodeJS.Signals) => boolean;
    pid: number;
  };
  const written: string[] = [];
  child.stdout = new Readable({ read() {} });
  child.stdin = new Writable({
    write(chunk, _e, cb) {
      written.push(chunk.toString());
      cb();
    },
  });
  child.kill = vi.fn().mockReturnValue(true);
  child.pid = 5555;
  // Deliver output once the caller has attached listeners.
  setTimeout(() => {
    child.stdout.push(stdout);
    child.stdout.push(null);
    child.emit('exit', exitCode);
  }, 0);
  return { child, written };
}

const REQ = {
  firstPrompt: 'fix the auth token expiry check, it uses < not <=',
  firstReply: 'Bug in auth middleware. Token expiry check use `<` not `<=`. Fixed.',
  projectPath: '/proj',
};

describe('sanitizeTitle', () => {
  it('takes a plain title as-is', () => {
    expect(sanitizeTitle('fix auth token expiry')).toBe('fix auth token expiry');
  });

  it('strips surrounding quotes', () => {
    expect(sanitizeTitle('"fix auth token expiry"')).toBe('fix auth token expiry');
    expect(sanitizeTitle('“fix auth token expiry”')).toBe('fix auth token expiry');
  });

  it('strips a Title: prefix', () => {
    expect(sanitizeTitle('Title: fix auth expiry')).toBe('fix auth expiry');
    expect(sanitizeTitle('Session - fix auth expiry')).toBe('fix auth expiry');
  });

  it('takes the first line when the model adds commentary', () => {
    expect(sanitizeTitle('fix auth expiry\n\nThis captures the bug.')).toBe('fix auth expiry');
  });

  it('drops trailing punctuation and collapses whitespace', () => {
    expect(sanitizeTitle('  fix   auth   expiry.  ')).toBe('fix auth expiry');
  });

  it('caps at 60 characters', () => {
    expect(sanitizeTitle('x'.repeat(200))).toHaveLength(60);
  });

  it('rejects empty or whitespace-only output', () => {
    expect(sanitizeTitle('')).toBeNull();
    expect(sanitizeTitle('   \n  ')).toBeNull();
    expect(sanitizeTitle('""')).toBeNull();
  });

  it('rejects a paragraph — the model ignored the instruction', () => {
    expect(sanitizeTitle('word '.repeat(60))).toBeNull();
  });

  it('rejects control characters', () => {
    expect(sanitizeTitle('fixauth')).toBeNull();
  });
});

describe('titlerConfigFromEnv', () => {
  it('defaults to enabled on Haiku', () => {
    expect(titlerConfigFromEnv({})).toEqual({ enabled: true, model: 'claude-haiku-4-5' });
  });

  it('accepts the usual falsy spellings', () => {
    for (const v of ['false', '0', 'no', 'off']) {
      expect(titlerConfigFromEnv({ BRIDGE_TITLER_ENABLED: v }).enabled).toBe(false);
    }
  });

  it('honours a model override', () => {
    expect(titlerConfigFromEnv({ BRIDGE_TITLER_MODEL: 'claude-sonnet-5' }).model).toBe(
      'claude-sonnet-5',
    );
  });

  it('rejects a model string that would need shell quoting', () => {
    expect(() => titlerConfigFromEnv({ BRIDGE_TITLER_MODEL: 'foo; rm -rf /' })).toThrow(
      /unsupported characters/,
    );
  });
});

describe('SessionTitler', () => {
  it('returns the model output as the title', async () => {
    const { child } = makeFakeChild('fix auth token expiry\n');
    const titler = new SessionTitler({
      enabled: true,
      model: 'claude-haiku-4-5',
      spawn: vi.fn().mockReturnValue(child) as never,
    });
    expect(await titler.title(REQ)).toBe('fix auth token expiry');
  });

  it('sends prompt and reply on stdin, not argv', async () => {
    const { child, written } = makeFakeChild('a title\n');
    const spawn = vi.fn().mockReturnValue(child);
    const titler = new SessionTitler({
      enabled: true,
      model: 'claude-haiku-4-5',
      spawn: spawn as never,
    });
    await titler.title(REQ);
    const sent = written.join('');
    expect(sent).toContain('fix the auth token expiry check');
    expect(sent).toContain('Bug in auth middleware');
    // The prompt must not ride on the command line — it contains user text.
    expect(spawn.mock.calls[0]![1].join(' ')).not.toContain('auth token');
  });

  it('runs the requested model', async () => {
    const { child } = makeFakeChild('a title\n');
    const spawn = vi.fn().mockReturnValue(child);
    await new SessionTitler({
      enabled: true,
      model: 'claude-haiku-4-5',
      spawn: spawn as never,
    }).title(REQ);
    expect(spawn.mock.calls[0]![1].join(' ')).toContain('claude -p --model claude-haiku-4-5');
  });

  it('runs under the session config dir so auth matches', async () => {
    const { child } = makeFakeChild('a title\n');
    const spawn = vi.fn().mockReturnValue(child);
    await new SessionTitler({
      enabled: true,
      model: 'claude-haiku-4-5',
      spawn: spawn as never,
    }).title({ ...REQ, claudeConfigDir: '/Users/test/.claude1' });
    const opts = spawn.mock.calls[0]![2] as { env: Record<string, string>; cwd: string };
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe('/Users/test/.claude1');
    expect(opts.cwd).toBe('/proj');
  });

  it('returns null when disabled, without spawning', async () => {
    const spawn = vi.fn();
    const titler = new SessionTitler({
      enabled: false,
      model: 'claude-haiku-4-5',
      spawn: spawn as never,
    });
    expect(await titler.title(REQ)).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns null on a non-zero exit rather than throwing', async () => {
    const { child } = makeFakeChild('', 1);
    const titler = new SessionTitler({
      enabled: true,
      model: 'claude-haiku-4-5',
      spawn: vi.fn().mockReturnValue(child) as never,
    });
    expect(await titler.title(REQ)).toBeNull();
  });

  it('returns null when the binary is missing', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: Readable; stdin: Writable };
    child.stdout = new Readable({ read() {} });
    child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    setTimeout(() => child.emit('error', new Error('ENOENT')), 0);
    const titler = new SessionTitler({
      enabled: true,
      model: 'claude-haiku-4-5',
      spawn: vi.fn().mockReturnValue(child) as never,
    });
    expect(await titler.title(REQ)).toBeNull();
  });

  it('gives up on a hung titler instead of hanging the session', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stdin: Writable;
      pid: number;
    };
    child.stdout = new Readable({ read() {} });
    child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    child.pid = 4242;
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const titler = new SessionTitler({
        enabled: true,
        model: 'claude-haiku-4-5',
        spawn: vi.fn().mockReturnValue(child) as never,
        timeoutMs: 5,
      });
      expect(await titler.title(REQ)).toBeNull();
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    } finally {
      kill.mockRestore();
    }
  });

  it('skips an empty prompt', async () => {
    const spawn = vi.fn();
    const titler = new SessionTitler({
      enabled: true,
      model: 'claude-haiku-4-5',
      spawn: spawn as never,
    });
    expect(await titler.title({ ...REQ, firstPrompt: '   ' })).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });
});

// --- integration with SessionManager -----------------------------------

class FakeDriver extends EventEmitter implements AgentDriver {
  sendUserText(): void {}
  kill(): void {
    this.emit('exit', 0);
  }
}

function flush(ms = 20): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Poll until `cond` holds. The titler broadcast lands only after the registry
 * write is fsync'd, so a fixed sleep is racy under parallel test load.
 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await flush(5);
  }
  throw new Error('waitFor timed out');
}

describe('SessionManager agent naming', () => {
  let dir: string;
  let registry: SessionRegistry;
  let mgr: SessionManager;
  let driver: FakeDriver;
  let broadcasts: ServerMsg[];
  let titleCalls: Array<{ firstPrompt: string; firstReply: string }>;
  let titleResult: string | null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mrt-titler-'));
    registry = new SessionRegistry(join(dir, 'sessions.json'));
    await registry.load();
    titleCalls = [];
    titleResult = 'fix auth token expiry';
    driver = new FakeDriver();

    const titler = {
      enabled: true,
      title: async (req: { firstPrompt: string; firstReply: string }) => {
        titleCalls.push(req);
        return titleResult;
      },
    } as unknown as SessionTitler;

    mgr = new SessionManager({
      allowedDirs: [dir],
      bufferCap: 100,
      registry,
      titler,
      realpath: async (p) => p,
      driverFactory: () => driver,
    });
    // Bind the array by value: registry writes are async and can land after
    // the test ends, and a listener closing over the `broadcasts` *variable*
    // would push a stale message into the next test's array.
    const sink: ServerMsg[] = [];
    broadcasts = sink;
    mgr.on('broadcast', (m: ServerMsg) => sink.push(m));
  });
  afterEach(async () => {
    // A write can still be draining; ENOTEMPTY here is noise.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const emit = (e: AgentEvent): void => {
    driver.emit('event', e);
  };

  it('names the session from the first turn once it completes', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await mgr.handleInput(info.sessionId, 'the auth check is wrong');
    // Provisional name from the prompt while the turn runs.
    expect(registry.get(info.sessionId)!.name).toBe('the auth check is wrong');

    emit({ kind: 'assistant_text', text: 'Bug in auth middleware.' });
    emit({ kind: 'result', cost: 0.01 });
    // Match the title, not just the event type — the provisional auto-name
    // from handleInput broadcasts `session_renamed` too.
    await waitFor(() =>
      broadcasts.some(
        (m) => m.type === 'session_renamed' && m.name === 'fix auth token expiry',
      ),
    );

    expect(titleCalls).toHaveLength(1);
    expect(titleCalls[0]!.firstPrompt).toBe('the auth check is wrong');
    expect(titleCalls[0]!.firstReply).toContain('Bug in auth middleware');
    expect(registry.get(info.sessionId)!.name).toBe('fix auth token expiry');
    expect(broadcasts).toContainEqual({
      type: 'session_renamed',
      sessionId: info.sessionId,
      name: 'fix auth token expiry',
      correlationId: '',
    });
  });

  it('keeps the prompt-derived name when titling fails', async () => {
    titleResult = null;
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await mgr.handleInput(info.sessionId, 'the auth check is wrong');
    emit({ kind: 'result' });
    await waitFor(() => titleCalls.length === 1);
    await flush(50);
    expect(registry.get(info.sessionId)!.name).toBe('the auth check is wrong');
  });

  it('titles only once, not on every turn', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await mgr.handleInput(info.sessionId, 'first ask');
    emit({ kind: 'result' });
    await waitFor(() => titleCalls.length === 1);
    await mgr.handleInput(info.sessionId, 'second ask');
    emit({ kind: 'result' });
    await flush(50);
    expect(titleCalls).toHaveLength(1);
  });

  it('does not title a session the user already renamed', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await mgr.renameSession(info.sessionId, 'my own name');
    await mgr.handleInput(info.sessionId, 'do a thing');
    emit({ kind: 'result' });
    await flush();
    expect(titleCalls).toHaveLength(0);
    expect(registry.get(info.sessionId)!.name).toBe('my own name');
  });

  it('lets a rename mid-turn win over the title that lands after it', async () => {
    let release: (v: string | null) => void = () => {};
    const slow = {
      enabled: true,
      title: () =>
        new Promise<string | null>((res) => {
          release = res;
        }),
    } as unknown as SessionTitler;
    const m = new SessionManager({
      allowedDirs: [dir],
      bufferCap: 100,
      registry,
      titler: slow,
      realpath: async (p) => p,
      driverFactory: () => driver,
    });
    const info = await m.spawnSession({ agent: 'claude', dirs: [dir] });
    await m.handleInput(info.sessionId, 'do a thing');
    emit({ kind: 'result' });
    await flush();

    // User renames while the titler is still running.
    await m.renameSession(info.sessionId, 'user chose this');
    release('agent chose this');
    await flush(100);

    expect(registry.get(info.sessionId)!.name).toBe('user chose this');
    expect(registry.get(info.sessionId)!.namePinned).toBe(true);
  });

  it('pins the name on a manual rename', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    expect(registry.get(info.sessionId)!.namePinned).toBe(false);
    await mgr.renameSession(info.sessionId, 'pinned name');
    expect(registry.get(info.sessionId)!.namePinned).toBe(true);
  });

  it('does not title a session that died before its first turn ended', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await mgr.handleInput(info.sessionId, 'do a thing');
    driver.emit('exit', 1);
    await flush();
    emit({ kind: 'result' });
    await flush();
    expect(titleCalls).toHaveLength(0);
  });

  it('exposes namePinned on board cards', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await mgr.renameSession(info.sessionId, 'mine');
    const card = mgr.listBoardSessions().find((s) => s.sessionId === info.sessionId)!;
    expect(card.namePinned).toBe(true);
    expect(card.name).toBe('mine');
  });
});

describe('SessionRegistry namePinned migration', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mrt-titler-mig-'));
  });
  afterEach(async () => {
    // A write can still be draining; ENOTEMPTY here is noise.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('treats a pre-existing name as pinned rather than re-titling it', async () => {
    const path = join(dir, 'sessions.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path,
      JSON.stringify({
        sessions: {
          named: baseEntry({ webSessionId: 'named', name: 'a name from before' }),
          anon: baseEntry({ webSessionId: 'anon', name: null }),
        },
      }),
    );
    const reg = new SessionRegistry(path);
    await reg.load();
    expect(reg.get('named')!.namePinned).toBe(true);
    expect(reg.get('anon')!.namePinned).toBe(false);
  });
});

function baseEntry(over: Partial<RegistryEntry>): Record<string, unknown> {
  return {
    webSessionId: 'x',
    agent: 'claude',
    projectPath: '/p',
    transcriptPath: '/t.jsonl',
    claudeSessionId: null,
    codexSessionId: null,
    createdAt: 1,
    account: null,
    name: null,
    additionalDirs: [],
    ...over,
  };
}
