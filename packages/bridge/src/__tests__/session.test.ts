import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionManager } from '../session.js';
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
});
