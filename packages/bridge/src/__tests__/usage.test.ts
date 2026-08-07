import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeLine } from '../parser.js';
import { SessionRegistry } from '../session-registry.js';
import { SessionManager, type AgentDriver } from '../session.js';
import type { AgentEvent, ServerMsg } from '../types.js';

/** A real payload, captured from `claude --output-format stream-json`. */
const REAL_RATE_LIMIT_LINE = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning',
    resetsAt: 1786093200,
    rateLimitType: 'seven_day',
    utilization: 0.78,
    isUsingOverage: false,
    surpassedThreshold: 0.75,
  },
  uuid: 'aea07872-2a74-4b31-a648-1b7c5b59033b',
  session_id: '63cf3824-c64b-4957-ad72-4b1df932dbc6',
});

describe('parseClaudeLine — rate_limit_event', () => {
  it('parses the real payload', () => {
    const out = parseClaudeLine(REAL_RATE_LIMIT_LINE);
    expect(out).toHaveLength(1);
    const e = out[0] as Extract<AgentEvent, { kind: 'rate_limit' }>;
    expect(e.kind).toBe('rate_limit');
    expect(e.window.limitType).toBe('seven_day');
    // Fraction, not percent — 0.78 is 78%.
    expect(e.window.utilization).toBe(0.78);
    expect(e.window.resetsAt).toBe(1786093200);
    expect(e.window.status).toBe('allowed_warning');
    expect(e.window.isUsingOverage).toBe(false);
  });

  it('keeps an under-threshold window that reports no utilization', () => {
    // Captured from a profile below the warning threshold. The CLI names the
    // window and when it resets but omits `utilization` entirely — dropping
    // the event left the indicator with nothing to show for the whole run.
    const line = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: 1786085400,
        rateLimitType: 'five_hour',
        overageStatus: 'rejected',
        overageDisabledReason: 'org_level_disabled',
        isUsingOverage: false,
      },
    });
    const e = parseClaudeLine(line)[0] as Extract<AgentEvent, { kind: 'rate_limit' }>;
    expect(e.kind).toBe('rate_limit');
    expect(e.window.limitType).toBe('five_hour');
    expect(e.window.utilization).toBeNull();
    expect(e.window.resetsAt).toBe(1786085400);
    expect(e.window.status).toBe('allowed');
  });

  it('ignores a payload that names no window', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'rate_limit_event' }))).toEqual([]);
    expect(
      parseClaudeLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} })),
    ).toEqual([]);
  });

  it('tolerates a missing reset time', () => {
    const line = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.1 },
    });
    const e = parseClaudeLine(line)[0] as Extract<AgentEvent, { kind: 'rate_limit' }>;
    expect(e.window.resetsAt).toBeNull();
    expect(e.window.status).toBeNull();
  });
});

class FakeDriver extends EventEmitter implements AgentDriver {
  sendUserText(): void {}
  kill(): void {
    this.emit('exit', 0);
  }
}

const flush = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `cond` holds. Usage lands only after an fsync'd registry write,
 * so a fixed sleep is racy once the suite runs under parallel load.
 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await flush(5);
  }
  throw new Error('waitFor timed out');
}

describe('SessionManager usage tracking', () => {
  let dir: string;
  let registry: SessionRegistry;
  let mgr: SessionManager;
  let driver: FakeDriver;
  let broadcasts: ServerMsg[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mrt-usage-'));
    registry = new SessionRegistry(join(dir, 'sessions.json'));
    await registry.load();
    driver = new FakeDriver();
    mgr = new SessionManager({
      allowedDirs: [dir],
      bufferCap: 100,
      registry,
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
    // A write can still be draining; ENOTEMPTY here is noise, not a failure.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const turn = (
    usage: Record<string, number>,
    cost: number,
  ): void => {
    driver.emit('event', { kind: 'result', cost, usage } satisfies AgentEvent);
  };

  it('starts a session with zeroed totals', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    expect(registry.get(info.sessionId)!.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      turns: 0,
      contextTokens: 0,
    });
  });

  it('accumulates across turns', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    turn({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 20 }, 0.01);
    await waitFor(() => registry.get(info.sessionId)!.usage.turns === 1);
    turn({ inputTokens: 3, outputTokens: 7, cacheReadTokens: 50, cacheCreationTokens: 0 }, 0.02);
    await waitFor(() => registry.get(info.sessionId)!.usage.turns === 2);

    const u = registry.get(info.sessionId)!.usage;
    expect(u.inputTokens).toBe(13);
    expect(u.outputTokens).toBe(12);
    expect(u.cacheReadTokens).toBe(150);
    expect(u.cacheCreationTokens).toBe(20);
    expect(u.costUsd).toBeCloseTo(0.03, 6);
    expect(u.turns).toBe(2);
    // contextTokens is a level, not a total: the LAST turn's input side
    // (3 + 50 + 0), not the sum across turns.
    expect(u.contextTokens).toBe(53);
  });

  it('tracks context as a level that can fall when the CLI compacts', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    turn({ inputTokens: 5, outputTokens: 1, cacheReadTokens: 90_000, cacheCreationTokens: 5_000 }, 0);
    await waitFor(() => registry.get(info.sessionId)!.usage.turns === 1);
    expect(registry.get(info.sessionId)!.usage.contextTokens).toBe(95_005);

    // A compaction shrinks the prompt; the level must follow it DOWN, which is
    // the whole reason this is not summed like everything else here.
    turn({ inputTokens: 5, outputTokens: 1, cacheReadTokens: 8_000, cacheCreationTokens: 0 }, 0);
    await waitFor(() => registry.get(info.sessionId)!.usage.turns === 2);
    expect(registry.get(info.sessionId)!.usage.contextTokens).toBe(8_005);

    // ...while lifetime spend still only grows.
    expect(registry.get(info.sessionId)!.usage.cacheReadTokens).toBe(98_000);
  });

  it('keeps the last context reading when a turn reports no usage', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    turn({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 1_000, cacheCreationTokens: 0 }, 0);
    await waitFor(() => registry.get(info.sessionId)!.usage.turns === 1);
    driver.emit('event', { kind: 'result' } satisfies AgentEvent);
    await waitFor(() => registry.get(info.sessionId)!.usage.turns === 2);
    // Reporting 0 here would claim the context emptied, which it did not.
    expect(registry.get(info.sessionId)!.usage.contextTokens).toBe(1_001);
  });

  it('counts a turn even when the CLI reports no usage', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    driver.emit('event', { kind: 'result' } satisfies AgentEvent);
    await waitFor(() => registry.get(info.sessionId)!.usage.turns === 1);
    const u = registry.get(info.sessionId)!.usage;
    expect(u.turns).toBe(1);
    expect(u.inputTokens).toBe(0);
    expect(u.costUsd).toBe(0);
  });

  it('broadcasts the new totals', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    turn({ inputTokens: 1, outputTokens: 2 }, 0.5);
    await waitFor(() => broadcasts.some((m) => m.type === 'session_usage'));
    const msg = broadcasts.find((m) => m.type === 'session_usage');
    expect(msg).toMatchObject({ type: 'session_usage', sessionId: info.sessionId });
  });

  it('survives a restart', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    turn({ inputTokens: 42, outputTokens: 8 }, 0.25);
    // `registry.update` mutates memory synchronously but the file lands after
    // an fsync — the broadcast is the signal that the write completed.
    await waitFor(() => broadcasts.some((m) => m.type === 'session_usage'));

    const reopened = new SessionRegistry(join(dir, 'sessions.json'));
    await reopened.load();
    expect(reopened.get(info.sessionId)!.usage.inputTokens).toBe(42);
    expect(reopened.get(info.sessionId)!.usage.costUsd).toBeCloseTo(0.25, 6);
  });

  it('exposes totals on the board card', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    turn({ inputTokens: 5, outputTokens: 5 }, 0.1);
    await waitFor(() => registry.get(info.sessionId)!.usage.turns === 1);
    const card = mgr.listBoardSessions().find((s) => s.sessionId === info.sessionId)!;
    expect(card.usage.turns).toBe(1);
    expect(card.usage.inputTokens).toBe(5);
  });

  it('backfills totals on entries written before usage existed', async () => {
    await registry.add({
      webSessionId: 'legacy',
      agent: 'claude',
      projectPath: dir,
      transcriptPath: '/t.jsonl',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 1,
      account: null,
      name: null,
      namePinned: false,
      additionalDirs: [],
      status: 'ended',
      phase: 'done',
      phasePinned: false,
      tags: [],
      lastActiveAt: 1,
      endedAt: 1,
      archived: false,
      claudeConfigDir: null,
      headroom: false,
    } as never);

    const reopened = new SessionRegistry(join(dir, 'sessions.json'));
    await reopened.load();
    expect(reopened.get('legacy')!.usage.turns).toBe(0);
  });
});

describe('SessionManager rate limit windows', () => {
  let dir: string;
  let mgr: SessionManager;
  let driver: FakeDriver;
  let broadcasts: ServerMsg[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mrt-rl-'));
    broadcasts = [];
    driver = new FakeDriver();
    mgr = new SessionManager({
      allowedDirs: [dir],
      bufferCap: 100,
      realpath: async (p) => p,
      driverFactory: () => driver,
    });
    mgr.on('broadcast', (m: ServerMsg) => broadcasts.push(m));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const observe = (limitType: string, utilization: number, observedAt = Date.now()): void => {
    driver.emit('event', {
      kind: 'rate_limit',
      window: { limitType, utilization, resetsAt: null, status: null, isUsingOverage: false, observedAt },
    } satisfies AgentEvent);
  };

  it('starts with nothing observed', () => {
    expect(mgr.rateLimitWindows()).toEqual([]);
  });

  it('records and broadcasts a window', async () => {
    await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    observe('seven_day', 0.78);
    expect(mgr.rateLimitWindows()).toHaveLength(1);
    expect(broadcasts.some((m) => m.type === 'rate_limits')).toBe(true);
  });

  it('keeps one entry per limit type, newest wins', async () => {
    await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    observe('seven_day', 0.5, 1000);
    observe('seven_day', 0.9, 2000);
    observe('five_hour', 0.2, 2000);
    const windows = mgr.rateLimitWindows();
    expect(windows).toHaveLength(2);
    expect(windows.find((w) => w.limitType === 'seven_day')!.utilization).toBe(0.9);
  });

  it('ignores an out-of-order observation', async () => {
    await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    observe('seven_day', 0.9, 2000);
    observe('seven_day', 0.5, 1000);
    expect(mgr.rateLimitWindows()[0]!.utilization).toBe(0.9);
  });

  it('keeps quota events out of the transcript and the seq stream', async () => {
    await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    const before = broadcasts.filter((m) => 'seq' in m).length;
    observe('seven_day', 0.78);
    // A rate limit must not consume a seq — a gap would look like a dropped
    // event to the client's replay logic.
    expect(broadcasts.filter((m) => 'seq' in m)).toHaveLength(before);
  });
});
