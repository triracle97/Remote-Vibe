import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../session.js';
import type { AgentDriver, DriverFactoryArgs } from '../session.js';
import { SessionRegistry } from '../session-registry.js';
import type { AgentEvent, ServerLifecycleMsg, ServerStreamMsg } from '../types.js';

class FakeProc extends EventEmitter {
  killed = false;
  sentText: string[] = [];
  sentImages: Array<ReadonlyArray<{ mime: string; base64: string }> | undefined> = [];
  sendUserText(s: string, images?: ReadonlyArray<{ mime: string; base64: string }>) {
    this.sentText.push(s);
    this.sentImages.push(images);
  }
  kill() { this.killed = true; this.emit('exit', 0); }
  emitEvent(e: AgentEvent) { this.emit('event', e); }
}

function makeManager(opts: { allowedDirs?: string[] } = {}) {
  const procs: FakeProc[] = [];
  const factory = (_path: string) => {
    const p = new FakeProc();
    procs.push(p);
    return p as unknown as import('../claude-process.js').ClaudeProcess;
  };
  const mgr = new SessionManager({
    allowedDirs: opts.allowedDirs ?? ['/Users/test'],
    bufferCap: 100,
    spawnClaude: factory,
    realpath: async (p) => p,
  });
  return { mgr, procs };
}

describe('SessionManager', () => {
  it('rejects projectPath outside allowedDirs', async () => {
    const { mgr } = makeManager({ allowedDirs: ['/Users/alice'] });
    await expect(mgr.create({ agent: 'claude', projectPath: '/etc' })).rejects.toMatchObject({
      code: 'path_outside_allowlist',
    });
  });

  it('creates a session inside an allowed dir and emits session_created', async () => {
    const { mgr } = makeManager();
    const events: unknown[] = [];
    mgr.on('broadcast', (m) => events.push(m));
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });

    expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(events.length).toBe(1);
    const m = events[0] as ServerLifecycleMsg;
    expect(m.type).toBe('system');
    expect(m.event).toBe('session_created');
    expect(m.sessionId).toBe(s.sessionId);
    expect(m.seq).toBe(1);
    expect(m.agent).toBe('claude');
    expect(m.projectPath).toBe('/Users/test/proj');
    expect(typeof m.createdAt).toBe('number');
  });

  it('echoes correlationId on session_created when create is called with one', async () => {
    const { mgr } = makeManager();
    const events: unknown[] = [];
    mgr.on('broadcast', (m) => events.push(m));
    await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj', correlationId: 'cid-42' });
    const created = events.find(
      (e) => (e as { event?: string }).event === 'session_created',
    ) as { correlationId?: string };
    expect(created.correlationId).toBe('cid-42');
  });

  it('broadcasts a typed error with code codex_session_id_missing when a result carries that error', async () => {
    const { mgr, procs } = makeManager();
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    const broadcasts: unknown[] = [];
    mgr.on('broadcast', (m) => broadcasts.push(m));

    procs[0]!.emitEvent({ kind: 'result', error: 'codex_session_id_missing' });

    // The result stream message should land first, then the typed error.
    const resultMsg = broadcasts.find((b) => (b as { type: string }).type === 'result');
    expect(resultMsg).toBeDefined();
    const errMsg = broadcasts.find(
      (b) => (b as { type: string }).type === 'error',
    ) as { code: string; sessionId: string; message: string } | undefined;
    expect(errMsg).toBeDefined();
    expect(errMsg?.code).toBe('codex_session_id_missing');
    expect(errMsg?.sessionId).toBe(s.sessionId);
    expect(errMsg?.message).toMatch(/session_id/);

    // The result broadcast must precede the error broadcast.
    const resultIdx = broadcasts.indexOf(resultMsg!);
    const errIdx = broadcasts.indexOf(errMsg!);
    expect(resultIdx).toBeLessThan(errIdx);
  });

  it('broadcasts agent_not_installed error on ENOENT spawn failure', async () => {
    const { mgr, procs } = makeManager();
    await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    const broadcasts: unknown[] = [];
    mgr.on('broadcast', (m) => broadcasts.push(m));

    procs[0]!.emit('exit', null, 'agent_not_installed');

    const err = broadcasts.find((b) => (b as { type: string }).type === 'error');
    expect(err).toMatchObject({ code: 'agent_not_installed' });
    const ended = broadcasts.find(
      (b) => (b as { type: string; event?: string }).event === 'session_ended',
    );
    expect((ended as { reason: string }).reason).toBe('agent_not_installed');
  });

  it('forwards process events as protocol messages with monotonic seq', async () => {
    const { mgr, procs } = makeManager();
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    const broadcasts: unknown[] = [];
    mgr.on('broadcast', (m) => broadcasts.push(m));

    procs[0]!.emitEvent({ kind: 'stream_delta', delta: 'hi' });
    procs[0]!.emitEvent({ kind: 'assistant_text', text: 'hello' });

    expect(broadcasts.length).toBe(2);
    const a = broadcasts[0] as ServerStreamMsg;
    const b = broadcasts[1] as ServerStreamMsg;
    expect(a.sessionId).toBe(s.sessionId);
    expect(a.seq).toBe(2);
    expect(a.type).toBe('stream_delta');
    expect(b.seq).toBe(3);
    expect(b.type).toBe('assistant');
  });

  it('keeps events in the ring buffer for replay via getHistory', async () => {
    const { mgr, procs } = makeManager();
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    procs[0]!.emitEvent({ kind: 'stream_delta', delta: 'a' });
    procs[0]!.emitEvent({ kind: 'stream_delta', delta: 'b' });

    const h = mgr.getHistory(s.sessionId, 0);
    expect(h.events.length).toBe(3); // session_created + 2 deltas
    expect(h.hasMore).toBe(false);
  });

  it('returns only events with seq > since', async () => {
    const { mgr, procs } = makeManager();
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    procs[0]!.emitEvent({ kind: 'stream_delta', delta: 'a' });
    procs[0]!.emitEvent({ kind: 'stream_delta', delta: 'b' });

    const h = mgr.getHistory(s.sessionId, 2);
    expect(h.events.length).toBe(1);
    const ev = h.events[0] as ServerStreamMsg;
    expect(ev.seq).toBe(3);
  });

  it('drops oldest events past bufferCap and signals hasMore for older requests', async () => {
    const procs: FakeProc[] = [];
    const mgr = new SessionManager({
      allowedDirs: ['/Users/test'],
      bufferCap: 5,
      spawnClaude: () => {
        const p = new FakeProc();
        procs.push(p);
        return p as unknown as import('../claude-process.js').ClaudeProcess;
      },
      realpath: async (p) => p,
    });
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    for (let i = 0; i < 10; i++) procs[0]!.emitEvent({ kind: 'stream_delta', delta: String(i) });

    const h = mgr.getHistory(s.sessionId, 0);
    expect(h.events.length).toBe(5);
    expect(h.hasMore).toBe(true);
  });

  it('emits session_ended on process exit and removes the session from list_sessions', async () => {
    const { mgr, procs } = makeManager();
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });

    const broadcasts: unknown[] = [];
    mgr.on('broadcast', (m) => broadcasts.push(m));
    procs[0]!.emit('exit', 0);

    const last = broadcasts[broadcasts.length - 1] as ServerLifecycleMsg;
    expect(last.type).toBe('system');
    expect(last.event).toBe('session_ended');
    expect(last.sessionId).toBe(s.sessionId);
    expect(last.exitCode).toBe(0);

    expect(mgr.listSessions()).toHaveLength(0);
  });

  it('stop() kills the underlying process', async () => {
    const { mgr, procs } = makeManager();
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    mgr.stop(s.sessionId);
    expect(procs[0]!.killed).toBe(true);
  });

  it('sendInput forwards text to the process', async () => {
    const { mgr, procs } = makeManager();
    const broadcasts: unknown[] = [];
    mgr.on('broadcast', (m) => broadcasts.push(m));
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    mgr.sendInput(s.sessionId, 'hi there');
    expect(procs[0]!.sentText).toEqual(['hi there']);
    const userBroadcast = broadcasts.find((b) => (b as { type: string }).type === 'user') as ServerStreamMsg;
    expect(userBroadcast).toBeDefined();
    expect(userBroadcast.seq).toBe(2);
    expect((userBroadcast.payload as { text: string }).text).toBe('hi there');
  });

  it('appends user events to the ring buffer so replay reproduces them', async () => {
    const { mgr } = makeManager();
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    mgr.sendInput(s.sessionId, 'first');
    mgr.sendInput(s.sessionId, 'second');

    const h = mgr.getHistory(s.sessionId, 0);
    // session_created (seq 1) + 2 user events (seq 2, 3) = 3 events
    expect(h.events.length).toBe(3);
    const userEvents = h.events.filter((e) => (e as { type: string }).type === 'user');
    expect(userEvents.length).toBe(2);
    expect((userEvents[0] as { payload: { text: string } }).payload.text).toBe('first');
    expect((userEvents[1] as { payload: { text: string } }).payload.text).toBe('second');
  });

  it('throws session_dead error when sending input to unknown session', async () => {
    const { mgr } = makeManager();
    expect(() => mgr.sendInput('nope', 'x')).toThrow(/session_dead/);
  });

  it('forwards broadcasts to a TranscriptStore.append when one is provided', async () => {
    const procs: FakeProc[] = [];
    const appended: Array<{ id: string; msg: unknown }> = [];
    const fakeTranscriptStore = {
      append: (id: string, msg: unknown) => appended.push({ id, msg }),
      close: () => {},
      closeAll: () => {},
      prune: async () => 0,
      pathFor: () => '',
    };
    const mgr = new SessionManager({
      allowedDirs: ['/Users/test'],
      bufferCap: 100,
      driverFactory: () => {
        const p = new FakeProc();
        procs.push(p);
        return p as unknown as import('../session.js').AgentDriver;
      },
      realpath: async (p) => p,
      transcriptStore: fakeTranscriptStore as unknown as import('../transcript-store.js').TranscriptStore,
    });
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    procs[0]!.emitEvent({ kind: 'stream_delta', delta: 'a' });

    expect(appended.map((a) => a.id)).toEqual([s.sessionId, s.sessionId]);
    // First append is session_created (lifecycle), second is the stream_delta.
    const first = appended[0]!.msg as { type: string };
    const second = appended[1]!.msg as { type: string };
    expect(first.type).toBe('system');
    expect(second.type).toBe('stream_delta');
  });

  it('calls TranscriptStore.close on session_ended', async () => {
    const procs: FakeProc[] = [];
    const closed: string[] = [];
    const fakeTranscriptStore = {
      append: () => {},
      close: (id: string) => closed.push(id),
      closeAll: () => {},
      prune: async () => 0,
      pathFor: () => '',
    };
    const mgr = new SessionManager({
      allowedDirs: ['/Users/test'],
      bufferCap: 100,
      driverFactory: () => {
        const p = new FakeProc();
        procs.push(p);
        return p as unknown as import('../session.js').AgentDriver;
      },
      realpath: async (p) => p,
      transcriptStore: fakeTranscriptStore as unknown as import('../transcript-store.js').TranscriptStore,
    });
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    procs[0]!.emit('exit', 0);
    await new Promise((r) => setImmediate(r));
    expect(closed).toEqual([s.sessionId]);
  });

  it('schedules ImageStore.writeAuditCopy as a fire-and-forget after sendInput', async () => {
    const procs: FakeProc[] = [];
    const auditCalls: Array<{ id: string; n: number }> = [];
    const fakeImageStore = {
      validate: () => ({ ok: true as const }),
      writeAuditCopy: async (id: string, imgs: unknown[]) => {
        auditCalls.push({ id, n: imgs.length });
      },
      cleanup: async () => {},
    };
    const mgr = new SessionManager({
      allowedDirs: ['/Users/test'],
      bufferCap: 100,
      driverFactory: () => {
        const p = new FakeProc();
        procs.push(p);
        return p as unknown as import('../session.js').AgentDriver;
      },
      realpath: async (p) => p,
      imageStore: fakeImageStore as unknown as import('../image-store.js').ImageStore,
    });
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    mgr.sendInput(s.sessionId, 'hi', [{ mime: 'image/png', base64: 'AA==' }]);
    // sendInput returns synchronously; audit copy was scheduled.
    await new Promise((r) => setImmediate(r));
    expect(auditCalls).toEqual([{ id: s.sessionId, n: 1 }]);
  });

  it('forwards images to the driver via proc.sendUserText', async () => {
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
    });
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    mgr.sendInput(s.sessionId, 'hi', [{ mime: 'image/png', base64: 'AAA=' }]);
    expect(procs[0]!.sentText).toEqual(['hi']);
    expect(procs[0]!.sentImages).toEqual([[{ mime: 'image/png', base64: 'AAA=' }]]);
  });

  describe('Phase 5 — resume', () => {
    let tmp: string;
    let registryPath: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'sessmgr-'));
      registryPath = join(tmp, 'sessions.json');
    });
    afterEach(async () => {
      // Let any in-flight registry writes drain before we delete the dir,
      // otherwise the SessionRegistry write queue logs noisy ENOENTs.
      await new Promise((r) => setTimeout(r, 10));
      rmSync(tmp, { recursive: true, force: true });
    });

    interface SpawnArg {
      agent: string;
      projectPath: string;
      account?: string;
      resumeArgs?: string[];
      codexResumeSeed?: string;
    }

    class TrackedDriver extends EventEmitter implements AgentDriver {
      sentText: string[] = [];
      killed = false;
      readonly args: SpawnArg;
      // Mirror codex/claude's optional stderrTail interface.
      stderrBuf = '';
      // Mirror Codex's `resumed` flag for tests that want to assert via the driver.
      resumed = false;
      // Mirror Codex's seeded session id (set by factory below if codexResumeSeed provided).
      codexSessionId: string | null = null;
      constructor(args: SpawnArg) {
        super();
        this.args = args;
      }
      sendUserText(s: string) { this.sentText.push(s); }
      kill() { this.killed = true; this.emit('exit', 0); }
      stderrTail() { return this.stderrBuf; }
    }

    function makeMgrWithRegistry(opts: {
      allowedDirs?: string[];
      claudeResumeSettleMs?: number;
      onSpawn?: (driver: TrackedDriver, args: SpawnArg) => void;
    } = {}) {
      const allowedDirs = opts.allowedDirs ?? [tmp];
      const drivers: TrackedDriver[] = [];
      const spawned: SpawnArg[] = [];
      const registry = new SessionRegistry(registryPath);
      const factory = (args: DriverFactoryArgs): AgentDriver => {
        const arg: SpawnArg = {
          agent: args.agent,
          projectPath: args.projectPath,
          ...(args.account ? { account: args.account.name } : {}),
          ...(args.resumeArgs ? { resumeArgs: args.resumeArgs } : {}),
          ...(args.codexResumeSeed ? { codexResumeSeed: args.codexResumeSeed } : {}),
        };
        spawned.push(arg);
        const d = new TrackedDriver(arg);
        if (args.codexResumeSeed) {
          d.codexSessionId = args.codexResumeSeed;
          d.resumed = true;
        }
        if (args.resumeArgs && args.resumeArgs.length > 0) {
          d.resumed = true;
        }
        drivers.push(d);
        opts.onSpawn?.(d, arg);
        return d;
      };
      const accounts = new Map([
        ['default', { name: 'default', codexHome: '/tmp/codex-home' } as const],
      ]);
      const mgr = new SessionManager({
        allowedDirs,
        bufferCap: 100,
        driverFactory: factory,
        realpath: async (p) => p,
        registry,
        accounts: accounts as unknown as Map<string, import('../accounts.js').CodexAccount>,
        // Pluggable stat: use the real fs stat for these tests since we mkdir
        // real directories under tmp.
        claudeResumeSettleMs: opts.claudeResumeSettleMs ?? 50,
      });
      return { mgr, registry, drivers, spawned };
    }

    it('resume(webSessionId) for Claude spawns with --resume <claudeId> and projectPath cwd', async () => {
      const { mgr, registry, drivers, spawned } = makeMgrWithRegistry();
      mkdirSync(join(tmp, 'proj'), { recursive: true });
      await registry.load();
      await registry.add({
        webSessionId: 'web-1',
        agent: 'claude',
        projectPath: join(tmp, 'proj'),
        transcriptPath: '.bridge/transcripts/web-1.jsonl',
        claudeSessionId: 'claude-uuid-1',
        codexSessionId: null,
        createdAt: 0,
        account: null,
      });
      await mgr.resume('web-1');
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.agent).toBe('claude');
      expect(spawned[0]!.projectPath).toBe(join(tmp, 'proj'));
      expect(spawned[0]!.resumeArgs).toEqual(['--resume', 'claude-uuid-1']);
      expect(drivers[0]!.resumed).toBe(true);
    });

    it('resume(webSessionId) for Codex instantiates driver seeded with codexSessionId; no spawn-per-turn yet', async () => {
      const { mgr, registry, drivers, spawned } = makeMgrWithRegistry();
      mkdirSync(join(tmp, 'proj'), { recursive: true });
      await registry.load();
      await registry.add({
        webSessionId: 'web-2',
        agent: 'codex',
        projectPath: join(tmp, 'proj'),
        transcriptPath: '.bridge/transcripts/web-2.jsonl',
        claudeSessionId: null,
        codexSessionId: 'codex-uuid-2',
        createdAt: 0,
        account: 'default',
      });
      await mgr.resume('web-2');
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.agent).toBe('codex');
      expect(spawned[0]!.codexResumeSeed).toBe('codex-uuid-2');
      expect(drivers[0]!.codexSessionId).toBe('codex-uuid-2');
      expect(mgr.isAlive('web-2')).toBe(true);
    });

    it('resume rejects with cli_session_id_unknown when registry entry has null cliSessionId', async () => {
      const { mgr, registry } = makeMgrWithRegistry();
      mkdirSync(join(tmp, 'proj'), { recursive: true });
      await registry.load();
      await registry.add({
        webSessionId: 'web-3',
        agent: 'claude',
        projectPath: join(tmp, 'proj'),
        transcriptPath: '.bridge/transcripts/web-3.jsonl',
        claudeSessionId: null,
        codexSessionId: null,
        createdAt: 0,
        account: null,
      });
      await expect(mgr.resume('web-3')).rejects.toMatchObject({ code: 'cli_session_id_unknown' });
    });

    it('resume rejects with project_path_missing when projectPath is missing from disk', async () => {
      const { mgr, registry } = makeMgrWithRegistry();
      await registry.load();
      await registry.add({
        webSessionId: 'web-4',
        agent: 'claude',
        projectPath: join(tmp, 'does-not-exist'),
        transcriptPath: '.bridge/transcripts/web-4.jsonl',
        claudeSessionId: 'claude-uuid-4',
        codexSessionId: null,
        createdAt: 0,
        account: null,
      });
      await expect(mgr.resume('web-4')).rejects.toMatchObject({ code: 'project_path_missing' });
    });

    it('resume rejects with project_path_disallowed when projectPath is outside allowlist', async () => {
      const allowed = join(tmp, 'allowed');
      const disallowed = join(tmp, 'disallowed');
      mkdirSync(allowed, { recursive: true });
      mkdirSync(disallowed, { recursive: true });
      const { mgr, registry } = makeMgrWithRegistry({ allowedDirs: [allowed] });
      await registry.load();
      await registry.add({
        webSessionId: 'web-5',
        agent: 'claude',
        projectPath: disallowed,
        transcriptPath: '.bridge/transcripts/web-5.jsonl',
        claudeSessionId: 'claude-uuid-5',
        codexSessionId: null,
        createdAt: 0,
        account: null,
      });
      await expect(mgr.resume('web-5')).rejects.toMatchObject({ code: 'project_path_disallowed' });
    });

    it('concurrent resume() calls dedup — second returns the same in-flight promise', async () => {
      const { mgr, registry } = makeMgrWithRegistry();
      mkdirSync(join(tmp, 'proj'), { recursive: true });
      await registry.load();
      await registry.add({
        webSessionId: 'web-6',
        agent: 'claude',
        projectPath: join(tmp, 'proj'),
        transcriptPath: '.bridge/transcripts/web-6.jsonl',
        claudeSessionId: 'claude-uuid-6',
        codexSessionId: null,
        createdAt: 0,
        account: null,
      });
      const before = mgr.spawnCallCount;
      const a = mgr.resume('web-6');
      const b = mgr.resume('web-6');
      await Promise.all([a, b]);
      expect(mgr.spawnCallCount - before).toBe(1);
    });

    it('resume rejects with claude_resume_rejected when claude exits non-zero with rejection-shaped stderr', async () => {
      const { mgr, registry } = makeMgrWithRegistry({
        claudeResumeSettleMs: 200,
        onSpawn: (driver) => {
          driver.stderrBuf = 'Error: No conversation found with session ID stale-claude-id';
          // Fire exit asynchronously so the resume() call enters its
          // wait-for-settle window first.
          setImmediate(() => driver.emit('exit', 1));
        },
      });
      mkdirSync(join(tmp, 'proj'), { recursive: true });
      await registry.load();
      await registry.add({
        webSessionId: 'web-7',
        agent: 'claude',
        projectPath: join(tmp, 'proj'),
        transcriptPath: '.bridge/transcripts/web-7.jsonl',
        claudeSessionId: 'stale-claude-id',
        codexSessionId: null,
        createdAt: 0,
        account: null,
      });
      await expect(mgr.resume('web-7')).rejects.toMatchObject({ code: 'claude_resume_rejected' });
    });

    it('resume succeeds for codex; codex_resume_rejected surfaces on first send_text via broadcast', async () => {
      const { mgr, registry, drivers } = makeMgrWithRegistry();
      mkdirSync(join(tmp, 'proj'), { recursive: true });
      await registry.load();
      await registry.add({
        webSessionId: 'web-8',
        agent: 'codex',
        projectPath: join(tmp, 'proj'),
        transcriptPath: '.bridge/transcripts/web-8.jsonl',
        claudeSessionId: null,
        codexSessionId: 'stale-codex-id',
        createdAt: 0,
        account: 'default',
      });
      await mgr.resume('web-8'); // succeeds
      const broadcasts: unknown[] = [];
      mgr.on('broadcast', (m) => broadcasts.push(m));
      // Simulate the driver's first turn failing with the resume-reject result.
      drivers[0]!.emit('event', { kind: 'result', error: 'codex_resume_rejected' } satisfies AgentEvent);
      const err = broadcasts.find((b) => (b as { type: string }).type === 'error') as
        | { code: string; sessionId: string }
        | undefined;
      expect(err).toBeDefined();
      expect(err?.code).toBe('codex_resume_rejected');
      expect(err?.sessionId).toBe('web-8');
    });

    it('on driver cli_session_id event, registry entry is updated', async () => {
      const { mgr, registry, drivers } = makeMgrWithRegistry();
      mkdirSync(join(tmp, 'proj'), { recursive: true });
      await registry.load();
      const s = await mgr.create({ agent: 'claude', projectPath: join(tmp, 'proj') });
      // Simulate the driver emitting cli_session_id (Phase 4 contract).
      drivers[0]!.emit('cli_session_id', 'fresh-claude-uuid');
      // Wait for the async registry write triggered by onCliSessionId. We
      // poll briefly so the test isn't tied to a specific event-loop turn.
      const deadline = Date.now() + 200;
      while (Date.now() < deadline && registry.get(s.sessionId)?.claudeSessionId !== 'fresh-claude-uuid') {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(registry.get(s.sessionId)?.claudeSessionId).toBe('fresh-claude-uuid');
    });

    it('create() writes an up-front registry entry with null cliSessionIds', async () => {
      const { mgr, registry } = makeMgrWithRegistry();
      mkdirSync(join(tmp, 'proj'), { recursive: true });
      await registry.load();
      const s = await mgr.create({ agent: 'claude', projectPath: join(tmp, 'proj') });
      const entry = registry.get(s.sessionId);
      expect(entry).toBeDefined();
      expect(entry?.agent).toBe('claude');
      expect(entry?.projectPath).toBe(join(tmp, 'proj'));
      expect(entry?.claudeSessionId).toBeNull();
      expect(entry?.codexSessionId).toBeNull();
    });

    it('attachSession emits synthesized session_created BEFORE wiring driver listeners (seq ordering)', async () => {
      // Regression test for I1: if the driver flushes stdout synchronously
      // the moment listeners are wired, the real event must NOT steal seq=1
      // from the synthesized session_created. Fix: emit session_created
      // BEFORE wireDriverListeners(). Verify by having the driver emit an
      // assistant event on the next microtask after spawn — it should land
      // in the buffer with seq=2, behind the synthesized session_created.
      const { mgr, registry, drivers } = makeMgrWithRegistry({
        claudeResumeSettleMs: 100,
        onSpawn: (driver) => {
          // Schedule a synchronous-as-possible event emission. Microtask
          // fires after the current synchronous frame (which includes
          // attachSession's full synchronous body). Without the fix, this
          // event would be lost or steal seq=1; with the fix it gets seq=2.
          queueMicrotask(() => {
            driver.emit('event', { kind: 'assistant_text', text: 'hello' } satisfies AgentEvent);
          });
        },
      });
      mkdirSync(join(tmp, 'proj'), { recursive: true });
      await registry.load();
      await registry.add({
        webSessionId: 'web-seq',
        agent: 'claude',
        projectPath: join(tmp, 'proj'),
        transcriptPath: '.bridge/transcripts/web-seq.jsonl',
        claudeSessionId: 'claude-uuid-seq',
        codexSessionId: null,
        createdAt: 0,
        account: null,
      });
      await mgr.resume('web-seq');
      // Pull replay history — buffer order is the source of truth for the wire.
      const h = mgr.getHistory('web-seq', 0);
      expect(h).not.toBeNull();
      expect(h!.events.length).toBe(2);
      const first = h!.events[0] as ServerLifecycleMsg;
      const second = h!.events[1] as ServerStreamMsg;
      expect(first.type).toBe('system');
      expect(first.event).toBe('session_created');
      expect(first.seq).toBe(1);
      expect(second.type).toBe('assistant');
      expect(second.seq).toBe(2);
      // Sanity: the driver did fire — guard against a future refactor that
      // silently swallows the event.
      expect(drivers[0]!.listenerCount('event')).toBeGreaterThan(0);
    });

    it('events emitted during the Claude resume settle window land in the buffer (C1)', async () => {
      // Regression test for C1: previously, listeners were wired AFTER
      // waitForEarlyExitOrSettle's ~1500ms window, so any stdout from a
      // fast-responding resumed Claude during that window was dropped on a
      // listener-less EventEmitter. Fix: attachSession is now called
      // BEFORE the settle race so listeners are wired from t=0.
      // Verify by emitting an event 50ms after spawn with settleMs=300; the
      // resume completes after the settle timeout fires (no early exit) and
      // the buffer should contain BOTH the synthesized session_created and
      // the assistant event.
      const { mgr, registry } = makeMgrWithRegistry({
        claudeResumeSettleMs: 300,
        onSpawn: (driver) => {
          setTimeout(() => {
            driver.emit('event', { kind: 'assistant_text', text: 'mid-settle' } satisfies AgentEvent);
          }, 50);
        },
      });
      mkdirSync(join(tmp, 'proj'), { recursive: true });
      await registry.load();
      await registry.add({
        webSessionId: 'web-settle',
        agent: 'claude',
        projectPath: join(tmp, 'proj'),
        transcriptPath: '.bridge/transcripts/web-settle.jsonl',
        claudeSessionId: 'claude-uuid-settle',
        codexSessionId: null,
        createdAt: 0,
        account: null,
      });
      await mgr.resume('web-settle');
      const h = mgr.getHistory('web-settle', 0);
      expect(h).not.toBeNull();
      // Two events: session_created + assistant_text
      expect(h!.events.length).toBe(2);
      const created = h!.events[0] as ServerLifecycleMsg;
      const assistant = h!.events[1] as ServerStreamMsg;
      expect(created.event).toBe('session_created');
      expect(created.seq).toBe(1);
      expect(assistant.type).toBe('assistant');
      expect(assistant.seq).toBe(2);
      expect((assistant.payload as { text: string }).text).toBe('mid-settle');
    });

    it('attachSession synthesizes a session_created lifecycle event so web learns of resumed webSessionId', async () => {
      const { mgr, registry } = makeMgrWithRegistry();
      mkdirSync(join(tmp, 'proj'), { recursive: true });
      await registry.load();
      await registry.add({
        webSessionId: 'web-syn',
        agent: 'codex',
        projectPath: join(tmp, 'proj'),
        transcriptPath: '.bridge/transcripts/web-syn.jsonl',
        claudeSessionId: null,
        codexSessionId: 'codex-uuid-syn',
        createdAt: 12345,
        account: 'default',
      });
      const broadcasts: unknown[] = [];
      mgr.on('broadcast', (m) => broadcasts.push(m));
      await mgr.resume('web-syn');
      const created = broadcasts.find(
        (b) => (b as { type: string; event?: string }).event === 'session_created',
      ) as ServerLifecycleMsg | undefined;
      expect(created).toBeDefined();
      expect(created?.sessionId).toBe('web-syn');
      expect(created?.agent).toBe('codex');
      expect(created?.account).toBe('default');
    });
  });

  it('records user prompts in the PromptStore on sendInput', async () => {
    const procs: FakeProc[] = [];
    const added: Array<{ text: string; projectPath: string; agent: string }> = [];
    const fakePromptStore = {
      add: (args: { text: string; projectPath: string; agent: string }) => added.push(args),
      list: () => [],
    };
    const mgr = new SessionManager({
      allowedDirs: ['/Users/test'],
      bufferCap: 100,
      driverFactory: () => {
        const p = new FakeProc();
        procs.push(p);
        return p as unknown as import('../session.js').AgentDriver;
      },
      realpath: async (p) => p,
      promptStore: fakePromptStore as unknown as import('../prompt-store.js').PromptStore,
    });
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    mgr.sendInput(s.sessionId, 'remember me');
    expect(added).toEqual([
      { text: 'remember me', projectPath: '/Users/test/proj', agent: 'claude' },
    ]);
  });

  describe('Phase 6 — multi-dir, auto-name, rename, notifier', () => {
    let tmp: string;
    let registryPath: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'sessmgr-p6-'));
      registryPath = join(tmp, 'sessions.json');
    });
    afterEach(async () => {
      // Phase 6 tests fire async registry.update from handleInput +
      // sendInput. Wait long enough for the write queue to drain before
      // deleting the tmp dir, otherwise the rename in persist() ENOENTs.
      await new Promise((r) => setTimeout(r, 50));
      rmSync(tmp, { recursive: true, force: true });
    });

    interface SpawnArg {
      agent: string;
      projectPath: string;
      account?: string;
      additionalDirs?: string[];
    }

    class TrackedDriver extends EventEmitter implements AgentDriver {
      sentText: string[] = [];
      killed = false;
      readonly args: SpawnArg;
      stderrBuf = '';
      constructor(args: SpawnArg) {
        super();
        this.args = args;
      }
      sendUserText(s: string) { this.sentText.push(s); }
      kill() { this.killed = true; this.emit('exit', 0); }
      stderrTail() { return this.stderrBuf; }
    }

    async function makeRegistry(): Promise<SessionRegistry> {
      const r = new SessionRegistry(registryPath);
      await r.load();
      return r;
    }

    async function makeMgrP6(opts: {
      allowedDirs?: string[];
      registry?: SessionRegistry;
      notifier?: {
        noteInput: (id: string) => void;
        noteResult: (entry: unknown) => Promise<void> | void;
        noteSessionEnd: (id: string) => void;
      };
    } = {}) {
      const allowedDirs = opts.allowedDirs ?? [tmp];
      const drivers: TrackedDriver[] = [];
      const spawned: SpawnArg[] = [];
      const registry = opts.registry ?? (await makeRegistry());
      const factory = (args: DriverFactoryArgs): AgentDriver => {
        const arg: SpawnArg = {
          agent: args.agent,
          projectPath: args.projectPath,
          ...(args.account ? { account: args.account.name } : {}),
          ...(args.additionalDirs ? { additionalDirs: args.additionalDirs } : {}),
        };
        spawned.push(arg);
        const d = new TrackedDriver(arg);
        drivers.push(d);
        return d;
      };
      const accounts = new Map([
        ['default', { name: 'default', codexHome: '/tmp/codex-home' } as const],
      ]);
      const mgr = new SessionManager({
        allowedDirs,
        bufferCap: 100,
        driverFactory: factory,
        realpath: async (p) => p,
        registry,
        accounts: accounts as unknown as Map<string, import('../accounts.js').CodexAccount>,
        ...(opts.notifier
          ? { notifier: opts.notifier as unknown as import('../notifier.js').Notifier }
          : {}),
      });
      return { mgr, registry, drivers, spawned };
    }

    it('spawnSession with dirs[a, b, c] passes additionalDirs to Claude driver', async () => {
      const a = join(tmp, 'a');
      const b = join(tmp, 'b');
      const c = join(tmp, 'c');
      mkdirSync(a, { recursive: true });
      mkdirSync(b, { recursive: true });
      mkdirSync(c, { recursive: true });
      const { mgr, spawned } = await makeMgrP6();
      const sess = await mgr.spawnSession({
        agent: 'claude',
        dirs: [a, b, c],
      });
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.agent).toBe('claude');
      expect(spawned[0]!.projectPath).toBe(a);
      expect(spawned[0]!.additionalDirs).toEqual([b, c]);
      // Registry persisted with additionalDirs and name=null.
      const { registry } = await makeMgrP6({ registry: await (async () => {
        const r = new SessionRegistry(registryPath);
        await r.load();
        return r;
      })() });
      const entry = registry.get(sess.webSessionId);
      expect(entry?.additionalDirs).toEqual([b, c]);
      expect(entry?.name).toBeNull();
    });

    it('spawnSession with codex + multiple dirs forwards additionalDirs to driver factory', async () => {
      const a = join(tmp, 'a');
      const b = join(tmp, 'b');
      mkdirSync(a, { recursive: true });
      mkdirSync(b, { recursive: true });
      const { mgr, spawned } = await makeMgrP6();
      await mgr.spawnSession({
        agent: 'codex',
        dirs: [a, b],
        account: 'default',
      });
      // The driver factory receives additionalDirs; the warn happens inside
      // the real CodexProcess constructor (covered by codex-process.test.ts).
      // Here we assert SessionManager wires the value through.
      expect(spawned[0]!.agent).toBe('codex');
      expect(spawned[0]!.additionalDirs).toEqual([b]);
    });

    it('first user input auto-sets session.name truncated to 60 chars', async () => {
      const a = join(tmp, 'a');
      mkdirSync(a, { recursive: true });
      const { mgr, registry } = await makeMgrP6();
      const sess = await mgr.spawnSession({ agent: 'claude', dirs: [a] });
      const longText = 'fix login bug in OAuth flow that was reported by QA team yesterday afternoon';
      await mgr.handleInput(sess.webSessionId, longText);
      const entry = registry.get(sess.webSessionId);
      expect(entry?.name).toBe(longText.slice(0, 60).trim());
      // Subsequent input does NOT overwrite the name.
      await mgr.handleInput(sess.webSessionId, 'a totally different prompt');
      const entry2 = registry.get(sess.webSessionId);
      expect(entry2?.name).toBe(longText.slice(0, 60).trim());
    });

    it('first input that is whitespace-only auto-sets name to (empty)', async () => {
      const a = join(tmp, 'a');
      mkdirSync(a, { recursive: true });
      const { mgr, registry } = await makeMgrP6();
      const sess = await mgr.spawnSession({ agent: 'claude', dirs: [a] });
      await mgr.handleInput(sess.webSessionId, '   \t\n   ');
      expect(registry.get(sess.webSessionId)?.name).toBe('(empty)');
    });

    it('renameSession validates + persists + broadcasts session_renamed', async () => {
      const a = join(tmp, 'a');
      mkdirSync(a, { recursive: true });
      const { mgr, registry } = await makeMgrP6();
      const sess = await mgr.spawnSession({ agent: 'claude', dirs: [a] });
      const events: { type: string }[] = [];
      mgr.on('broadcast', (e) => events.push(e));
      await mgr.renameSession(sess.webSessionId, 'my session');
      expect(registry.get(sess.webSessionId)?.name).toBe('my session');
      const renamed = events.find((e) => e.type === 'session_renamed') as
        | { type: 'session_renamed'; sessionId: string; name: string }
        | undefined;
      expect(renamed).toBeDefined();
      expect(renamed?.sessionId).toBe(sess.webSessionId);
      expect(renamed?.name).toBe('my session');
    });

    it('renameSession rejects empty / whitespace / overlong / control-char names', async () => {
      const a = join(tmp, 'a');
      mkdirSync(a, { recursive: true });
      const { mgr } = await makeMgrP6();
      const sess = await mgr.spawnSession({ agent: 'claude', dirs: [a] });
      await expect(mgr.renameSession(sess.webSessionId, '')).rejects.toMatchObject({
        code: 'session_name_invalid',
      });
      await expect(mgr.renameSession(sess.webSessionId, '   ')).rejects.toMatchObject({
        code: 'session_name_invalid',
      });
      await expect(
        mgr.renameSession(sess.webSessionId, 'x'.repeat(201)),
      ).rejects.toMatchObject({ code: 'session_name_invalid' });
      await expect(
        mgr.renameSession(sess.webSessionId, 'foo bar'),
      ).rejects.toMatchObject({ code: 'session_name_invalid' });
    });

    it('notifier.noteInput is called when sendInput fires', async () => {
      const a = join(tmp, 'a');
      mkdirSync(a, { recursive: true });
      const noteInput = vi.fn();
      const noteResult = vi.fn(async () => {});
      const noteSessionEnd = vi.fn();
      const { mgr } = await makeMgrP6({
        notifier: { noteInput, noteResult, noteSessionEnd },
      });
      const sess = await mgr.spawnSession({ agent: 'claude', dirs: [a] });
      mgr.sendInput(sess.webSessionId, 'hello');
      expect(noteInput).toHaveBeenCalledWith(sess.webSessionId);
    });

    it('notifier.noteResult is called when a result event broadcasts', async () => {
      const a = join(tmp, 'a');
      mkdirSync(a, { recursive: true });
      const noteInput = vi.fn();
      const noteResult = vi.fn(async () => {});
      const noteSessionEnd = vi.fn();
      const { mgr, drivers } = await makeMgrP6({
        notifier: { noteInput, noteResult, noteSessionEnd },
      });
      const sess = await mgr.spawnSession({ agent: 'claude', dirs: [a] });
      drivers[0]!.emit('event', { kind: 'result', durationMs: 1000 } satisfies AgentEvent);
      // Allow the void-promise inside onProcEvent to settle.
      await new Promise((r) => setImmediate(r));
      expect(noteResult).toHaveBeenCalledTimes(1);
      const arg = noteResult.mock.calls[0]![0] as { webSessionId: string };
      expect(arg.webSessionId).toBe(sess.webSessionId);
    });

    it('notifier.noteSessionEnd is called when the driver exits', async () => {
      const a = join(tmp, 'a');
      mkdirSync(a, { recursive: true });
      const noteInput = vi.fn();
      const noteResult = vi.fn(async () => {});
      const noteSessionEnd = vi.fn();
      const { mgr, drivers } = await makeMgrP6({
        notifier: { noteInput, noteResult, noteSessionEnd },
      });
      const sess = await mgr.spawnSession({ agent: 'claude', dirs: [a] });
      drivers[0]!.emit('exit', 0);
      expect(noteSessionEnd).toHaveBeenCalledWith(sess.webSessionId);
    });

    it('spawnSession dedups exact-match duplicate dirs', async () => {
      const a = join(tmp, 'a');
      const b = join(tmp, 'b');
      mkdirSync(a, { recursive: true });
      mkdirSync(b, { recursive: true });
      const { mgr, spawned } = await makeMgrP6();
      await mgr.spawnSession({
        agent: 'claude',
        dirs: [a, b, a, b],
      });
      expect(spawned[0]!.projectPath).toBe(a);
      expect(spawned[0]!.additionalDirs).toEqual([b]);
    });

    it('spawnSession rejects an empty dirs array', async () => {
      const { mgr } = await makeMgrP6();
      await expect(
        mgr.spawnSession({ agent: 'claude', dirs: [] }),
      ).rejects.toMatchObject({ code: 'path_outside_allowlist' });
    });

    it('spawnSession rejects when any dir is outside the allowlist', async () => {
      const a = join(tmp, 'a');
      mkdirSync(a, { recursive: true });
      const { mgr } = await makeMgrP6();
      await expect(
        mgr.spawnSession({ agent: 'claude', dirs: [a, '/etc'] }),
      ).rejects.toMatchObject({ code: 'path_outside_allowlist' });
    });
  });
});
