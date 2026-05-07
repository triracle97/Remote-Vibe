import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentKind, ServerErrorCode } from './types.js';

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const MAX_IMAGES = 4;
const MAX_BYTES_PER_IMAGE = 10 * 1024 * 1024;

export interface RawImage {
  mime: string;
  base64: string;
}

export interface ImageStoreOpts {
  dataDir: string;
}

export type ValidateResult = { ok: true } | { ok: false; error: ServerErrorCode };

function decodedBytes(base64: string): number {
  // 4 base64 chars encode 3 raw bytes. Subtract 1 byte per '=' padding.
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export class ImageStore {
  private readonly dataDir: string;

  constructor(opts: ImageStoreOpts) {
    this.dataDir = opts.dataDir;
  }

  validate(images: RawImage[] | undefined, agent: AgentKind): ValidateResult {
    if (!images || images.length === 0) return { ok: true };
    if (agent !== 'claude') return { ok: false, error: 'images_not_supported_for_agent' };
    if (images.length > MAX_IMAGES) return { ok: false, error: 'too_many_images' };
    for (const img of images) {
      if (!MIME_TO_EXT[img.mime]) return { ok: false, error: 'image_invalid_mime' };
      if (decodedBytes(img.base64) > MAX_BYTES_PER_IMAGE) {
        return { ok: false, error: 'image_too_large' };
      }
    }
    return { ok: true };
  }

  async writeAuditCopy(sessionId: string, images: RawImage[]): Promise<void> {
    if (images.length === 0) return;
    const dir = join(this.dataDir, 'images', sessionId);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      console.warn(`[image-store] mkdir(${dir}) failed: ${(err as Error).message}`);
      return;
    }
    for (const img of images) {
      const ext = MIME_TO_EXT[img.mime] ?? 'bin';
      const path = join(dir, `${randomUUID()}.${ext}`);
      try {
        await writeFile(path, Buffer.from(img.base64, 'base64'), { mode: 0o600 });
      } catch (err) {
        console.warn(`[image-store] write(${path}) failed: ${(err as Error).message}`);
      }
    }
  }

  async cleanup(sessionId: string): Promise<void> {
    const dir = join(this.dataDir, 'images', sessionId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[image-store] cleanup(${dir}) failed: ${(err as Error).message}`);
    }
  }
}
