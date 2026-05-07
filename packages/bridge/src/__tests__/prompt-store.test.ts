import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptStore } from '../prompt-store.js';

describe('PromptStore', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mrt-prompts-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores added prompts', () => {
    const store = new PromptStore(dataDir);
    store.add({ text: 'hello', projectPath: '/p1', agent: 'claude' });
    store.add({ text: 'world', projectPath: '/p1', agent: 'claude' });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.text)).toEqual(['world', 'hello']);
  });

  it('dedupes by text via sha256 and unions project paths and agents', () => {
    const store = new PromptStore(dataDir);
    store.add({ text: 'hello', projectPath: '/p1', agent: 'claude' });
    store.add({ text: 'hello', projectPath: '/p2', agent: 'codex' });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.projectPaths.sort()).toEqual(['/p1', '/p2']);
    expect(list[0]!.agents.sort()).toEqual(['claude', 'codex']);
  });

  it('caps the list at 500 entries (oldest evicted)', () => {
    const store = new PromptStore(dataDir);
    for (let i = 0; i < 510; i++) store.add({ text: `t${i}`, projectPath: '/p', agent: 'claude' });
    const list = store.list();
    expect(list.length).toBe(500);
    expect(list[0]!.text).toBe('t509');
    expect(list[list.length - 1]!.text).toBe('t10');
  });

  it('list filters by case-insensitive substring query and respects limit', () => {
    const store = new PromptStore(dataDir);
    store.add({ text: 'Hello world', projectPath: '/p', agent: 'claude' });
    store.add({ text: 'goodbye', projectPath: '/p', agent: 'claude' });
    store.add({ text: 'hello again', projectPath: '/p', agent: 'claude' });
    expect(store.list('hello').map((p) => p.text)).toEqual(['hello again', 'Hello world']);
    expect(store.list(undefined, 2).length).toBe(2);
  });

  it('round-trips through disk: writes prompts.json and a reopened store reads it', () => {
    const a = new PromptStore(dataDir);
    a.add({ text: 'persist me', projectPath: '/p', agent: 'codex' });
    expect(existsSync(join(dataDir, 'prompts.json'))).toBe(true);

    const b = new PromptStore(dataDir);
    expect(b.list().map((p) => p.text)).toEqual(['persist me']);
  });

  it('handles corrupt prompts.json by treating it as empty', () => {
    const path = join(dataDir, 'prompts.json');
    writeFileSync(path, '{not json');
    const store = new PromptStore(dataDir);
    expect(store.list()).toEqual([]);
    store.add({ text: 'fresh', projectPath: '/p', agent: 'claude' });
    const data = JSON.parse(readFileSync(path, 'utf8')) as { entries: unknown[] };
    expect(data.entries.length).toBe(1);
  });
});
