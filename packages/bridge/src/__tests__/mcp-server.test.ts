import { describe, it, expect, vi } from 'vitest';
import { spawnSessionTool, type McpDeps } from '../mcp-server.js';
import type { AgentKind } from '../types.js';

interface FakeEntry {
  projectPath: string;
  parentSessionId: string | null;
  name: string | null;
}

function makeDeps(
  overrides: {
    sessions?: Record<string, FakeEntry>;
    childCount?: number;
  } = {},
): McpDeps & {
  spawned: Array<Record<string, unknown>>;
  prompts: Array<{ sessionId: string; text: string }>;
} {
  const sessions = overrides.sessions ?? {
    parent: { projectPath: '/Users/me/proj', parentSessionId: null, name: 'Parent work' },
  };
  const spawned: Array<Record<string, unknown>> = [];
  const prompts: Array<{ sessionId: string; text: string }> = [];
  let n = 0;
  return {
    spawned,
    prompts,
    spawnSession: async (o) => {
      spawned.push({ ...o });
      n += 1;
      return { sessionId: `child-${n}` };
    },
    sendUserText: (sessionId, text) => {
      prompts.push({ sessionId, text });
    },
    lookupSession: (id) => sessions[id],
    countChildren: () => overrides.childCount ?? 0,
  };
}

const BASE = { agent: 'codex' as AgentKind, prompt: 'port the parser tests' };

describe('spawn_session tool', () => {
  it('spawns in the caller’s directory and delivers the prompt', async () => {
    const deps = makeDeps();
    const out = await spawnSessionTool(deps, 'parent', BASE);

    expect(out.sessionId).toBe('child-1');
    expect(deps.spawned).toHaveLength(1);
    expect(deps.spawned[0]).toMatchObject({
      agent: 'codex',
      dirs: ['/Users/me/proj'],
      parentSessionId: 'parent',
    });
    expect(deps.prompts).toEqual([{ sessionId: 'child-1', text: 'port the parser tests' }]);
  });

  it('always uses the default codex account', async () => {
    const deps = makeDeps();
    await spawnSessionTool(deps, 'parent', BASE);
    // Choosing between named accounts is a human decision, not the agent's.
    expect(deps.spawned[0]!.account).toBe('default');
  });

  it('does not force an account for a spawned claude session', async () => {
    const deps = makeDeps();
    await spawnSessionTool(deps, 'parent', { ...BASE, agent: 'claude' });
    expect(deps.spawned[0]!.account).toBeUndefined();
  });

  it('honours an explicit projectPath', async () => {
    const deps = makeDeps();
    await spawnSessionTool(deps, 'parent', { ...BASE, projectPath: '/Users/me/other' });
    expect(deps.spawned[0]!.dirs).toEqual(['/Users/me/other']);
  });

  it('refuses when there is no calling session', async () => {
    const deps = makeDeps();
    await expect(spawnSessionTool(deps, null, BASE)).rejects.toThrow(/only callable from inside/i);
    expect(deps.spawned).toHaveLength(0);
  });

  it('refuses an unknown caller', async () => {
    const deps = makeDeps();
    await expect(spawnSessionTool(deps, 'ghost', BASE)).rejects.toThrow(/unknown calling session/i);
    expect(deps.spawned).toHaveLength(0);
  });

  it('refuses to nest: a spawned session cannot spawn', async () => {
    // A spawned agent that can spawn is a fork bomb with a model picking the
    // branching factor.
    const deps = makeDeps({
      sessions: {
        child: { projectPath: '/Users/me/proj', parentSessionId: 'parent', name: null },
      },
    });
    await expect(spawnSessionTool(deps, 'child', BASE)).rejects.toThrow(/nested spawning/i);
    expect(deps.spawned).toHaveLength(0);
  });

  it('enforces the per-parent ceiling', async () => {
    const deps = makeDeps({ childCount: 5 });
    await expect(spawnSessionTool(deps, 'parent', BASE)).rejects.toThrow(/limit 5/);
    expect(deps.spawned).toHaveLength(0);
  });

  it('allows one more when just under the ceiling', async () => {
    const deps = makeDeps({ childCount: 4 });
    await expect(spawnSessionTool(deps, 'parent', BASE)).resolves.toBeTruthy();
  });

  it('requires a non-empty prompt', async () => {
    const deps = makeDeps();
    await expect(spawnSessionTool(deps, 'parent', { ...BASE, prompt: '   ' })).rejects.toThrow(
      /prompt is required/i,
    );
    expect(deps.spawned).toHaveLength(0);
  });

  it('rejects a shell-unsafe model id before spawning anything', async () => {
    // `isValidModelId` gates on shape, not on a list of known models — the CLI
    // decides what is real. What must never get through is anything that could
    // break out of the `exec claude ...` command line.
    const deps = makeDeps();
    await expect(
      spawnSessionTool(deps, 'parent', { ...BASE, model: 'opus; rm -rf /' }),
    ).rejects.toThrow(/unknown model/i);
    expect(deps.spawned).toHaveLength(0);
  });

  it('passes an unrecognised but well-formed model straight through', async () => {
    const deps = makeDeps();
    await spawnSessionTool(deps, 'parent', { ...BASE, model: 'claude-opus-5[1m]' });
    expect(deps.spawned[0]!.model).toBe('claude-opus-5[1m]');
  });

  it('rejects an unknown effort level', async () => {
    const deps = makeDeps();
    await expect(
      spawnSessionTool(deps, 'parent', { ...BASE, effort: 'extreme' }),
    ).rejects.toThrow(/unknown effort/i);
    expect(deps.spawned).toHaveLength(0);
  });

  it('does not send a prompt when the spawn itself fails', async () => {
    const deps = makeDeps();
    deps.spawnSession = vi.fn().mockRejectedValue(new Error('path outside allowlist'));
    await expect(spawnSessionTool(deps, 'parent', BASE)).rejects.toThrow(/outside allowlist/);
    expect(deps.prompts).toHaveLength(0);
  });
});
