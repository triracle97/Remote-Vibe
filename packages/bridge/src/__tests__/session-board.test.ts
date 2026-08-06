import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { SessionRegistry, type RegistryEntry } from '../session-registry.js';
import {
  SessionManager,
  deriveSessionName,
  inferPhaseFromEvent,
  type AgentDriver,
} from '../session.js';
import { phaseRank } from '../types.js';
import type { AgentEvent, EffortLevel, ServerMsg, SessionPhase } from '../types.js';

describe('deriveSessionName', () => {
  it('strips a leading slash command so the name is the actual request', () => {
    expect(deriveSessionName('/plan add retry to the fetch helper')).toBe(
      'add retry to the fetch helper',
    );
  });

  it('strips @-file tags', () => {
    expect(deriveSessionName('/plan @src/foo.ts @src/bar.ts add retry')).toBe('add retry');
  });

  it('collapses newlines and runs of whitespace', () => {
    expect(deriveSessionName('fix   the\n\n  parser  bug')).toBe('fix the parser bug');
  });

  it('keeps a bare slash command rather than emptying the name', () => {
    // Stripping would leave nothing; falling back beats naming the card '(empty)'.
    expect(deriveSessionName('/compact')).toBe('/compact');
  });

  it('caps at 60 characters', () => {
    const name = deriveSessionName('x'.repeat(200));
    expect(name).toHaveLength(60);
  });

  it('reports empty input as (empty)', () => {
    expect(deriveSessionName('   \n  ')).toBe('(empty)');
  });
});

describe('inferPhaseFromEvent', () => {
  const toolUse = (toolName: string, input: unknown): AgentEvent => ({
    kind: 'tool_use',
    toolUseId: 't1',
    toolName,
    input,
  });
  // Sessions spawn into `planning`; that is the default context for a signal.
  const infer = (e: AgentEvent, current: SessionPhase = 'planning'): SessionPhase | null =>
    inferPhaseFromEvent(e, current);

  it('treats leaving plan mode as the start of implementation', () => {
    expect(infer(toolUse('ExitPlanMode', {}))).toBe('implementing');
  });

  it('treats file edits as implementation', () => {
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(infer(toolUse(t, { file_path: '/a.ts' }))).toBe('implementing');
    }
  });

  const VERIFY_CMDS = [
    'npm test',
    'npm run typecheck',
    'npx vitest run',
    'pytest -q',
    'cd web && npm run build',
    'cargo test --all',
    'go test ./...',
    'npx eslint src',
  ];

  it('treats test and build commands as verification once work has started', () => {
    for (const command of VERIFY_CMDS) {
      expect(infer(toolUse('Bash', { command }), 'implementing')).toBe('verifying');
    }
  });

  it('treats the same commands as investigation before anything is edited', () => {
    // Running the suite having changed nothing reproduces a bug; it does not
    // verify a fix. Calling that `verifying` was the old false promotion.
    for (const command of VERIFY_CMDS) {
      expect(infer(toolUse('Bash', { command }), 'backlog')).toBe('investigating');
    }
  });

  it('leaves a planning session alone when it runs the suite', () => {
    // `investigating` ranks below `planning`, so the forward-only rule at the
    // call site drops it — the card stays put instead of jumping to verifying.
    const inferred = infer(toolUse('Bash', { command: 'npm test' }), 'planning');
    expect(inferred).toBe('investigating');
    expect(phaseRank(inferred!)).toBeLessThan(phaseRank('planning'));
  });

  it('does not mistake ordinary shell work for verification', () => {
    for (const command of ['git status', 'ls -la', 'cat README.md', 'mkdir tmp']) {
      expect(infer(toolUse('Bash', { command }))).toBeNull();
    }
  });

  it('only calls TodoWrite verification when every item is done', () => {
    const mixed = { todos: [{ status: 'completed' }, { status: 'in_progress' }] };
    const done = { todos: [{ status: 'completed' }, { status: 'completed' }] };
    expect(infer(toolUse('TodoWrite', mixed))).toBeNull();
    expect(infer(toolUse('TodoWrite', done))).toBe('verifying');
    // An empty list is not "all done".
    expect(infer(toolUse('TodoWrite', { todos: [] }))).toBeNull();
  });

  it('says nothing about non-tool events', () => {
    expect(infer({ kind: 'assistant_text', text: 'hi' })).toBeNull();
    expect(infer({ kind: 'result', cost: 1 })).toBeNull();
  });

  it('says nothing about reading a known file', () => {
    // Reading happens in every phase, so it carries no signal.
    expect(infer(toolUse('Read', { file_path: '/a.ts' }))).toBeNull();
  });

  it('treats codebase search as investigation', () => {
    expect(infer(toolUse('Grep', { pattern: 'x' }))).toBe('investigating');
    expect(infer(toolUse('Glob', { pattern: '**/*.ts' }))).toBe('investigating');
  });
});

describe('SessionRegistry migration', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mrt-board-'));
    path = join(dir, 'sessions.json');
  });
  afterEach(async () => {
    // A write can still be draining; ENOTEMPTY here is noise.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('backfills board fields on pre-Phase-8 entries as historical', async () => {
    await writeFile(
      path,
      JSON.stringify({
        sessions: {
          old: {
            webSessionId: 'old',
            agent: 'claude',
            projectPath: '/p',
            transcriptPath: '/t.jsonl',
            claudeSessionId: 'abc',
            codexSessionId: null,
            createdAt: 1000,
            account: null,
            name: 'legacy',
            additionalDirs: [],
          },
        },
      }),
    );
    const reg = new SessionRegistry(path);
    await reg.load();
    const e = reg.get('old')!;
    expect(e.status).toBe('ended');
    expect(e.phase).toBe('backlog');
    expect(e.phasePinned).toBe(false);
    expect(e.tags).toEqual([]);
    expect(e.lastActiveAt).toBe(1000);
    expect(e.endedAt).toBe(1000);
    expect(e.archived).toBe(false);
    expect(e.headroom).toBe(false);
    expect(e.claudeConfigDir).toBeNull();
  });

  it('demotes a persisted `live` entry — nothing survives a bridge restart', async () => {
    await writeFile(
      path,
      JSON.stringify({
        sessions: {
          s: {
            webSessionId: 's',
            agent: 'claude',
            projectPath: '/p',
            transcriptPath: '/t.jsonl',
            claudeSessionId: null,
            codexSessionId: null,
            createdAt: 5,
            account: null,
            name: null,
            additionalDirs: [],
            status: 'live',
            phase: 'implementing',
            phasePinned: false,
            tags: ['a'],
            lastActiveAt: 42,
            endedAt: null,
            archived: false,
            claudeConfigDir: null,
            headroom: true,
          },
        },
      }),
    );
    const reg = new SessionRegistry(path);
    await reg.load();
    const e = reg.get('s')!;
    expect(e.status).toBe('ended');
    expect(e.endedAt).toBe(42);
    // Everything the user set is preserved.
    expect(e.phase).toBe('implementing');
    expect(e.tags).toEqual(['a']);
    expect(e.headroom).toBe(true);
  });

  it('round-trips new fields through persist', async () => {
    const reg = new SessionRegistry(path);
    await reg.load();
    await reg.add(makeEntry({ webSessionId: 'x', tags: ['api', 'bug'], headroom: true }));
    await reg.update('x', { phase: 'verifying', phasePinned: true });
    const raw = JSON.parse(await readFile(path, 'utf8')) as { sessions: Record<string, RegistryEntry> };
    expect(raw.sessions.x!.phase).toBe('verifying');
    expect(raw.sessions.x!.phasePinned).toBe(true);
    expect(raw.sessions.x!.tags).toEqual(['api', 'bug']);
    expect(raw.sessions.x!.headroom).toBe(true);
  });
});

function makeEntry(over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    webSessionId: 'w1',
    agent: 'claude',
    projectPath: '/p',
    transcriptPath: '/t.jsonl',
    claudeSessionId: null,
    codexSessionId: null,
    createdAt: 1,
    account: null,
    name: null,
    additionalDirs: [],
    status: 'ended',
    phase: 'planning',
    phasePinned: false,
    tags: [],
    lastActiveAt: 1,
    endedAt: null,
    archived: false,
    claudeConfigDir: null,
    headroom: false,
    ...over,
  };
}

/** Minimal driver that records kills and lets tests emit agent events. */
class FakeDriver extends EventEmitter implements AgentDriver {
  killed = false;
  applied: Array<{ model?: string; effort?: EffortLevel }> = [];
  sendUserText(): void {}
  applyModelChange(next: { model?: string; effort?: EffortLevel }): void {
    this.applied.push(next);
  }
  kill(): void {
    this.killed = true;
    this.emit('exit', 0);
  }
}

describe('SessionManager board surface', () => {
  let dir: string;
  let registry: SessionRegistry;
  let mgr: SessionManager;
  let drivers: FakeDriver[];
  let broadcasts: ServerMsg[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mrt-board-mgr-'));
    registry = new SessionRegistry(join(dir, 'sessions.json'));
    await registry.load();
    drivers = [];
    mgr = new SessionManager({
      allowedDirs: [dir],
      bufferCap: 100,
      registry,
      realpath: async (p) => p,
      driverFactory: () => {
        const d = new FakeDriver();
        drivers.push(d);
        return d;
      },
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

  it('lists dead sessions the live list cannot see', async () => {
    await registry.add(makeEntry({ webSessionId: 'dead1', name: 'old work', lastActiveAt: 10 }));
    expect(mgr.listSessions()).toHaveLength(0);
    const board = mgr.listBoardSessions();
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ sessionId: 'dead1', name: 'old work', alive: false, status: 'ended' });
  });

  it('marks a claude entry resumable only once its CLI session id is known', async () => {
    await registry.add(makeEntry({ webSessionId: 'a', claudeSessionId: null }));
    await registry.add(makeEntry({ webSessionId: 'b', claudeSessionId: 'uuid' }));
    const byId = new Map(mgr.listBoardSessions().map((s) => [s.sessionId, s]));
    expect(byId.get('a')!.resumable).toBe(false);
    expect(byId.get('b')!.resumable).toBe(true);
  });

  it('sorts most-recently-active first', async () => {
    await registry.add(makeEntry({ webSessionId: 'old', lastActiveAt: 1 }));
    await registry.add(makeEntry({ webSessionId: 'new', lastActiveAt: 99 }));
    expect(mgr.listBoardSessions().map((s) => s.sessionId)).toEqual(['new', 'old']);
  });

  it('hides archived cards unless asked', async () => {
    await registry.add(makeEntry({ webSessionId: 'arch', archived: true }));
    expect(mgr.listBoardSessions()).toHaveLength(0);
    expect(mgr.listBoardSessions({ includeArchived: true })).toHaveLength(1);
  });

  it('reports a live session as alive even if the registry says otherwise', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    const card = mgr.listBoardSessions().find((s) => s.sessionId === info.sessionId)!;
    expect(card.alive).toBe(true);
    expect(card.status).toBe('live');
  });

  it('reports turnRunning only while a turn is open', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    const cardNow = (): boolean =>
      mgr.listBoardSessions().find((s) => s.sessionId === info.sessionId)!.turnRunning;

    // Alive but idle since spawn — the human is up, not the agent.
    expect(cardNow()).toBe(false);

    mgr.sendInput(info.sessionId, 'do the thing');
    expect(cardNow()).toBe(true);

    drivers[0]!.emit('event', { kind: 'assistant_text', text: 'working' } satisfies AgentEvent);
    expect(cardNow()).toBe(true);

    drivers[0]!.emit('event', { kind: 'result', durationMs: 10 } satisfies AgentEvent);
    expect(cardNow()).toBe(false);
  });

  it('never reports turnRunning for a session with no driver', async () => {
    await registry.add(makeEntry({ webSessionId: 'dead1' }));
    expect(mgr.listBoardSessions()[0]!.turnRunning).toBe(false);
  });

  it('pins the phase on a manual move so inference stops fighting the user', async () => {
    await registry.add(makeEntry({ webSessionId: 's', phase: 'planning' }));
    await mgr.setSessionPhase('s', 'backlog');
    const e = registry.get('s')!;
    expect(e.phase).toBe('backlog');
    expect(e.phasePinned).toBe(true);
    expect(broadcasts).toContainEqual({
      type: 'session_phase_changed',
      sessionId: 's',
      phase: 'backlog',
      phasePinned: true,
    });
  });

  it('rejects an unknown phase', async () => {
    await registry.add(makeEntry({ webSessionId: 's' }));
    await expect(mgr.setSessionPhase('s', 'nonsense' as never)).rejects.toThrow(/Unknown session phase/);
  });

  it('stores model and effort, and pushes them to the live driver', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await mgr.setSessionModel(info.sessionId, { model: 'sonnet', effort: 'xhigh' });
    expect(registry.get(info.sessionId)!.model).toBe('sonnet');
    expect(registry.get(info.sessionId)!.effort).toBe('xhigh');
    expect(drivers[0]!.applied).toEqual([{ model: 'sonnet', effort: 'xhigh' }]);
  });

  it('broadcasts the merged result, not just the changed half', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await mgr.setSessionModel(info.sessionId, { model: 'opus' });
    await mgr.setSessionModel(info.sessionId, { effort: 'low' });
    expect(broadcasts).toContainEqual({
      type: 'session_model_changed',
      sessionId: info.sessionId,
      model: 'opus',
      effort: 'low',
    });
  });

  it('leaves the other field alone when only one is given', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await mgr.setSessionModel(info.sessionId, { model: 'opus', effort: 'max' });
    await mgr.setSessionModel(info.sessionId, { effort: 'low' });
    expect(registry.get(info.sessionId)!.model).toBe('opus');
    expect(drivers[0]!.applied[1]).toEqual({ effort: 'low' });
  });

  it('clears back to the CLI default without signalling the driver', async () => {
    // There is no CLI command for "return to your built-in default", so a null
    // is stored for the next spawn and nothing is sent to the running process.
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await mgr.setSessionModel(info.sessionId, { model: 'opus' });
    drivers[0]!.applied.length = 0;
    await mgr.setSessionModel(info.sessionId, { model: null });
    expect(registry.get(info.sessionId)!.model).toBeNull();
    expect(drivers[0]!.applied).toEqual([]);
  });

  it('rejects an unsafe model or unknown effort', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await expect(
      mgr.setSessionModel(info.sessionId, { model: 'opus; id' }),
    ).rejects.toThrow(/Invalid model/);
    await expect(
      mgr.setSessionModel(info.sessionId, { effort: 'turbo' as never }),
    ).rejects.toThrow(/Unknown effort/);
    expect(drivers[0]!.applied).toEqual([]);
  });

  it('accepts a change on a dead session, storing it for the next resume', async () => {
    await registry.add(makeEntry({ webSessionId: 's' }));
    await mgr.setSessionModel('s', { model: 'haiku' });
    expect(registry.get('s')!.model).toBe('haiku');
  });

  it('writes nothing when the patch is empty', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    const before = broadcasts.length;
    await mgr.setSessionModel(info.sessionId, {});
    expect(broadcasts).toHaveLength(before);
  });

  it('rejects mutations on an unknown session', async () => {
    await expect(mgr.setSessionModel('nope', { model: 'opus' })).rejects.toThrow(/session_not_found/);
    await expect(mgr.setSessionPhase('nope', 'done')).rejects.toThrow(/session_not_found/);
    await expect(mgr.setSessionTags('nope', [])).rejects.toThrow(/session_not_found/);
    await expect(mgr.deleteSession('nope')).rejects.toThrow(/session_not_found/);
  });

  it('normalizes tags: trims, dedupes case-insensitively, drops blanks', async () => {
    await registry.add(makeEntry({ webSessionId: 's' }));
    await mgr.setSessionTags('s', ['  api ', 'API', '', 'two words', 'bug']);
    expect(registry.get('s')!.tags).toEqual(['api', 'two-words', 'bug']);
  });

  it('rejects oversized and control-character tags', async () => {
    await registry.add(makeEntry({ webSessionId: 's' }));
    await expect(mgr.setSessionTags('s', ['x'.repeat(41)])).rejects.toThrow(/too long/);
    await expect(mgr.setSessionTags('s', ['a\x00b'])).rejects.toThrow(/control characters/);
    await expect(
      mgr.setSessionTags('s', Array.from({ length: 21 }, (_, i) => `t${i}`)),
    ).rejects.toThrow(/at most 20 tags/);
  });

  it('kills the driver and drops the entry on delete', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await mgr.deleteSession(info.sessionId);
    expect(drivers[0]!.killed).toBe(true);
    expect(registry.get(info.sessionId)).toBeUndefined();
    expect(broadcasts).toContainEqual({ type: 'session_deleted', sessionId: info.sessionId });
  });

  it('advances the phase forward on an implementation signal', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    expect(registry.get(info.sessionId)!.phase).toBe('planning');
    drivers[0]!.emit('event', {
      kind: 'tool_use',
      toolUseId: 't',
      toolName: 'ExitPlanMode',
      input: {},
    } satisfies AgentEvent);
    await waitFor(() => registry.get(info.sessionId)!.phase === 'implementing');
    expect(registry.get(info.sessionId)!.phase).toBe('implementing');
  });

  it('never moves the phase backwards on its own', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    const emit = (toolName: string, input: unknown): void => {
      drivers[0]!.emit('event', { kind: 'tool_use', toolUseId: 't', toolName, input });
    };
    emit('Edit', { file_path: '/a.ts' });
    await waitFor(() => registry.get(info.sessionId)!.phase === 'implementing');
    emit('Bash', { command: 'npm test' });
    await waitFor(() => registry.get(info.sessionId)!.phase === 'verifying');
    // A later edit must not drag it back to `implementing`.
    emit('Edit', { file_path: '/a.ts' });
    await flush(50);
    expect(registry.get(info.sessionId)!.phase).toBe('verifying');
  });

  it('stops inferring once the phase is pinned', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await mgr.setSessionPhase(info.sessionId, 'backlog');
    drivers[0]!.emit('event', {
      kind: 'tool_use',
      toolUseId: 't',
      toolName: 'ExitPlanMode',
      input: {},
    } satisfies AgentEvent);
    await flush();
    expect(registry.get(info.sessionId)!.phase).toBe('backlog');
  });

  it('marks the session ended and done when the driver exits', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    drivers[0]!.emit('exit', 0);
    await waitFor(() => registry.get(info.sessionId)!.status === 'ended');
    const e = registry.get(info.sessionId)!;
    expect(e.status).toBe('ended');
    expect(e.endedAt).not.toBeNull();
    expect(e.phase).toBe('done');
  });

  it('respects a pinned phase even at end of life', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await mgr.setSessionPhase(info.sessionId, 'planning');
    drivers[0]!.emit('exit', 0);
    await waitFor(() => registry.get(info.sessionId)!.status === 'ended');
    const e = registry.get(info.sessionId)!;
    expect(e.status).toBe('ended');
    expect(e.phase).toBe('planning');
  });

  it('carries the session name on the live list so a page reload keeps it', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await mgr.handleInput(info.sessionId, '/plan @a.ts wire up the board');
    expect(mgr.listSessions()[0]!.name).toBe('wire up the board');
  });

  it('records the config dir and headroom flag used for the spawn', async () => {
    const withHeadroom = new SessionManager({
      allowedDirs: [dir],
      bufferCap: 100,
      registry,
      realpath: async (p) => p,
      claudeConfigs: new Map([
        [
          'alt',
          { name: 'alt', configDir: '/Users/test/.claude1', isDefault: false, inheritEnv: false },
        ],
      ]),
      resolveHeadroom: async () => ({ bin: 'headroom', port: 8787 }),
      driverFactory: () => new FakeDriver(),
    });
    const info = await withHeadroom.spawnSession({
      agent: 'claude',
      dirs: [dir],
      claudeConfig: 'alt',
    });
    const e = registry.get(info.sessionId)!;
    expect(e.claudeConfigDir).toBe('/Users/test/.claude1');
    expect(e.headroom).toBe(true);
  });

  it('fails the spawn on an unknown claude profile rather than using the wrong one', async () => {
    const m = new SessionManager({
      allowedDirs: [dir],
      bufferCap: 100,
      registry,
      realpath: async (p) => p,
      claudeConfigs: new Map([
        [
          'default',
          { name: 'default', configDir: '/Users/test/.claude', isDefault: true, inheritEnv: true },
        ],
      ]),
      driverFactory: () => new FakeDriver(),
    });
    await expect(
      m.spawnSession({ agent: 'claude', dirs: [dir], claudeConfig: 'typo' }),
    ).rejects.toThrow(/Unknown Claude config profile/);
  });

  it('spawns the unpinned default with no CLAUDE_CONFIG_DIR at all', async () => {
    // Exporting ~/.claude explicitly makes Claude Code look in the
    // `Claude Code-credentials-<sha256(dir)>` keychain slot rather than the
    // plain one a terminal login writes, which is what made every default
    // session report "you need to log in".
    const spawnArgs: Array<{ claudeConfigDir?: string }> = [];
    const m = new SessionManager({
      allowedDirs: [dir],
      bufferCap: 100,
      registry,
      realpath: async (p) => p,
      claudeConfigs: new Map([
        [
          'default',
          { name: 'default', configDir: '/Users/test/.claude', isDefault: true, inheritEnv: true },
        ],
      ]),
      driverFactory: (args) => {
        spawnArgs.push({ ...(args.claudeConfigDir ? { claudeConfigDir: args.claudeConfigDir } : {}) });
        return new FakeDriver();
      },
    });
    const info = await m.spawnSession({ agent: 'claude', dirs: [dir], claudeConfig: 'default' });
    expect(spawnArgs[0]!.claudeConfigDir).toBeUndefined();
    expect(registry.get(info.sessionId)!.claudeConfigDir).toBeNull();
  });
});

/** Let the fire-and-forget registry writes inside event handlers settle. */
function flush(ms = 10): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Poll until `cond` holds. Phase changes land only after an fsync'd registry
 * write, so a fixed sleep is racy once the suite runs under parallel load.
 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await flush(5);
  }
  throw new Error('waitFor timed out');
}
