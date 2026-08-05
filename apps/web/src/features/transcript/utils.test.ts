import { describe, it, expect } from 'vitest';
import {
  formatCount,
  formatElapsed,
  formatToolName,
  outputToText,
  shortenPath,
  summarizeToolInput,
  toProjectRelative,
  unwrapShellCommand,
} from './utils';

describe('unwrapShellCommand', () => {
  it('strips a unix login-shell wrapper', () => {
    expect(unwrapShellCommand(`/bin/zsh -lc "sed -n '1,20p' a.ts"`)).toBe(`sed -n '1,20p' a.ts`);
    expect(unwrapShellCommand(`bash -c 'echo hi'`)).toBe('echo hi');
    expect(unwrapShellCommand(`/usr/bin/sh -lc "ls"`)).toBe('ls');
  });

  it('joins an argv array before unwrapping', () => {
    expect(unwrapShellCommand(['/bin/zsh', '-lc', 'git status'])).toBe('git status');
  });

  it('unwraps a nested windows wrapper', () => {
    const cmd = `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'bash -lc "cat a.md"'`;
    expect(unwrapShellCommand(cmd)).toBe('cat a.md');
  });

  it('unwraps cmd.exe', () => {
    expect(unwrapShellCommand(`cmd.exe /c "echo hello"`)).toBe('echo hello');
  });

  it('leaves an unwrapped command alone', () => {
    expect(unwrapShellCommand('npm test')).toBe('npm test');
  });

  it('does not choke on non-strings', () => {
    expect(unwrapShellCommand(undefined)).toBe('');
    expect(unwrapShellCommand(42)).toBe('42');
  });
});

describe('formatToolName', () => {
  it('strips the MCP prefix and underscores', () => {
    expect(formatToolName('mcp__github__create_issue')).toBe('create issue');
    expect(formatToolName('TodoWrite')).toBe('TodoWrite');
  });
});

describe('shortenPath', () => {
  it('elides all but the tail', () => {
    expect(shortenPath('/a/b/c/d/e.ts')).toBe('…/c/d/e.ts');
  });
  it('leaves short paths intact', () => {
    expect(shortenPath('/a/b.ts')).toBe('/a/b.ts');
  });
});

describe('toProjectRelative', () => {
  it('trims the project prefix', () => {
    expect(toProjectRelative('/proj/src/a.ts', '/proj')).toBe('src/a.ts');
  });
  it('leaves unrelated paths alone', () => {
    expect(toProjectRelative('/other/a.ts', '/proj')).toBe('/other/a.ts');
  });
  it('is a no-op with no project path', () => {
    expect(toProjectRelative('/a.ts', '')).toBe('/a.ts');
  });
});

describe('formatElapsed', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatElapsed(5_000)).toBe('5s');
    expect(formatElapsed(135_000)).toBe('2m 15s');
    expect(formatElapsed(3_900_000)).toBe('1h 5m');
  });
});

describe('formatCount', () => {
  it('abbreviates large counts', () => {
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1200)).toBe('1.2k');
    expect(formatCount(2000)).toBe('2k');
    expect(formatCount(1_500_000)).toBe('1.5M');
  });
});

describe('outputToText', () => {
  it('passes strings through', () => {
    expect(outputToText('hi')).toBe('hi');
  });
  it('joins Claude content blocks', () => {
    expect(outputToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
  });
  it('pretty-prints objects', () => {
    expect(outputToText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
  it('renders nullish as empty', () => {
    expect(outputToText(null)).toBe('');
    expect(outputToText(undefined)).toBe('');
  });
});

describe('summarizeToolInput', () => {
  it('shows the unwrapped command for Bash', () => {
    expect(summarizeToolInput('Bash', { command: '/bin/zsh -lc "npm test"' })).toBe('npm test');
  });

  it('shows the file path for file tools', () => {
    for (const t of ['Read', 'Write', 'Edit', 'MultiEdit']) {
      expect(summarizeToolInput(t, { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    }
  });

  it('shows pattern and scope for Grep', () => {
    expect(summarizeToolInput('Grep', { pattern: 'foo', path: 'src' })).toBe('foo in src');
    expect(summarizeToolInput('Grep', { pattern: 'foo' })).toBe('foo');
  });

  it('shows progress for TodoWrite', () => {
    const todos = [{ status: 'completed' }, { status: 'pending' }, { status: 'completed' }];
    expect(summarizeToolInput('TodoWrite', { todos })).toBe('2/3 done');
  });

  it('falls back to the first short string for unknown tools', () => {
    expect(summarizeToolInput('SomeNewTool', { thing: 'a value' })).toBe('a value');
  });

  it('returns empty rather than throwing on odd input', () => {
    expect(summarizeToolInput('Bash', null)).toBe('');
    expect(summarizeToolInput('Read', { file_path: 42 })).toBe('');
    expect(summarizeToolInput('TodoWrite', { todos: 'nope' })).toBe('');
  });
});
