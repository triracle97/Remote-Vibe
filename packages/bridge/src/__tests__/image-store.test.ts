import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageStore } from '../image-store.js';

const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex');

function tinyPngBase64(): string {
  return Buffer.concat([PNG_HEADER, Buffer.alloc(60)]).toString('base64');
}

describe('ImageStore.validate', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mrt-img-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('accepts up to 4 valid Claude images', () => {
    const store = new ImageStore({ dataDir });
    const images = Array.from({ length: 4 }, () => ({ mime: 'image/png', base64: tinyPngBase64() }));
    expect(store.validate(images, 'claude')).toEqual({ ok: true });
  });

  it('accepts images on a codex session', () => {
    // `codex exec -i <FILE>` takes images; the old rejection here predated it.
    const store = new ImageStore({ dataDir });
    const images = [{ mime: 'image/png', base64: tinyPngBase64() }];
    expect(store.validate(images, 'codex')).toEqual({ ok: true });
  });

  it('still applies the count and size caps to codex', () => {
    const store = new ImageStore({ dataDir });
    const one = { mime: 'image/png', base64: tinyPngBase64() };
    expect(store.validate([one, one, one, one, one], 'codex')).toEqual({
      ok: false,
      error: 'too_many_images',
    });
    expect(store.validate([{ mime: 'image/tiff', base64: tinyPngBase64() }], 'codex')).toEqual({
      ok: false,
      error: 'image_invalid_mime',
    });
  });

  it('rejects > 4 images', () => {
    const store = new ImageStore({ dataDir });
    const images = Array.from({ length: 5 }, () => ({ mime: 'image/png', base64: tinyPngBase64() }));
    expect(store.validate(images, 'claude')).toEqual({ ok: false, error: 'too_many_images' });
  });

  it('rejects unknown MIME', () => {
    const store = new ImageStore({ dataDir });
    expect(
      store.validate([{ mime: 'image/svg+xml', base64: tinyPngBase64() }], 'claude'),
    ).toEqual({ ok: false, error: 'image_invalid_mime' });
  });

  it('rejects images > 10 MB decoded', () => {
    const store = new ImageStore({ dataDir });
    // 11 MB base64 is ~14.6 MB encoded, decodes to 11 MB
    const big = Buffer.alloc(11 * 1024 * 1024).toString('base64');
    expect(store.validate([{ mime: 'image/png', base64: big }], 'claude')).toEqual({
      ok: false,
      error: 'image_too_large',
    });
  });
});

describe('ImageStore.writeAuditCopy / cleanup', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mrt-img-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes one file per image with mode 0600 in a 0700 dir', async () => {
    const store = new ImageStore({ dataDir });
    const sessionId = 'sess-1';
    await store.writeAuditCopy(sessionId, [
      { mime: 'image/png', base64: tinyPngBase64() },
      { mime: 'image/jpeg', base64: 'AAEC' },
    ]);
    const dir = join(dataDir, 'images', sessionId);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const entries = readdirSync(dir);
    expect(entries.length).toBe(2);
    for (const name of entries) {
      const p = join(dir, name);
      expect(statSync(p).mode & 0o777).toBe(0o600);
    }
    expect(entries.some((n) => n.endsWith('.png'))).toBe(true);
    expect(entries.some((n) => n.endsWith('.jpg') || n.endsWith('.jpeg'))).toBe(true);
  });

  it('cleanup removes the per-session directory', async () => {
    const store = new ImageStore({ dataDir });
    await store.writeAuditCopy('sess-1', [{ mime: 'image/png', base64: tinyPngBase64() }]);
    const dir = join(dataDir, 'images', 'sess-1');
    expect(existsSync(dir)).toBe(true);
    await store.cleanup('sess-1');
    expect(existsSync(dir)).toBe(false);
  });
});

describe('ImageStore.writeAuditCopy — paths for Codex', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mrt-img-paths-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns the absolute path of every image it wrote', async () => {
    const store = new ImageStore({ dataDir });
    const images = [
      { mime: 'image/png', base64: tinyPngBase64() },
      { mime: 'image/jpeg', base64: tinyPngBase64() },
    ];
    const paths = await store.writeAuditCopy('sess-1', images);

    expect(paths).toHaveLength(2);
    // Codex is handed these on the command line, so they must be real files.
    for (const p of paths) {
      expect(existsSync(p)).toBe(true);
    }
    // The extension follows the MIME, which is how `codex exec -i` sniffs type.
    expect(paths[0]!.endsWith('.png')).toBe(true);
    expect(paths[1]!.endsWith('.jpg')).toBe(true);
  });

  it('returns an empty list for no images', async () => {
    const store = new ImageStore({ dataDir });
    expect(await store.writeAuditCopy('sess-2', [])).toEqual([]);
  });
});
