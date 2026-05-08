import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryScanner } from '../history-scanner';

function setMtime(path: string, secAgo: number): void {
  const t = Date.now() / 1000 - secAgo;
  utimesSync(path, t, t);
}

describe('HistoryScanner', () => {
  let homeDir: string;
  let claudeDir: string;
  let codexDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'history-test-'));
    claudeDir = join(homeDir, '.claude', 'projects');
    codexDir = join(homeDir, '.codex', 'sessions');
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  function makeClaudeFile(projectDir: string, fname: string, cwd: string, prompt: string): string {
    const dir = join(claudeDir, projectDir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, fname);
    const lines = [
      JSON.stringify({ type: 'last-prompt', sessionId: fname.replace('.jsonl', '') }),
      JSON.stringify({ type: 'user', cwd, message: { content: prompt } }),
    ];
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  }

  function makeCodexFile(yyyy: string, mm: string, dd: string, fname: string, id: string, cwd: string, prompt: string): string {
    const dir = join(codexDir, yyyy, mm, dd);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, fname);
    const lines = [
      JSON.stringify({ timestamp: '2026-04-20T14:48:16.182Z', type: 'session_meta', payload: { id, cwd } }),
      JSON.stringify({ timestamp: '2026-04-20T14:48:17.000Z', type: 'event_msg', payload: { type: 'user_message', text: prompt } }),
    ];
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  }

  it('scanClaude: returns ground-truth cwd from file content (NOT dir-decode)', async () => {
    // Dir name decodes to "/foo/bar/baz" but the file's actual cwd is "/foo-bar/baz"
    const cwd = join(homeDir, 'foo-bar', 'baz');
    mkdirSync(cwd, { recursive: true });
    const path = makeClaudeFile('-foo-bar-baz', 'aaa.jsonl', cwd, 'first user prompt');
    setMtime(path, 10);

    const scanner = new HistoryScanner({ homeDir, allowedDirs: [cwd], allowlistGate: (cwd) => [cwd].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const result = await scanner.list();
    expect(result.claude).toHaveLength(1);
    expect(result.claude[0]!.projectPath).toBe(cwd);
    expect(result.claude[0]!.firstPrompt).toBe('first user prompt');
    expect(result.claude[0]!.sessionId).toBe('aaa');
  });

  it('scanClaude: drops entries with no parseable user message', async () => {
    const dir = join(claudeDir, '-tmp-x');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'no-user.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'last-prompt' }) + '\n');
    setMtime(path, 5);

    const scanner = new HistoryScanner({ homeDir, allowedDirs: [homeDir], allowlistGate: (cwd) => [homeDir].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const result = await scanner.list();
    expect(result.claude).toHaveLength(0);
  });

  it('scanClaude: drops entries whose ground-truth cwd is outside allowlist', async () => {
    const cwd = '/usr/local/forbidden';
    mkdirSync(homeDir + cwd.replace(/^\//, '/'), { recursive: true });
    const path = makeClaudeFile('-usr-local-forbidden', 'a.jsonl', cwd, 'hi');
    setMtime(path, 5);

    const allowed = join(homeDir, 'allowed');
    mkdirSync(allowed, { recursive: true });
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [allowed], allowlistGate: (cwd) => [allowed].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const result = await scanner.list();
    expect(result.claude).toHaveLength(0);
  });

  it('scanClaude: top-50 sort-then-cap correctness — newest at directory-walk position 90 still appears', async () => {
    const cwd = join(homeDir, 'project');
    mkdirSync(cwd, { recursive: true });
    // Create 100 files; the very last alphabetically (zzz.jsonl) gets the
    // newest mtime. Sort-by-mtime must surface it.
    for (let i = 0; i < 100; i++) {
      const fname = String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + (i % 26)) + '.jsonl';
      const path = makeClaudeFile('-project', fname, cwd, `prompt ${i}`);
      setMtime(path, i === 99 ? 0.001 : 1000 - i); // newest = i=99
    }
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [cwd], allowlistGate: (cwd) => [cwd].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const result = await scanner.list();
    expect(result.claude).toHaveLength(50);
    expect(result.claude[0]!.firstPrompt).toBe('prompt 99'); // newest first
  });

  it('scanClaude: malformed JSONL line does not crash the scan', async () => {
    const cwd = join(homeDir, 'p');
    mkdirSync(cwd, { recursive: true });
    const dir = join(claudeDir, '-p');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'bad.jsonl');
    writeFileSync(path, 'not json at all\n' + JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } }) + '\n');
    setMtime(path, 5);
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [cwd], allowlistGate: (cwd) => [cwd].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const result = await scanner.list();
    // Either the file is dropped (no parseable user) OR survives via the
    // valid second line. Both behaviors are acceptable as long as no throw.
    expect(Array.isArray(result.claude)).toBe(true);
  });

  it('scanClaude: firstPrompt truncated to 80 chars', async () => {
    const cwd = join(homeDir, 'p');
    mkdirSync(cwd, { recursive: true });
    const long = 'x'.repeat(200);
    const path = makeClaudeFile('-p', 'a.jsonl', cwd, long);
    setMtime(path, 1);
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [cwd], allowlistGate: (cwd) => [cwd].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const result = await scanner.list();
    expect(result.claude[0]!.firstPrompt).toHaveLength(80);
  });

  it('scanCodex: extracts sessionId + cwd from session_meta line', async () => {
    const cwd = join(homeDir, 'codex-project');
    mkdirSync(cwd, { recursive: true });
    const path = makeCodexFile('2026', '04', '20', 'rollout-x.jsonl', 'codex-uuid-1', cwd, 'first codex prompt');
    setMtime(path, 5);
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [cwd], allowlistGate: (cwd) => [cwd].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const result = await scanner.list();
    expect(result.codex).toHaveLength(1);
    expect(result.codex[0]!.sessionId).toBe('codex-uuid-1');
    expect(result.codex[0]!.projectPath).toBe(cwd);
    expect(result.codex[0]!.firstPrompt).toBe('first codex prompt');
  });

  it('scanCodex: drops entries whose cwd is outside allowlist', async () => {
    const allowed = join(homeDir, 'allowed');
    mkdirSync(allowed, { recursive: true });
    const path = makeCodexFile('2026', '04', '20', 'rollout-y.jsonl', 'codex-uuid-2', '/forbidden', 'hi');
    setMtime(path, 5);
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [allowed], allowlistGate: (cwd) => [allowed].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const result = await scanner.list();
    expect(result.codex).toHaveLength(0);
  });

  it('60 s cache: two list() calls within window scan filesystem only once', async () => {
    const cwd = join(homeDir, 'p');
    mkdirSync(cwd, { recursive: true });
    makeClaudeFile('-p', 'a.jsonl', cwd, 'hi');
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [cwd], allowlistGate: (cwd) => [cwd].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const spy = vi.spyOn(scanner as unknown as { scanClaude: () => Promise<unknown> }, 'scanClaude');
    await scanner.list();
    await scanner.list();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('invalidateCache() forces a re-scan on next list()', async () => {
    const cwd = join(homeDir, 'p');
    mkdirSync(cwd, { recursive: true });
    makeClaudeFile('-p', 'a.jsonl', cwd, 'hi');
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [cwd], allowlistGate: (cwd) => [cwd].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const spy = vi.spyOn(scanner as unknown as { scanClaude: () => Promise<unknown> }, 'scanClaude');
    await scanner.list();
    scanner.invalidateCache();
    await scanner.list();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('findEntry returns undefined when backing file was deleted between scan and lookup', async () => {
    const cwd = join(homeDir, 'p');
    mkdirSync(cwd, { recursive: true });
    const path = makeClaudeFile('-p', 'aaa.jsonl', cwd, 'hi');
    setMtime(path, 5);
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [cwd], allowlistGate: (c) => c.startsWith(homeDir) });
    // First call: populates cache + filePathByKey.
    const first = await scanner.findEntry('claude', 'aaa');
    expect(first).toBeDefined();
    // Delete the backing file.
    rmSync(path);
    // Second call: cache still has the entry, but findEntry re-stats and rejects.
    const second = await scanner.findEntry('claude', 'aaa');
    expect(second).toBeUndefined();
  });

  it('returns [] for both agents when home dirs are missing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'empty-'));
    const scanner = new HistoryScanner({ homeDir: empty, allowedDirs: [empty], allowlistGate: () => true });
    const result = await scanner.list();
    expect(result.claude).toEqual([]);
    expect(result.codex).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});
