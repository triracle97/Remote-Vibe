import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSearch } from '../file-search';

function setMtime(path: string, secAgo: number): void {
  const t = Date.now() / 1000 - secAgo;
  utimesSync(path, t, t);
}

describe('FileSearch', () => {
  let primary: string;
  let secondary: string;
  let getDirs: () => string[];

  beforeEach(() => {
    primary = mkdtempSync(join(tmpdir(), 'fs-prim-'));
    secondary = mkdtempSync(join(tmpdir(), 'fs-sec-'));
    getDirs = () => [primary, secondary];
  });

  afterEach(() => {
    rmSync(primary, { recursive: true, force: true });
    rmSync(secondary, { recursive: true, force: true });
  });

  it('empty query returns top 50 by mtime desc', async () => {
    for (let i = 0; i < 60; i++) {
      const p = join(primary, `file-${i}.ts`);
      writeFileSync(p, '');
      setMtime(p, i); // i=0 newest
    }
    const s = new FileSearch({ getDirsForSession: getDirs });
    const result = await s.search('s1', '');
    expect(result.hits).toHaveLength(50);
    expect(result.hits[0]!.fullPath).toBe(join(primary, 'file-0.ts'));
  });

  it('basename match scores higher than path-only match', async () => {
    writeFileSync(join(primary, 'auth.ts'), '');
    mkdirSync(join(primary, 'lib'));
    writeFileSync(join(primary, 'lib', 'notauthorize.ts'), '');
    const s = new FileSearch({ getDirsForSession: getDirs });
    const result = await s.search('s1', 'auth');
    expect(result.hits[0]!.fullPath.endsWith('/auth.ts')).toBe(true);
  });

  it('multi-dir insertText format: primary uses bare path, additional uses dir-basename prefix', async () => {
    writeFileSync(join(primary, 'a.ts'), '');
    writeFileSync(join(secondary, 'b.ts'), '');
    const s = new FileSearch({ getDirsForSession: getDirs });
    const result = await s.search('s1', '');
    const a = result.hits.find((h) => h.fullPath.endsWith('/a.ts'));
    const b = result.hits.find((h) => h.fullPath.endsWith('/b.ts'));
    expect(a?.insertText).toBe('@a.ts');
    expect(a?.dirIndex).toBe(0);
    const secBase = secondary.split('/').pop()!;
    expect(b?.insertText).toBe(`@${secBase}/b.ts`);
    expect(b?.dirIndex).toBe(1);
  });

  it('respects denylist (node_modules, .git)', async () => {
    writeFileSync(join(primary, 'normal.ts'), '');
    mkdirSync(join(primary, 'node_modules'));
    writeFileSync(join(primary, 'node_modules', 'foo.ts'), '');
    mkdirSync(join(primary, '.git'));
    writeFileSync(join(primary, '.git', 'HEAD'), '');
    const s = new FileSearch({ getDirsForSession: getDirs });
    const result = await s.search('s1', '');
    expect(result.hits.find((h) => h.fullPath.includes('node_modules'))).toBeUndefined();
    expect(result.hits.find((h) => h.fullPath.includes('.git'))).toBeUndefined();
  });

  it('respects .gitignore', async () => {
    writeFileSync(join(primary, '.gitignore'), 'secret/\n');
    mkdirSync(join(primary, 'secret'));
    writeFileSync(join(primary, 'secret', 'nope.ts'), '');
    writeFileSync(join(primary, 'visible.ts'), '');
    const s = new FileSearch({ getDirsForSession: getDirs });
    const result = await s.search('s1', '');
    expect(result.hits.find((h) => h.fullPath.includes('/secret/'))).toBeUndefined();
    expect(result.hits.find((h) => h.fullPath.endsWith('/visible.ts'))).toBeDefined();
  });

  it('5000-cap truncated flag', async () => {
    for (let i = 0; i < 5050; i++) writeFileSync(join(primary, `f-${i}.ts`), '');
    const s = new FileSearch({ getDirsForSession: getDirs });
    const result = await s.search('s1', '');
    expect(result.truncated).toBe(true);
  });

  it('30s cache: second search within window walks once', async () => {
    writeFileSync(join(primary, 'a.ts'), '');
    const s = new FileSearch({ getDirsForSession: getDirs });
    await s.search('s1', '');
    // delete a file then search again — if the cache is hit, the missing file would NOT cause stale results
    rmSync(join(primary, 'a.ts'));
    writeFileSync(join(primary, 'b.ts'), '');
    const r = await s.search('s1', '');
    // If cache hits, the result still has 'a.ts' (cached)
    // Note: this test asserts cache behavior; may be brittle if walk isn't fully sync
    expect(r.hits.find((h) => h.fullPath.endsWith('/a.ts'))).toBeDefined();
  });
});
