import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { TerminalManager } from '../terminal-manager.js';

interface FakeProc extends EventEmitter {
  writes: string[];
  resized: Array<[number, number]>;
  killCalls: number;
  pausedCount: number;
  resumedCount: number;
  fireOutput(s: string): void;
  fireExit(code: number | null, signal?: string | null): void;
}

function makeFakeProc(): FakeProc {
  const ee = new EventEmitter() as FakeProc;
  ee.writes = [];
  ee.resized = [];
  ee.killCalls = 0;
  ee.pausedCount = 0;
  ee.resumedCount = 0;
  Object.assign(ee, {
    write: (d: string) => { ee.writes.push(d); },
    resize: (c: number, r: number) => { ee.resized.push([c, r]); },
    kill: () => { ee.killCalls++; },
    pause: () => { ee.pausedCount++; },
    resume: () => { ee.resumedCount++; },
    fireOutput: (s: string) => ee.emit('output', s),
    fireExit: (c: number | null, sig: string | null = null) => ee.emit('exit', c, sig),
  });
  return ee;
}

function makeMgr(overrides: { allowedDirs?: string[] } = {}) {
  const procs: FakeProc[] = [];
  const mgr = new TerminalManager({
    allowedDirs: overrides.allowedDirs ?? ['/Users/me/code'],
    realpath: async (p) => p,
    procFactory: () => {
      const p = makeFakeProc();
      procs.push(p);
      return p as unknown as import('../terminal-process.js').TerminalProcess;
    },
    bpHighWatermark: 1000,
  });
  return { mgr, procs };
}

describe('TerminalManager', () => {
  it('spawn returns a session and emits no events synchronously', async () => {
    const { mgr, procs } = makeMgr();
    const events: unknown[] = [];
    mgr.on('output', (...a) => events.push(['output', ...a]));
    mgr.on('exit', (...a) => events.push(['exit', ...a]));
    const session = await mgr.spawn('ws-1', '/Users/me/code/proj', 80, 24);
    expect(session.wsId).toBe('ws-1');
    expect(session.cwd).toBe('/Users/me/code/proj');
    expect(typeof session.termId).toBe('string');
    expect(procs.length).toBe(1);
    expect(events).toEqual([]);
  });

  it('rejects path outside allowlist', async () => {
    const { mgr } = makeMgr();
    await expect(mgr.spawn('ws-1', '/etc', 80, 24)).rejects.toMatchObject({
      code: 'path_outside_allowlist',
    });
  });

  it('translates factory throw to terminal_spawn_failed', async () => {
    const mgr = new TerminalManager({
      allowedDirs: ['/'],
      realpath: async (p) => p,
      procFactory: () => { throw new Error('node-pty missing'); },
    });
    await expect(mgr.spawn('ws-1', '/Users/me', 80, 24)).rejects.toMatchObject({
      code: 'terminal_spawn_failed',
    });
  });

  it('relays output only for the spawning ws', async () => {
    const { mgr, procs } = makeMgr();
    const events: Array<[string, string]> = [];
    mgr.on('output', (termId: string, data: string) => events.push([termId, data]));
    const s = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    procs[0]!.fireOutput('hi');
    expect(events).toEqual([[s.termId, 'hi']]);
  });

  it('sendInput routes to the proc when wsId matches', async () => {
    const { mgr, procs } = makeMgr();
    const s = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    mgr.sendInput('ws-1', s.termId, 'ls\n');
    expect(procs[0]!.writes).toEqual(['ls\n']);
  });

  it('sendInput from a different ws emits policy_violation', async () => {
    const { mgr } = makeMgr();
    const errs: unknown[] = [];
    mgr.on('policy_violation', (e) => errs.push(e));
    const s = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    mgr.sendInput('ws-2', s.termId, 'oops');
    expect(errs).toEqual([{ wsId: 'ws-2', code: 'terminal_not_found', termId: s.termId }]);
  });

  it('sendInput for an unknown termId is silently dropped, no policy_violation', async () => {
    const { mgr } = makeMgr();
    const errs: unknown[] = [];
    mgr.on('policy_violation', (e) => errs.push(e));
    mgr.sendInput('ws-1', 'never-existed', 'oops');
    expect(errs).toEqual([]);
  });

  it('resize routes when wsId matches; emits policy_violation on mismatch', async () => {
    const { mgr, procs } = makeMgr();
    const errs: unknown[] = [];
    mgr.on('policy_violation', (e) => errs.push(e));
    const s = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    mgr.resize('ws-1', s.termId, 100, 30);
    expect(procs[0]!.resized).toEqual([[100, 30]]);
    mgr.resize('ws-2', s.termId, 50, 25);
    expect(procs[0]!.resized).toEqual([[100, 30]]);
    expect(errs).toEqual([{ wsId: 'ws-2', code: 'terminal_not_found', termId: s.termId }]);
  });

  it('kill routes when wsId matches; emits policy_violation on mismatch', async () => {
    const { mgr, procs } = makeMgr();
    const errs: unknown[] = [];
    mgr.on('policy_violation', (e) => errs.push(e));
    const s = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    mgr.kill('ws-2', s.termId);
    expect(procs[0]!.killCalls).toBe(0);
    expect(errs).toEqual([{ wsId: 'ws-2', code: 'terminal_not_found', termId: s.termId }]);
    mgr.kill('ws-1', s.termId);
    expect(procs[0]!.killCalls).toBe(1);
  });

  it('kill is silent for an unknown termId', async () => {
    const { mgr } = makeMgr();
    const errs: unknown[] = [];
    mgr.on('policy_violation', (e) => errs.push(e));
    mgr.kill('ws-1', 'never-existed');
    expect(errs).toEqual([]);
  });

  it('killByWs kills only that ws\'s PTYs', async () => {
    const { mgr, procs } = makeMgr();
    const a = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    const b = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    const c = await mgr.spawn('ws-2', '/Users/me/code', 80, 24);
    mgr.killByWs('ws-1');
    expect(procs[0]!.killCalls).toBe(1); // a
    expect(procs[1]!.killCalls).toBe(1); // b
    expect(procs[2]!.killCalls).toBe(0); // c
    void a; void b; void c;
  });

  it('exit removes the entry from the map', async () => {
    const { mgr, procs } = makeMgr();
    const events: unknown[] = [];
    mgr.on('exit', (...a) => events.push(a));
    const s = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    procs[0]!.fireExit(0, null);
    expect(events).toEqual([[s.termId, 0, null]]);
    // After exit, sendInput becomes a silent no-op (entry gone).
    mgr.sendInput('ws-1', s.termId, 'after');
    expect(procs[0]!.writes).toEqual([]);
  });

  it('shutdown kills every PTY across every ws', async () => {
    const { mgr, procs } = makeMgr();
    await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    await mgr.spawn('ws-2', '/Users/me/code', 80, 24);
    await mgr.shutdown();
    expect(procs[0]!.killCalls).toBe(1);
    expect(procs[1]!.killCalls).toBe(1);
  });

  describe('backpressure', () => {
    beforeEach(() => vi.useRealTimers());

    it('pauses the pty when bufferedAmount exceeds the high-water mark and resumes when it drains', async () => {
      const { mgr, procs } = makeMgr();
      let buffered = 0;
      const session = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
      // The manager reports backpressure via reportBufferedAmount(termId, n)
      // — websocket.ts is responsible for calling this after each ws.send.
      mgr.reportBufferedAmount(session.termId, 2000);
      expect(procs[0]!.pausedCount).toBe(1);
      mgr.reportBufferedAmount(session.termId, 200);
      expect(procs[0]!.resumedCount).toBe(1);
      // Idempotent: re-reporting low buffered does not call resume again.
      mgr.reportBufferedAmount(session.termId, 0);
      expect(procs[0]!.resumedCount).toBe(1);
      // Re-overshoot pauses again.
      mgr.reportBufferedAmount(session.termId, 5000);
      expect(procs[0]!.pausedCount).toBe(2);
      buffered;
    });
  });
});
