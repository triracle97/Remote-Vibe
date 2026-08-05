import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { loadEnv } from '../env.js';
import { TranscriptStore } from '../transcript-store.js';
import { SessionRegistry } from '../session-registry.js';
import { SessionManager, type AgentDriver } from '../session.js';

// loadEnv needs a token plus somewhere to root allowedDirs/dataDir.
const BASE_ENV = { BRIDGE_TOKEN: 'a'.repeat(32), HOME: '/tmp/mrt-fake-home' };

describe('transcript retention defaults to keeping everything', () => {
  it('defaults to 0, which disables pruning', () => {
    expect(loadEnv({ ...BASE_ENV }).transcriptRetentionDays).toBe(0);
  });

  it('still honours an explicit retention window', () => {
    expect(
      loadEnv({ ...BASE_ENV, BRIDGE_TRANSCRIPT_RETENTION_DAYS: '30' }).transcriptRetentionDays,
    ).toBe(30);
  });

  it('rejects a negative window', () => {
    expect(() =>
      loadEnv({ ...BASE_ENV, BRIDGE_TRANSCRIPT_RETENTION_DAYS: '-1' }),
    ).toThrow(/non-negative/);
  });
});

describe('TranscriptStore.prune', () => {
  let dir: string;
  let store: TranscriptStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mrt-retain-'));
    store = new TranscriptStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Write a transcript file and backdate it. */
  async function ancient(name: string, daysOld: number): Promise<string> {
    const path = join(dir, 'transcripts', name);
    await writeFile(path, '{}\n');
    const when = new Date(Date.now() - daysOld * 86_400_000);
    await utimes(path, when, when);
    return path;
  }

  it('deletes nothing at retention 0, however old the file', async () => {
    // Force the transcripts dir into existence.
    store.append('seed', { type: 'system', event: 'session_created', sessionId: 'seed', seq: 1 });
    store.close('seed');
    await ancient('old.jsonl', 3650);
    expect(await store.prune(0)).toBe(0);
    expect(await readdir(join(dir, 'transcripts'))).toContain('old.jsonl');
  });

  it('deletes past the window when one is configured', async () => {
    store.append('seed', { type: 'system', event: 'session_created', sessionId: 'seed', seq: 1 });
    store.close('seed');
    await ancient('old.jsonl', 40);
    await ancient('recent.jsonl', 1);
    expect(await store.prune(30)).toBe(1);
    const left = await readdir(join(dir, 'transcripts'));
    expect(left).toContain('recent.jsonl');
    expect(left).not.toContain('old.jsonl');
  });
});

class FakeDriver extends EventEmitter implements AgentDriver {
  sendUserText(): void {}
  kill(): void {
    this.emit('exit', 0);
  }
}

describe('registry records the real transcript location', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mrt-tpath-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('points at the file the store actually writes', async () => {
    const dataDir = join(dir, 'data');
    const store = new TranscriptStore(dataDir);
    const registry = new SessionRegistry(join(dir, 'sessions.json'));
    await registry.load();
    const mgr = new SessionManager({
      allowedDirs: [dir],
      bufferCap: 100,
      registry,
      transcriptStore: store,
      realpath: async (p) => p,
      driverFactory: () => new FakeDriver(),
    });

    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    const recorded = registry.get(info.sessionId)!.transcriptPath;

    // Previously this recorded `.bridge/transcripts/<id>.jsonl` while the
    // store wrote under the data dir — every entry named a file that did not
    // exist.
    expect(recorded).toBe(store.pathFor(info.sessionId));
    expect(recorded.startsWith(dataDir)).toBe(true);
  });
});
