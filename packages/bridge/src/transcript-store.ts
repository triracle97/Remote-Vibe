import { mkdirSync, statSync, openSync, writeSync, closeSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerLifecycleMsg, ServerStreamMsg } from './types.js';

const TRANSCRIPTS_SUBDIR = 'transcripts';

export class TranscriptStore {
  private readonly handles = new Map<string, number>();
  private readonly transcriptsDir: string;

  constructor(dataDir: string) {
    this.transcriptsDir = join(dataDir, TRANSCRIPTS_SUBDIR);
    try {
      mkdirSync(this.transcriptsDir, { recursive: true });
    } catch (err) {
      console.warn(`[transcript-store] could not create ${this.transcriptsDir}: ${(err as Error).message}`);
    }
  }

  append(sessionId: string, msg: ServerLifecycleMsg | ServerStreamMsg): void {
    let fd = this.handles.get(sessionId);
    if (fd === undefined) {
      const path = join(this.transcriptsDir, `${sessionId}.jsonl`);
      try {
        fd = openSync(path, 'a');
      } catch (err) {
        console.warn(`[transcript-store] open(${path}) failed: ${(err as Error).message}`);
        return;
      }
      this.handles.set(sessionId, fd);
    }
    try {
      writeSync(fd, JSON.stringify(msg) + '\n');
    } catch (err) {
      console.warn(`[transcript-store] write(${sessionId}) failed: ${(err as Error).message}`);
    }
  }

  close(sessionId: string): void {
    const fd = this.handles.get(sessionId);
    if (fd === undefined) return;
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    this.handles.delete(sessionId);
  }

  closeAll(): void {
    for (const id of [...this.handles.keys()]) this.close(id);
  }

  async prune(retentionDays: number): Promise<number> {
    if (retentionDays <= 0) return 0;
    const cutoffMs = Date.now() - retentionDays * 86_400_000;
    let entries: string[];
    try {
      entries = await readdir(this.transcriptsDir);
    } catch {
      return 0;
    }
    let deleted = 0;
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(this.transcriptsDir, name);
      try {
        const st = await stat(path);
        if (st.mtimeMs < cutoffMs) {
          await unlink(path);
          deleted++;
        }
      } catch (err) {
        console.warn(`[transcript-store] prune(${name}) error: ${(err as Error).message}`);
      }
    }
    return deleted;
  }

  pathFor(sessionId: string): string {
    return join(this.transcriptsDir, `${sessionId}.jsonl`);
  }
}
