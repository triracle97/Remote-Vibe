import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionManager } from '../session.js';
import type { AgentEvent, ServerLifecycleMsg, ServerStreamMsg } from '../types.js';

class FakeProc extends EventEmitter {
  killed = false;
  sentText: string[] = [];
  sendUserText(s: string) { this.sentText.push(s); }
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
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    mgr.sendInput(s.sessionId, 'hi there');
    expect(procs[0]!.sentText).toEqual(['hi there']);
  });

  it('throws session_dead error when sending input to unknown session', async () => {
    const { mgr } = makeManager();
    expect(() => mgr.sendInput('nope', 'x')).toThrow(/session_dead/);
  });
});
