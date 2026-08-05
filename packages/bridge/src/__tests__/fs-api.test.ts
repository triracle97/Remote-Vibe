import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  rmSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsApi, hashContent } from '../fs-api.js';

const __filename = fileURLToPath(import.meta.url);
const FIXTURE_PNG = join(dirname(__filename), '..', '..', 'test', 'fixtures', 'tiny.png');

describe('FsApi.listDirs', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mrt-fs-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists files and dirs sorted (dirs first, then files; case-insensitive)', async () => {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'README.md'), 'hi');
    writeFileSync(join(root, 'a.txt'), 'aa');

    const api = new FsApi({ allowedDirs: [root] });
    const entries = await api.listDirs(root);
    expect(entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'dir:docs',
      'dir:src',
      'file:a.txt',
      'file:README.md',
    ]);
    expect(entries.find((e) => e.name === 'a.txt')!.size).toBe(2);
  });

  it('rejects paths outside the allowlist', async () => {
    const other = mkdtempSync(join(tmpdir(), 'mrt-other-'));
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.listDirs(other)).rejects.toMatchObject({ code: 'path_outside_allowlist' });
    rmSync(other, { recursive: true, force: true });
  });

  it('rejects denylist segments at the requested path', async () => {
    mkdirSync(join(root, '.ssh'));
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.listDirs(join(root, '.ssh'))).rejects.toMatchObject({ code: 'path_denied' });
  });

  it('denylist segment match is case-insensitive', async () => {
    mkdirSync(join(root, '.SSH'));
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.listDirs(join(root, '.SSH'))).rejects.toMatchObject({ code: 'path_denied' });
  });

  it('drops denylisted children from listings', async () => {
    mkdirSync(join(root, '.ssh'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'id_rsa'), 'fake');
    writeFileSync(join(root, 'id_rsa.PUB'), 'fake');
    writeFileSync(join(root, 'cert.PEM'), 'fake');
    writeFileSync(join(root, 'README.md'), 'hi');

    const api = new FsApi({ allowedDirs: [root] });
    const names = (await api.listDirs(root)).map((e) => e.name);
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    expect(names).not.toContain('.ssh');
    expect(names).not.toContain('id_rsa');
    expect(names).not.toContain('cert.PEM');
    // id_rsa.PUB has the prefix 'id_rsa' but the basename match is exact, so it's allowed.
    expect(names).toContain('id_rsa.PUB');
  });

  it('drops symlink children whose realpath escapes the allowlist', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mrt-out-'));
    writeFileSync(join(outside, 'secret.txt'), 'shh');
    symlinkSync(outside, join(root, 'escape'));

    const api = new FsApi({ allowedDirs: [root] });
    const names = (await api.listDirs(root)).map((e) => e.name);
    expect(names).not.toContain('escape');
    rmSync(outside, { recursive: true, force: true });
  });

  it('rejects listDirs on a regular file as path_outside_allowlist', async () => {
    writeFileSync(join(root, 'plain.txt'), 'hi');
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.listDirs(join(root, 'plain.txt'))).rejects.toMatchObject({
      code: 'path_outside_allowlist',
    });
  });
});

describe('FsApi.readFile', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mrt-fs-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns kind:text for small text files', async () => {
    writeFileSync(join(root, 'hello.txt'), 'hello world');
    const api = new FsApi({ allowedDirs: [root] });
    const r = await api.readFile(join(root, 'hello.txt'), 5_242_880);
    expect(r).toEqual({
      kind: 'text',
      content: 'hello world',
      bytesRead: 11,
      truncated: false,
      hash: hashContent('hello world'),
    });
  });

  it('returns kind:binary for a PNG, with no content body', async () => {
    copyFileSync(FIXTURE_PNG, join(root, 'tiny.png'));
    const api = new FsApi({ allowedDirs: [root] });
    const r = await api.readFile(join(root, 'tiny.png'), 5_242_880);
    expect(r.kind).toBe('binary');
    if (r.kind === 'binary') {
      expect(r.mime).toBe('image/png');
      expect(r.size).toBeGreaterThan(0);
    }
  });

  it('returns kind:too_large when stat.size > sizeCap', async () => {
    writeFileSync(join(root, 'big.txt'), 'a'.repeat(2048));
    const api = new FsApi({ allowedDirs: [root] });
    const r = await api.readFile(join(root, 'big.txt'), 1024);
    expect(r).toEqual({ kind: 'too_large', size: 2048 });
  });

  it('rejects ENOENT as path_outside_allowlist (no existence leak)', async () => {
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.readFile(join(root, 'nope.txt'), 1024)).rejects.toMatchObject({
      code: 'path_outside_allowlist',
    });
  });

  it('rejects denylisted basenames', async () => {
    writeFileSync(join(root, 'id_rsa'), 'pretend-key');
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.readFile(join(root, 'id_rsa'), 1024)).rejects.toMatchObject({
      code: 'path_denied',
    });
  });

  it('rejects denylisted segment-runs', async () => {
    mkdirSync(join(root, '.docker'));
    writeFileSync(join(root, '.docker', 'config.json'), '{}');
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.readFile(join(root, '.docker', 'config.json'), 1024)).rejects.toMatchObject({
      code: 'path_denied',
    });
  });

  it('detects invalid-UTF8 binary content even without NUL bytes', async () => {
    // A single 0xFF byte is invalid UTF-8 (no NUL to short-circuit on). The
    // TextDecoder fatal:true gate must catch it; the legacy heuristic that
    // treated b >= 0x80 as printable would mislabel this as text.
    writeFileSync(join(root, 'latin1.bin'), Buffer.from([0xff, 0xfe, 0xfd]));
    const api = new FsApi({ allowedDirs: [root] });
    const r = await api.readFile(join(root, 'latin1.bin'), 1024);
    expect(r.kind).toBe('binary');
  });
});

describe('FsApi.writeFile', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mrt-fsw-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('overwrites an existing file and reports bytes + new hash', async () => {
    const p = join(root, 'a.txt');
    writeFileSync(p, 'old');
    const api = new FsApi({ allowedDirs: [root] });

    const res = await api.writeFile(p, 'new content');
    expect(res.bytesWritten).toBe(11);
    expect(res.hash).toBe(hashContent('new content'));
    expect(readFileSync(p, 'utf8')).toBe('new content');
  });

  it('leaves no .tmp turds behind', async () => {
    const p = join(root, 'a.txt');
    writeFileSync(p, 'old');
    const api = new FsApi({ allowedDirs: [root] });
    await api.writeFile(p, 'new');
    expect(readdirSync(root)).toEqual(['a.txt']);
  });

  it('preserves the original file mode (an executable script stays executable)', async () => {
    const p = join(root, 'run.sh');
    writeFileSync(p, '#!/bin/sh\necho old\n', { mode: 0o755 });
    const api = new FsApi({ allowedDirs: [root] });
    await api.writeFile(p, '#!/bin/sh\necho new\n');
    expect(statSync(p).mode & 0o777).toBe(0o755);
  });

  it('refuses paths outside the allowlist', async () => {
    const other = mkdtempSync(join(tmpdir(), 'mrt-other-w-'));
    const outside = join(other, 'x.txt');
    writeFileSync(outside, 'secret');
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.writeFile(outside, 'pwned')).rejects.toMatchObject({
      code: 'path_outside_allowlist',
    });
    expect(readFileSync(outside, 'utf8')).toBe('secret');
    rmSync(other, { recursive: true, force: true });
  });

  it('refuses denylisted basenames even inside the allowlist', async () => {
    const p = join(root, 'id_rsa');
    writeFileSync(p, 'pretend-key');
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.writeFile(p, 'pwned')).rejects.toMatchObject({ code: 'path_denied' });
    expect(readFileSync(p, 'utf8')).toBe('pretend-key');
  });

  it('refuses denylisted segment-runs', async () => {
    mkdirSync(join(root, '.docker'));
    const p = join(root, '.docker', 'config.json');
    writeFileSync(p, '{}');
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.writeFile(p, '{"pwned":1}')).rejects.toMatchObject({ code: 'path_denied' });
    expect(readFileSync(p, 'utf8')).toBe('{}');
  });

  it('refuses a symlink that escapes the allowlist', async () => {
    const other = mkdtempSync(join(tmpdir(), 'mrt-other-l-'));
    const target = join(other, 'target.txt');
    writeFileSync(target, 'secret');
    const link = join(root, 'link.txt');
    symlinkSync(target, link);

    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.writeFile(link, 'pwned')).rejects.toMatchObject({
      code: 'path_outside_allowlist',
    });
    expect(readFileSync(target, 'utf8')).toBe('secret');
    rmSync(other, { recursive: true, force: true });
  });

  it('cannot create a new file', async () => {
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.writeFile(join(root, 'nope.txt'), 'x')).rejects.toMatchObject({
      code: 'path_outside_allowlist',
    });
  });

  it('refuses to write to a directory', async () => {
    mkdirSync(join(root, 'sub'));
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.writeFile(join(root, 'sub'), 'x')).rejects.toMatchObject({
      code: 'path_outside_allowlist',
    });
  });

  it('enforces the write cap before touching disk', async () => {
    const p = join(root, 'a.txt');
    writeFileSync(p, 'old');
    const api = new FsApi({ allowedDirs: [root], writeMaxBytes: 4 });
    await expect(api.writeFile(p, 'much too long')).rejects.toMatchObject({
      code: 'file_too_large',
    });
    expect(readFileSync(p, 'utf8')).toBe('old');
  });

  it('counts the cap in bytes, not characters', async () => {
    const p = join(root, 'a.txt');
    writeFileSync(p, 'old');
    // 3 chars, 9 UTF-8 bytes.
    const api = new FsApi({ allowedDirs: [root], writeMaxBytes: 8 });
    await expect(api.writeFile(p, '日本語')).rejects.toMatchObject({ code: 'file_too_large' });
  });

  it('rejects a stale baseHash with file_conflict and leaves the file alone', async () => {
    const p = join(root, 'a.txt');
    writeFileSync(p, 'v1');
    const api = new FsApi({ allowedDirs: [root] });
    const loaded = await api.readFile(p);
    // Someone else (the agent) writes in between.
    writeFileSync(p, 'v2-from-agent');

    await expect(
      api.writeFile(p, 'v2-from-browser', (loaded as { hash: string }).hash),
    ).rejects.toMatchObject({ code: 'file_conflict' });
    expect(readFileSync(p, 'utf8')).toBe('v2-from-agent');
  });

  it('accepts a current baseHash', async () => {
    const p = join(root, 'a.txt');
    writeFileSync(p, 'v1');
    const api = new FsApi({ allowedDirs: [root] });
    const loaded = await api.readFile(p);
    await api.writeFile(p, 'v2', (loaded as { hash: string }).hash);
    expect(readFileSync(p, 'utf8')).toBe('v2');
  });

  it('force-writes when baseHash is omitted', async () => {
    const p = join(root, 'a.txt');
    writeFileSync(p, 'v1');
    const api = new FsApi({ allowedDirs: [root] });
    writeFileSync(p, 'v2-from-agent');
    await api.writeFile(p, 'v3-forced');
    expect(readFileSync(p, 'utf8')).toBe('v3-forced');
  });

  it('round-trips: the hash readFile returns is the one writeFile accepts', async () => {
    const p = join(root, 'a.txt');
    writeFileSync(p, 'hello');
    const api = new FsApi({ allowedDirs: [root] });
    const first = await api.readFile(p);
    const written = await api.writeFile(p, 'goodbye', (first as { hash: string }).hash);
    const second = await api.readFile(p);
    expect((second as { hash: string }).hash).toBe(written.hash);
  });
});
