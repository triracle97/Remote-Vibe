import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { HeadroomProxy, headroomConfigFromEnv } from '../headroom.js';
import { ClaudeProcess, buildClaudeCommand } from '../claude-process.js';
import { CodexProcess, buildCodexSpawn } from '../codex-process.js';

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    kill: (s: NodeJS.Signals) => boolean;
    pid: number;
    exitCode: number | null;
  };
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  child.kill = vi.fn().mockReturnValue(true);
  child.pid = 4321;
  child.exitCode = null;
  return child;
}

const FLAGS =
  '-p --dangerously-skip-permissions --output-format stream-json ' +
  '--input-format stream-json --include-partial-messages --verbose';

describe('buildClaudeCommand', () => {
  it('execs claude directly when headroom is off', () => {
    expect(buildClaudeCommand({ claudeFlags: FLAGS })).toBe(`exec claude ${FLAGS}`);
  });

  it('wraps with headroom, keeping the proxy shared and the config untouched', () => {
    const cmd = buildClaudeCommand({
      claudeFlags: FLAGS,
      headroom: { bin: 'headroom', port: 8787 },
    });
    expect(cmd).toBe(
      'exec headroom wrap claude --port 8787 --no-proxy --no-mcp --no-serena --no-rtk ' +
        `-- ${FLAGS}`,
    );
  });

  it('puts every claude flag after `--`', () => {
    // headroom's own -p/--port and -v/--verbose collide with claude's -p and
    // --verbose. Without the separator, Click eats them and the spawn fails.
    const cmd = buildClaudeCommand({
      claudeFlags: FLAGS,
      headroom: { bin: 'headroom', port: 8787 },
    });
    const [head, tail] = cmd.split(' -- ');
    expect(head).not.toContain('-p ');
    expect(head).not.toContain('--verbose');
    expect(tail).toContain('-p ');
    expect(tail).toContain('--verbose');
  });

  it('rejects a headroom binary with shell metacharacters', () => {
    expect(() =>
      buildClaudeCommand({
        claudeFlags: FLAGS,
        headroom: { bin: 'headroom; rm -rf /', port: 8787 },
      }),
    ).toThrow(/unsafe resume arg token/);
  });
});

describe('ClaudeProcess env + spawn shape', () => {
  it('exports CLAUDE_CONFIG_DIR when a profile dir is given', () => {
    const spawn = vi.fn().mockReturnValue(makeFakeChild());
    new ClaudeProcess('/Users/test/proj', {
      spawn,
      claudeConfigDir: '/Users/test/.claude1',
    });
    const opts = spawn.mock.calls[0]![2] as { env: Record<string, string> };
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe('/Users/test/.claude1');
  });

  it('injects nothing when unset, inheriting whatever the bridge process has', () => {
    const spawn = vi.fn().mockReturnValue(makeFakeChild());
    new ClaudeProcess('/Users/test/proj', { spawn });
    const opts = spawn.mock.calls[0]![2] as { env: Record<string, string> };
    // Not asserting absence: the bridge itself may legitimately be running
    // under a CLAUDE_CONFIG_DIR, and inheriting it is the correct default.
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
  });

  it('rejects a config dir with shell metacharacters', () => {
    const spawn = vi.fn().mockReturnValue(makeFakeChild());
    expect(
      () =>
        new ClaudeProcess('/Users/test/proj', {
          spawn,
          claudeConfigDir: '/Users/test/.claude1; curl evil.sh',
        }),
    ).toThrow(/unsafe resume arg token/);
  });

  it('spawns detached so kill() can reach claude under the headroom wrapper', () => {
    const spawn = vi.fn().mockReturnValue(makeFakeChild());
    new ClaudeProcess('/Users/test/proj', {
      spawn,
      headroom: { bin: 'headroom', port: 8787 },
    });
    const opts = spawn.mock.calls[0]![2] as { detached?: boolean };
    expect(opts.detached).toBe(true);
  });

  it('signals the process group, not just the direct child', () => {
    const child = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const proc = new ClaudeProcess('/Users/test/proj', { spawn });
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      proc.kill();
      expect(kill).toHaveBeenCalledWith(-4321, 'SIGTERM');
    } finally {
      kill.mockRestore();
    }
  });

  it('falls back to the direct child when the group is already gone', () => {
    const child = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const proc = new ClaudeProcess('/Users/test/proj', { spawn });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    try {
      proc.kill();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      kill.mockRestore();
    }
  });
});

describe('headroomConfigFromEnv', () => {
  it('defaults to enabled on port 8787', () => {
    expect(headroomConfigFromEnv({})).toEqual({
      enabled: true,
      bin: 'headroom',
      port: 8787,
    });
  });

  it('accepts the usual falsy spellings', () => {
    for (const v of ['false', 'FALSE', '0', 'no', 'off']) {
      expect(headroomConfigFromEnv({ BRIDGE_HEADROOM_ENABLED: v }).enabled).toBe(false);
    }
  });

  it('honours an absolute binary path', () => {
    const cfg = headroomConfigFromEnv({
      BRIDGE_HEADROOM_BIN: '/Users/test/.pyenv/versions/3.11.9/bin/headroom',
    });
    expect(cfg.bin).toBe('/Users/test/.pyenv/versions/3.11.9/bin/headroom');
  });

  it('rejects a nonsense port', () => {
    expect(() => headroomConfigFromEnv({ BRIDGE_HEADROOM_PORT: 'abc' })).toThrow(
      /positive integer/,
    );
  });
});

describe('HeadroomProxy', () => {
  const noSleep = (): Promise<void> => Promise.resolve();

  it('reuses a proxy that is already listening and never spawns', async () => {
    const spawn = vi.fn();
    const proxy = new HeadroomProxy({
      enabled: true,
      bin: 'headroom',
      port: 8787,
      spawn: spawn as never,
      fetch: vi.fn().mockResolvedValue({ status: 200 }) as never,
      sleep: noSleep,
    });
    expect(await proxy.ensure()).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(proxy.spawnConfig()).toEqual({ bin: 'headroom', port: 8787 });
  });

  it('never kills a proxy it did not start', async () => {
    const proxy = new HeadroomProxy({
      enabled: true,
      bin: 'headroom',
      port: 8787,
      spawn: vi.fn() as never,
      fetch: vi.fn().mockResolvedValue({ status: 200 }) as never,
      sleep: noSleep,
    });
    await proxy.ensure();
    await proxy.stop();
    expect(proxy.isReady()).toBe(false);
  });

  it('starts a proxy when none answers, then reports ready', async () => {
    const child = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    let probes = 0;
    const proxy = new HeadroomProxy({
      enabled: true,
      bin: 'headroom',
      port: 9999,
      spawn: spawn as never,
      // First probe fails (nothing listening), second succeeds (it booted).
      fetch: vi.fn().mockImplementation(() => {
        probes += 1;
        return probes === 1 ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve({ status: 200 });
      }) as never,
      sleep: noSleep,
    });
    expect(await proxy.ensure()).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      'headroom',
      ['proxy', '--port', '9999'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('degrades to unwrapped instead of throwing when the proxy never boots', async () => {
    const child = makeFakeChild();
    const proxy = new HeadroomProxy({
      enabled: true,
      bin: 'headroom',
      port: 9999,
      spawn: vi.fn().mockReturnValue(child) as never,
      fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never,
      sleep: noSleep,
      startupTimeoutMs: 1,
    });
    expect(await proxy.ensure()).toBe(false);
    expect(proxy.spawnConfig()).toBeNull();
  });

  it('gives up early when the proxy child dies during startup', async () => {
    const child = makeFakeChild();
    child.exitCode = 1;
    const proxy = new HeadroomProxy({
      enabled: true,
      bin: 'headroom',
      port: 9999,
      spawn: vi.fn().mockReturnValue(child) as never,
      fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never,
      sleep: noSleep,
      startupTimeoutMs: 60_000,
    });
    expect(await proxy.ensure()).toBe(false);
  });

  it('is a no-op when disabled', async () => {
    const spawn = vi.fn();
    const proxy = new HeadroomProxy({
      enabled: false,
      bin: 'headroom',
      port: 8787,
      spawn: spawn as never,
      fetch: vi.fn() as never,
      sleep: noSleep,
    });
    expect(await proxy.ensure()).toBe(false);
    expect(proxy.spawnConfig()).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('collapses concurrent ensure() calls into one startup', async () => {
    const child = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const proxy = new HeadroomProxy({
      enabled: true,
      bin: 'headroom',
      port: 9999,
      spawn: spawn as never,
      fetch: vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValue({ status: 200 }) as never,
      sleep: noSleep,
    });
    const [a, b, c] = await Promise.all([proxy.ensure(), proxy.ensure(), proxy.ensure()]);
    expect([a, b, c]).toEqual([true, true, true]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('buildCodexSpawn', () => {
  const CODEX_ARGS = ['exec', '--json', '-C', '/Users/test/proj', 'hello'];

  it('spawns codex directly when headroom is off', () => {
    expect(buildCodexSpawn({ codexArgs: CODEX_ARGS })).toEqual({
      cmd: 'codex',
      args: CODEX_ARGS,
    });
  });

  it('wraps with headroom, keeping the proxy shared and the codex config untouched', () => {
    expect(
      buildCodexSpawn({ codexArgs: CODEX_ARGS, headroom: { bin: 'headroom', port: 8787 } }),
    ).toEqual({
      cmd: 'headroom',
      args: [
        'wrap',
        'codex',
        '--port',
        '8787',
        '--no-proxy',
        '--no-mcp',
        '--no-serena',
        '--no-rtk',
        '--',
        ...CODEX_ARGS,
      ],
    });
  });

  it('puts every codex arg after the -- separator', () => {
    // headroom's own -p/--port and -v/--verbose are real Click options; without
    // the separator they would swallow codex's args before codex saw them.
    const { args } = buildCodexSpawn({
      codexArgs: CODEX_ARGS,
      headroom: { bin: 'headroom', port: 8787 },
    });
    const sep = args.indexOf('--');
    expect(sep).toBeGreaterThan(0);
    expect(args.slice(sep + 1)).toEqual(CODEX_ARGS);
  });

  it('accepts an absolute headroom path', () => {
    const bin = '/Users/test/.pyenv/versions/3.11.9/bin/headroom';
    expect(buildCodexSpawn({ codexArgs: CODEX_ARGS, headroom: { bin, port: 9999 } }).cmd).toBe(bin);
  });

  it('rejects a headroom binary with shell metacharacters', () => {
    expect(() =>
      buildCodexSpawn({ codexArgs: CODEX_ARGS, headroom: { bin: 'headroom; rm -rf /', port: 8787 } }),
    ).toThrow(/unsafe headroom bin/);
  });
});

describe('CodexProcess under headroom', () => {
  const BASE = { projectPath: '/Users/test/proj', codexHome: '/Users/test/.codex' };

  it('spawns the wrapper instead of codex, and detached so kill reaches the tree', () => {
    const child = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const proc = new CodexProcess({
      ...BASE,
      headroom: { bin: 'headroom', port: 8787 },
      spawn: spawn as never,
    });
    proc.sendUserText('hi');

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawn.mock.calls[0]!;
    expect(cmd).toBe('headroom');
    expect(args.slice(0, 3)).toEqual(['wrap', 'codex', '--port']);
    expect(args[args.indexOf('--') + 1]).toBe('exec');
    // Under the wrapper codex is a grandchild of a Python process that does not
    // forward SIGTERM; without its own process group a stop would orphan it.
    expect(options.detached).toBe(true);
    // stdin must still be ignored, or codex exec waits for EOF forever.
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('spawns bare codex when headroom is absent', () => {
    const child = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const proc = new CodexProcess({ ...BASE, spawn: spawn as never });
    proc.sendUserText('hi');
    expect(spawn.mock.calls[0]![0]).toBe('codex');
  });

  it('kill() signals the process group so the wrapped agent dies with it', () => {
    const child = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const proc = new CodexProcess({
        ...BASE,
        headroom: { bin: 'headroom', port: 8787 },
        spawn: spawn as never,
      });
      proc.sendUserText('hi');
      proc.kill();
      expect(killSpy).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('falls back to the direct child when the group is already gone', () => {
    const child = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(child);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const e = new Error('no such process') as NodeJS.ErrnoException;
      e.code = 'ESRCH';
      throw e;
    });
    try {
      const proc = new CodexProcess({
        ...BASE,
        headroom: { bin: 'headroom', port: 8787 },
        spawn: spawn as never,
      });
      proc.sendUserText('hi');
      proc.kill();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      killSpy.mockRestore();
    }
  });
});
