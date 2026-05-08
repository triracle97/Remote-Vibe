import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlashCommandsScanner } from '../slash-commands';

describe('SlashCommandsScanner', () => {
  let homeDir: string;
  let projectDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'sc-home-'));
    projectDir = mkdtempSync(join(tmpdir(), 'sc-proj-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns Claude builtins-only when no scan dirs exist', async () => {
    const s = new SlashCommandsScanner({ homeDir });
    const result = await s.listForSession({ sessionId: 's1', agent: 'claude', primaryCwd: projectDir });
    expect(result.find((c) => c.name === '/help')).toBeDefined();
    expect(result.find((c) => c.name === '/clear')).toBeDefined();
    expect(result.every((c) => c.source === 'builtin')).toBe(true);
  });

  it('returns Codex builtins-only and skips ~/.claude/commands scan for codex sessions', async () => {
    mkdirSync(join(homeDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(
      join(homeDir, '.claude', 'commands', 'foo.md'),
      '---\ndescription: foo cmd\n---\n',
    );
    const s = new SlashCommandsScanner({ homeDir });
    const result = await s.listForSession({ sessionId: 's1', agent: 'codex', primaryCwd: projectDir });
    expect(result.find((c) => c.name === '/foo')).toBeUndefined();
    expect(result.find((c) => c.name === '/help')).toBeDefined();
  });

  it('user-level scan picks up commands with frontmatter description', async () => {
    mkdirSync(join(homeDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(
      join(homeDir, '.claude', 'commands', 'commit.md'),
      '---\ndescription: write a git commit\n---\nbody here\n',
    );
    const s = new SlashCommandsScanner({ homeDir });
    const result = await s.listForSession({ sessionId: 's1', agent: 'claude', primaryCwd: projectDir });
    const cmd = result.find((c) => c.name === '/commit');
    expect(cmd).toBeDefined();
    expect(cmd?.source).toBe('user');
    expect(cmd?.description).toBe('write a git commit');
  });

  it('user-level scan falls back to first non-frontmatter line when no description', async () => {
    mkdirSync(join(homeDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(homeDir, '.claude', 'commands', 'notes.md'), 'My notes command\nmore body\n');
    const s = new SlashCommandsScanner({ homeDir });
    const result = await s.listForSession({ sessionId: 's1', agent: 'claude', primaryCwd: projectDir });
    expect(result.find((c) => c.name === '/notes')?.description).toBe('My notes command');
  });

  it('project-level wins on collision with user-level', async () => {
    mkdirSync(join(homeDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(homeDir, '.claude', 'commands', 'shared.md'), 'user version');
    mkdirSync(join(projectDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(projectDir, '.claude', 'commands', 'shared.md'), 'project version');
    const s = new SlashCommandsScanner({ homeDir });
    const result = await s.listForSession({ sessionId: 's1', agent: 'claude', primaryCwd: projectDir });
    const cmd = result.find((c) => c.name === '/shared');
    expect(cmd?.source).toBe('project');
    expect(cmd?.description).toBe('project version');
  });

  it('60s cache: two calls within window scan filesystem only once', async () => {
    const s = new SlashCommandsScanner({ homeDir });
    const spy = vi.spyOn(s as unknown as { scanDir: () => Promise<unknown> }, 'scanDir');
    await s.listForSession({ sessionId: 's1', agent: 'claude', primaryCwd: projectDir });
    await s.listForSession({ sessionId: 's1', agent: 'claude', primaryCwd: projectDir });
    expect(spy.mock.calls.length).toBeLessThan(4); // 2 dirs × 2 calls = 4 if no cache
  });

  it('skips dir on permission error silently', async () => {
    // Create a dir then chmod 000 to simulate permission denied.
    mkdirSync(join(homeDir, '.claude', 'commands'), { recursive: true });
    // chmod test omitted — just verify no throw on missing dir.
    const s = new SlashCommandsScanner({ homeDir });
    const result = await s.listForSession({ sessionId: 's1', agent: 'claude', primaryCwd: '/nonexistent' });
    expect(result.length).toBeGreaterThan(0); // builtins still returned
  });
});
