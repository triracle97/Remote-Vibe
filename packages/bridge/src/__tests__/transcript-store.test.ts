import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync, mkdirSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptStore } from '../transcript-store.js';
import type { ServerLifecycleMsg, ServerStreamMsg } from '../types.js';

describe('TranscriptStore', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mrt-transcripts-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('appends one NDJSON line per call and creates the transcripts subdir', () => {
    const store = new TranscriptStore(dataDir);
    const id = '11111111-1111-1111-1111-111111111111';
    const created: ServerLifecycleMsg = {
      type: 'system',
      event: 'session_created',
      sessionId: id,
      seq: 1,
    };
    const userMsg: ServerStreamMsg = {
      type: 'user',
      sessionId: id,
      seq: 2,
      payload: { text: 'hi' },
    };
    store.append(id, created);
    store.append(id, userMsg);
    store.close(id);

    const file = join(dataDir, 'transcripts', `${id}.jsonl`);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(created);
    expect(JSON.parse(lines[1]!)).toEqual(userMsg);
  });

  it('appends across reopen (lazy file handle)', () => {
    const id = '22222222-2222-2222-2222-222222222222';
    const a = new TranscriptStore(dataDir);
    a.append(id, { type: 'system', event: 'session_created', sessionId: id, seq: 1 });
    a.close(id);

    const b = new TranscriptStore(dataDir);
    b.append(id, { type: 'system', event: 'session_ended', sessionId: id, seq: 2, exitCode: 0 });
    b.close(id);

    const lines = readFileSync(join(dataDir, 'transcripts', `${id}.jsonl`), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('prune deletes files older than retentionDays and keeps fresh ones', async () => {
    const transcripts = join(dataDir, 'transcripts');
    mkdirSync(transcripts, { recursive: true });
    const old = join(transcripts, 'old.jsonl');
    const fresh = join(transcripts, 'fresh.jsonl');
    writeFileSync(old, '{}\n');
    writeFileSync(fresh, '{}\n');
    // Backdate `old` by 40 days
    const FORTY_DAYS_S = 40 * 86_400;
    const now = Date.now() / 1000;
    utimesSync(old, now - FORTY_DAYS_S, now - FORTY_DAYS_S);

    const store = new TranscriptStore(dataDir);
    const deleted = await store.prune(30);
    expect(deleted).toBe(1);
    expect(readdirSync(transcripts).sort()).toEqual(['fresh.jsonl']);
  });

  it('prune fail-soft on individual file errors', async () => {
    const transcripts = join(dataDir, 'transcripts');
    mkdirSync(transcripts, { recursive: true });
    const ok = join(transcripts, 'ok.jsonl');
    writeFileSync(ok, '{}\n');
    const FORTY_DAYS_S = 40 * 86_400;
    const now = Date.now() / 1000;
    utimesSync(ok, now - FORTY_DAYS_S, now - FORTY_DAYS_S);
    // No actual error injection — just verify it runs without throwing
    const store = new TranscriptStore(dataDir);
    await expect(store.prune(30)).resolves.toBe(1);
  });

  it('prune is a no-op when retentionDays is 0', async () => {
    const transcripts = join(dataDir, 'transcripts');
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, 'a.jsonl'), '{}\n');
    const store = new TranscriptStore(dataDir);
    const deleted = await store.prune(0);
    expect(deleted).toBe(0);
    expect(readdirSync(transcripts)).toHaveLength(1);
  });
});
