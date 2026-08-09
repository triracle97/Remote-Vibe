import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import {
  cliEffortLevel,
  EFFORT_LEVELS,
  isEffortLevel,
  isUltracode,
  isValidModelId,
  modelLabel,
  modelsFor,
  parseEffortLevel,
  parseModelId,
  resolveSetting,
  supportsUltracode,
} from '../models.js';
import { ClaudeProcess } from '../claude-process.js';
import { CodexProcess } from '../codex-process.js';

describe('effort levels', () => {
  it('matches the levels the CLI documents, plus the mode it offers alongside them', () => {
    // `claude --help`: "--effort <level>  Effort level ... (low, medium, high, xhigh, max)".
    // `ultracode` is not one of them — it is a mode Claude Code's own /config
    // puts in the same row, and this list is that row.
    expect(EFFORT_LEVELS.map((e) => e.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ]);
  });

  it('runs ultracode at xhigh and everything else at itself', () => {
    // `--effort ultracode` is a plain alias for xhigh in the CLI and turns the
    // mode off, so the flag and the mode have to be resolved separately.
    expect(cliEffortLevel('ultracode')).toBe('xhigh');
    expect(cliEffortLevel('max')).toBe('max');
    expect(isUltracode('ultracode')).toBe(true);
    expect(isUltracode('xhigh')).toBe(false);
    expect(isUltracode(null)).toBe(false);
  });

  it('rules out models that cannot reach xhigh', () => {
    // The CLI names Fable 5, Opus 4.7+ and Sonnet 5. Of the aliases offered
    // here only Haiku is out, and null means the CLI's own default.
    expect(supportsUltracode('opus')).toBe(true);
    expect(supportsUltracode('sonnet')).toBe(true);
    expect(supportsUltracode('fable')).toBe(true);
    expect(supportsUltracode(null)).toBe(true);
    expect(supportsUltracode('haiku')).toBe(false);
    expect(supportsUltracode('claude-haiku-4-5-20251001')).toBe(false);
  });

  it('accepts every documented level', () => {
    for (const { value } of EFFORT_LEVELS) expect(isEffortLevel(value)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of ['HIGH', 'extreme', '', null, undefined, 3]) {
      expect(isEffortLevel(bad)).toBe(false);
      expect(parseEffortLevel(bad)).toBeNull();
    }
  });
});

describe('model ids', () => {
  it('offers only aliases for Claude, so the list never goes stale', () => {
    expect(modelsFor('claude').map((m) => m.value)).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
  });

  it('accepts aliases, full ids and the extended-context spelling', () => {
    for (const ok of ['opus', 'sonnet', 'claude-opus-5', 'gpt-5-codex', 'opus[1m]']) {
      expect(isValidModelId(ok)).toBe(true);
    }
  });

  it('rejects anything that could break out of a shell command', () => {
    for (const bad of ['opus; rm -rf /', 'opus $(id)', 'opus`id`', 'a b', 'opus|tee', "o'pus"]) {
      expect(isValidModelId(bad)).toBe(false);
      expect(parseModelId(bad)).toBeNull();
    }
  });

  it('trims but does not invent a value', () => {
    expect(parseModelId('  opus  ')).toBe('opus');
    expect(parseModelId('   ')).toBeNull();
    expect(parseModelId(undefined)).toBeNull();
  });

  it('caps the length', () => {
    expect(isValidModelId('x'.repeat(64))).toBe(true);
    expect(isValidModelId('x'.repeat(65))).toBe(false);
  });

  it('labels a known model, and falls back to the raw id', () => {
    expect(modelLabel('claude', 'opus')).toBe('Opus');
    expect(modelLabel('claude', 'claude-opus-5')).toBe('claude-opus-5');
  });
});

describe('resolveSetting', () => {
  it('prefers the per-session value', () => {
    expect(resolveSetting('sonnet', 'opus')).toBe('sonnet');
  });

  it('falls back to the app default', () => {
    expect(resolveSetting(null, 'opus')).toBe('opus');
  });

  it('returns null when neither is set, so the flag is omitted', () => {
    // Omitting beats guessing: the CLI then applies its own default.
    expect(resolveSetting(null, null)).toBeNull();
    expect(resolveSetting(undefined, undefined)).toBeNull();
  });

  it('does not treat a falsy-but-present value as absent', () => {
    expect(resolveSetting(0, 9)).toBe(0);
    expect(resolveSetting('', 'opus')).toBe('');
  });
});

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    kill: (s: NodeJS.Signals) => boolean;
    pid: number;
  };
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  child.kill = vi.fn().mockReturnValue(true);
  child.pid = 999;
  return child;
}

const claudeCmd = (spawn: ReturnType<typeof vi.fn>): string =>
  (spawn.mock.calls[0]![1] as string[])[2]!;

describe('ClaudeProcess model/effort flags', () => {
  it('passes both through', () => {
    const spawn = vi.fn().mockReturnValue(makeFakeChild());
    new ClaudeProcess('/proj', { spawn, model: 'opus', effort: 'xhigh' });
    const cmd = claudeCmd(spawn);
    expect(cmd).toContain(`--model 'opus'`);
    expect(cmd).toContain('--effort xhigh');
  });

  it('omits each flag independently when unset', () => {
    const spawn = vi.fn().mockReturnValue(makeFakeChild());
    new ClaudeProcess('/proj', { spawn, effort: 'low' });
    const cmd = claudeCmd(spawn);
    expect(cmd).not.toContain('--model');
    expect(cmd).toContain('--effort low');
  });

  it('puts them before the -p flags, not after', () => {
    const spawn = vi.fn().mockReturnValue(makeFakeChild());
    new ClaudeProcess('/proj', { spawn, model: 'sonnet' });
    const cmd = claudeCmd(spawn);
    expect(cmd.indexOf('--model')).toBeLessThan(cmd.indexOf('-p '));
  });

  it('quotes the model so the extended-context spelling survives', () => {
    // `opus[1m]` contains glob characters; unquoted, zsh would try to expand it.
    const spawn = vi.fn().mockReturnValue(makeFakeChild());
    new ClaudeProcess('/proj', { spawn, model: 'opus[1m]' });
    expect(claudeCmd(spawn)).toContain(`--model 'opus[1m]'`);
  });

  it('refuses a model id that could inject shell', () => {
    const spawn = vi.fn().mockReturnValue(makeFakeChild());
    expect(() => new ClaudeProcess('/proj', { spawn, model: 'opus; id' })).toThrow(/unsafe model/);
  });

  it('refuses an unknown effort level', () => {
    const spawn = vi.fn().mockReturnValue(makeFakeChild());
    expect(
      () => new ClaudeProcess('/proj', { spawn, effort: 'extreme' as never }),
    ).toThrow(/unknown effort/);
  });

  it('applyModelChange writes the slash commands to the live stdin', () => {
    // Verified against claude 2.x: a session spawned --model haiku reported
    // claude-sonnet-5 on the turn after `/model sonnet`.
    const child = makeFakeChild();
    const written: string[] = [];
    child.stdin = new Writable({
      write(chunk, _e, cb) {
        written.push(String(chunk));
        cb();
      },
    });
    const spawn = vi.fn().mockReturnValue(child);
    const proc = new ClaudeProcess('/proj', { spawn });
    proc.applyModelChange({ model: 'sonnet', effort: 'max' });
    const texts = written.map((w) => JSON.parse(w).message.content[0].text);
    expect(texts).toEqual(['/model sonnet', '/effort max']);
  });

  it('applyModelChange sends only what changed', () => {
    const child = makeFakeChild();
    const written: string[] = [];
    child.stdin = new Writable({
      write(chunk, _e, cb) {
        written.push(String(chunk));
        cb();
      },
    });
    const spawn = vi.fn().mockReturnValue(child);
    new ClaudeProcess('/proj', { spawn }).applyModelChange({ effort: 'low' });
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!).message.content[0].text).toBe('/effort low');
  });

  it('applyModelChange rejects an unsafe model rather than writing it', () => {
    const child = makeFakeChild();
    const written: string[] = [];
    child.stdin = new Writable({
      write(chunk, _e, cb) {
        written.push(String(chunk));
        cb();
      },
    });
    const spawn = vi.fn().mockReturnValue(child);
    const proc = new ClaudeProcess('/proj', { spawn });
    expect(() => proc.applyModelChange({ model: '/effort max\n/model evil' })).toThrow(/unsafe model/);
    expect(written).toHaveLength(0);
  });
});

describe('CodexProcess model/effort flags', () => {
  const spawnFor = (opts: { model?: string; effort?: 'low' | 'max' }) => {
    const spawn = vi.fn().mockReturnValue(makeFakeChild());
    const proc = new CodexProcess({
      projectPath: '/proj',
      codexHome: '/home/.codex',
      spawn,
      ...opts,
    });
    return { spawn, proc };
  };

  it('passes --model and the reasoning-effort config override', () => {
    const { spawn, proc } = spawnFor({ model: 'gpt-5-codex', effort: 'low' });
    proc.sendUserText('hi');
    const args = spawn.mock.calls[0]![1] as string[];
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5-codex');
    expect(args).toContain('model_reasoning_effort=low');
  });

  it('omits both when unset', () => {
    const { spawn, proc } = spawnFor({});
    proc.sendUserText('hi');
    const args = spawn.mock.calls[0]![1] as string[];
    expect(args).not.toContain('--model');
    expect(args.join(' ')).not.toContain('model_reasoning_effort');
  });

  it('applyModelChange takes effect on the next turn, since codex respawns', () => {
    const { spawn, proc } = spawnFor({ model: 'gpt-5' });
    proc.sendUserText('first');
    proc.applyModelChange({ model: 'gpt-5-codex', effort: 'max' });
    proc.sendUserText('second');
    const second = spawn.mock.calls[1]![1] as string[];
    expect(second[second.indexOf('--model') + 1]).toBe('gpt-5-codex');
    expect(second).toContain('model_reasoning_effort=max');
  });

  it('applyModelChange validates before storing', () => {
    const { proc } = spawnFor({});
    expect(() => proc.applyModelChange({ model: 'gpt`id`' })).toThrow(/unsafe model/);
    expect(() => proc.applyModelChange({ effort: 'turbo' as never })).toThrow(/unknown effort/);
  });
});
