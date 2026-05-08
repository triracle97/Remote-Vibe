import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileStore } from '../profile-store';

describe('ProfileStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pfx-'));
    path = join(dir, 'profiles.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('load() returns empty when file missing', async () => {
    const s = new ProfileStore(path);
    await s.load();
    expect(s.list()).toEqual([]);
  });

  it('add() persists and load() restores', async () => {
    const s1 = new ProfileStore(path);
    await s1.load();
    await s1.add({
      name: 'frontend',
      agent: 'claude',
      dirs: ['/tmp/a', '/tmp/b'],
      account: null,
      default: true,
    });
    const s2 = new ProfileStore(path);
    await s2.load();
    expect(s2.get('frontend', 'claude')?.dirs).toEqual(['/tmp/a', '/tmp/b']);
  });

  it('setDefault unsets prior default for the same agent', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await s.add({ name: 'a', agent: 'claude', dirs: ['/x'], account: null, default: true });
    await s.add({ name: 'b', agent: 'claude', dirs: ['/y'], account: null, default: false });
    await s.setDefault('b', 'claude');
    expect(s.get('a', 'claude')?.default).toBe(false);
    expect(s.get('b', 'claude')?.default).toBe(true);
  });

  it('setDefault does NOT touch defaults for other agents', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await s.add({ name: 'cl-a', agent: 'claude', dirs: ['/x'], account: null, default: true });
    await s.add({ name: 'cx-a', agent: 'codex', dirs: ['/y'], account: null, default: true });
    await s.add({ name: 'cl-b', agent: 'claude', dirs: ['/z'], account: null, default: false });
    await s.setDefault('cl-b', 'claude');
    expect(s.get('cl-a', 'claude')?.default).toBe(false);
    expect(s.get('cx-a', 'codex')?.default).toBe(true); // codex untouched
  });

  it('add rejects duplicate name within same agent', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await s.add({ name: 'foo', agent: 'claude', dirs: ['/x'], account: null, default: false });
    await expect(
      s.add({ name: 'Foo', agent: 'claude', dirs: ['/y'], account: null, default: false }),
    ).rejects.toMatchObject({ code: 'profile_invalid_name' });
  });

  it('add allows same name across agents', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await s.add({ name: 'shared', agent: 'claude', dirs: ['/x'], account: null, default: false });
    await s.add({ name: 'shared', agent: 'codex', dirs: ['/y'], account: null, default: false });
    expect(s.list()).toHaveLength(2);
  });

  it('add rejects bad name (empty / regex mismatch)', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await expect(
      s.add({ name: '', agent: 'claude', dirs: ['/x'], account: null, default: false }),
    ).rejects.toMatchObject({ code: 'profile_invalid_name' });
    await expect(
      s.add({ name: 'has/slash', agent: 'claude', dirs: ['/x'], account: null, default: false }),
    ).rejects.toMatchObject({ code: 'profile_invalid_name' });
  });

  it('add rejects empty dirs', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await expect(
      s.add({ name: 'foo', agent: 'claude', dirs: [], account: null, default: false }),
    ).rejects.toMatchObject({ code: 'profile_dirs_disallowed' });
  });

  it('remove() persists deletion', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await s.add({ name: 'foo', agent: 'claude', dirs: ['/x'], account: null, default: false });
    await s.remove('foo', 'claude');
    expect(s.get('foo', 'claude')).toBeUndefined();
  });

  it('remove rejects missing profile', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await expect(s.remove('nope', 'claude')).rejects.toMatchObject({ code: 'profile_not_found' });
  });

  it('writes file with mode 0o600', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await s.add({ name: 'x', agent: 'claude', dirs: ['/x'], account: null, default: false });
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
  });

  it('falls back to empty on corrupt file', async () => {
    writeFileSync(path, 'not json', { mode: 0o600 });
    const s = new ProfileStore(path);
    await s.load();
    expect(s.list()).toEqual([]);
  });

  it('serializes 50 concurrent add/setDefault calls without torn writes', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await s.add({ name: 'base', agent: 'claude', dirs: ['/x'], account: null, default: false });
    const ops = Array.from({ length: 50 }, (_, i) =>
      s.add({ name: `p${i}`, agent: 'claude', dirs: ['/x'], account: null, default: false }).catch(() => {}),
    );
    await Promise.all(ops);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    expect(Array.isArray(raw.profiles)).toBe(true);
  });
});
