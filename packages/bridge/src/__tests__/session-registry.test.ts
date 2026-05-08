import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistry } from '../session-registry';

describe('SessionRegistry', () => {
  let dir: string;
  let registryPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reg-test-'));
    registryPath = join(dir, 'sessions.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('load() returns empty registry when file does not exist', async () => {
    const reg = new SessionRegistry(registryPath);
    await reg.load();
    expect(reg.get('any-id')).toBeUndefined();
  });

  it('add() persists entry to disk', async () => {
    const reg = new SessionRegistry(registryPath);
    await reg.load();
    await reg.add({
      webSessionId: 'web-1',
      agent: 'claude',
      projectPath: '/tmp/proj',
      transcriptPath: '.bridge/transcripts/web-1.jsonl',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 1000,
      account: null,
    });
    const raw = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(raw.sessions['web-1'].agent).toBe('claude');
    expect(raw.sessions['web-1'].claudeSessionId).toBeNull();
  });

  it('update() merges fields and persists', async () => {
    const reg = new SessionRegistry(registryPath);
    await reg.load();
    await reg.add({
      webSessionId: 'web-1',
      agent: 'claude',
      projectPath: '/tmp/proj',
      transcriptPath: '.bridge/transcripts/web-1.jsonl',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 1000,
      account: null,
    });
    await reg.update('web-1', { claudeSessionId: 'abc-123' });
    const entry = reg.get('web-1');
    expect(entry?.claudeSessionId).toBe('abc-123');
    const raw = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(raw.sessions['web-1'].claudeSessionId).toBe('abc-123');
  });

  it('load() restores entries written by a previous instance', async () => {
    const reg1 = new SessionRegistry(registryPath);
    await reg1.load();
    await reg1.add({
      webSessionId: 'web-1',
      agent: 'codex',
      projectPath: '/tmp/x',
      transcriptPath: '.bridge/transcripts/web-1.jsonl',
      claudeSessionId: null,
      codexSessionId: 'codex-uuid',
      createdAt: 2000,
      account: 'default',
    });
    const reg2 = new SessionRegistry(registryPath);
    await reg2.load();
    expect(reg2.get('web-1')?.codexSessionId).toBe('codex-uuid');
  });

  it('serializes concurrent writes — no torn file under rapid updates', async () => {
    const reg = new SessionRegistry(registryPath);
    await reg.load();
    await reg.add({
      webSessionId: 'web-1',
      agent: 'claude',
      projectPath: '/tmp/proj',
      transcriptPath: '.bridge/transcripts/web-1.jsonl',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 1000,
      account: null,
    });
    // Fire 50 concurrent updates each with a different value.
    const writes = Array.from({ length: 50 }, (_, i) =>
      reg.update('web-1', { claudeSessionId: `id-${i}` }),
    );
    await Promise.all(writes);
    // After all settle, file must be valid JSON and contain ONE of the values.
    const raw = JSON.parse(readFileSync(registryPath, 'utf-8'));
    const final = raw.sessions['web-1'].claudeSessionId;
    expect(final).toMatch(/^id-\d+$/);
  });

  it('writes the registry file with mode 0o600', async () => {
    const reg = new SessionRegistry(registryPath);
    await reg.load();
    await reg.add({
      webSessionId: 'web-1',
      agent: 'claude',
      projectPath: '/tmp/p',
      transcriptPath: '.bridge/transcripts/web-1.jsonl',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 0,
      account: null,
    });
    const stat = statSync(registryPath);
    expect((stat.mode & 0o777).toString(8)).toBe('600');
  });

  it('falls back to empty registry when existing file is corrupt', async () => {
    writeFileSync(registryPath, '{ this is not json', { mode: 0o600 });
    const reg = new SessionRegistry(registryPath);
    await reg.load();
    expect(reg.get('any')).toBeUndefined();
  });

  it('remove() deletes entry and persists', async () => {
    const reg = new SessionRegistry(registryPath);
    await reg.load();
    await reg.add({
      webSessionId: 'web-1',
      agent: 'claude',
      projectPath: '/tmp/p',
      transcriptPath: '.bridge/transcripts/web-1.jsonl',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 0,
      account: null,
    });
    await reg.remove('web-1');
    expect(reg.get('web-1')).toBeUndefined();
    const raw = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(raw.sessions['web-1']).toBeUndefined();
  });
});
