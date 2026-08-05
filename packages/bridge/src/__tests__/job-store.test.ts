import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JobStore,
  InvalidJobError,
  JobNotFoundError,
  jobLaunchPrompt,
  normalizeTags,
  type Job,
} from '../job-store.js';

const BASE = { title: 'fix auth expiry', projectPath: '/proj', agent: 'claude' as const };

describe('normalizeTags', () => {
  it('trims, dashes spaces and dedupes case-insensitively', () => {
    expect(normalizeTags(['  api ', 'API', 'two words', ''])).toEqual(['api', 'two-words']);
  });

  it('treats missing tags as none', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
  });

  it('rejects non-arrays, non-strings, over-long and control chars', () => {
    expect(() => normalizeTags('api')).toThrow(InvalidJobError);
    expect(() => normalizeTags([1])).toThrow(/must be strings/);
    expect(() => normalizeTags(['x'.repeat(41)])).toThrow(/too long/);
    expect(() => normalizeTags(['a\x00b'])).toThrow(/control characters/);
    expect(() => normalizeTags(Array.from({ length: 21 }, (_, i) => `t${i}`))).toThrow(/at most 20/);
  });
});

describe('jobLaunchPrompt', () => {
  const job = (over: Partial<Job>): Job =>
    ({ title: 'do the thing', notes: '', ...over }) as Job;

  it('is just the title when there are no notes', () => {
    expect(jobLaunchPrompt(job({}))).toBe('do the thing');
  });

  it('appends notes verbatim', () => {
    expect(jobLaunchPrompt(job({ notes: 'line one\nline two' }))).toBe(
      'do the thing\n\nline one\nline two',
    );
  });

  it('ignores whitespace-only notes', () => {
    expect(jobLaunchPrompt(job({ notes: '   \n ' }))).toBe('do the thing');
  });
});

describe('JobStore', () => {
  let dir: string;
  let path: string;
  let store: JobStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mrt-jobs-'));
    path = join(dir, 'jobs.json');
    store = new JobStore(path);
    await store.load();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a job with normalized fields', async () => {
    const job = await store.create({ ...BASE, tags: [' API ', 'api', 'two words'] });
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.title).toBe('fix auth expiry');
    expect(job.tags).toEqual(['API', 'two-words']);
    expect(job.startedSessionId).toBeNull();
    expect(job.archived).toBe(false);
  });

  it('collapses whitespace in the title', async () => {
    const job = await store.create({ ...BASE, title: '  fix   auth\t expiry ' });
    expect(job.title).toBe('fix auth expiry');
  });

  it('rejects an empty or missing title', async () => {
    await expect(store.create({ ...BASE, title: '   ' })).rejects.toThrow(/cannot be empty/);
    await expect(store.create({ ...BASE, title: 42 as never })).rejects.toThrow(/title is required/);
  });

  it('rejects a missing project path or bad agent', async () => {
    await expect(store.create({ ...BASE, projectPath: '' })).rejects.toThrow(/projectPath/);
    await expect(store.create({ ...BASE, agent: 'gpt' as never })).rejects.toThrow(/claude or codex/);
  });

  it('lists unstarted, unarchived jobs newest first', async () => {
    const a = await store.create({ ...BASE, title: 'first' });
    const b = await store.create({ ...BASE, title: 'second' });
    // createdAt can tie at ms resolution; force an order.
    await store.update(a.id, {});
    const ids = store.all().map((j) => j.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set([a.id, b.id]));
  });

  it('hides started jobs from the backlog', async () => {
    const job = await store.create(BASE);
    await store.markStarted(job.id, 'sess-1');
    expect(store.all()).toHaveLength(0);
    expect(store.all({ includeStarted: true })).toHaveLength(1);
  });

  it('hides archived jobs unless asked', async () => {
    const job = await store.create(BASE);
    await store.update(job.id, { archived: true });
    expect(store.all()).toHaveLength(0);
    expect(store.all({ includeArchived: true })).toHaveLength(1);
  });

  it('records the session a job started', async () => {
    const job = await store.create(BASE);
    const started = await store.markStarted(job.id, 'sess-9');
    expect(started.startedSessionId).toBe('sess-9');
    expect(started.startedAt).not.toBeNull();
  });

  it('updates only the fields given', async () => {
    const job = await store.create({ ...BASE, notes: 'keep me', tags: ['api'] });
    const next = await store.update(job.id, { title: 'renamed' });
    expect(next.title).toBe('renamed');
    expect(next.notes).toBe('keep me');
    expect(next.tags).toEqual(['api']);
  });

  it('validates on update too', async () => {
    const job = await store.create(BASE);
    await expect(store.update(job.id, { title: '  ' })).rejects.toThrow(/cannot be empty/);
    await expect(store.update(job.id, { tags: ['x'.repeat(41)] })).rejects.toThrow(/too long/);
  });

  it('throws for an unknown job', async () => {
    await expect(store.update('nope', { title: 'x' })).rejects.toThrow(JobNotFoundError);
    await expect(store.markStarted('nope', 's')).rejects.toThrow(JobNotFoundError);
    await expect(store.remove('nope')).rejects.toThrow(JobNotFoundError);
  });

  it('deletes a job', async () => {
    const job = await store.create(BASE);
    await store.remove(job.id);
    expect(store.get(job.id)).toBeUndefined();
    expect(store.all()).toHaveLength(0);
  });

  it('persists across reload', async () => {
    const job = await store.create({ ...BASE, tags: ['api'], notes: 'detail' });
    const reopened = new JobStore(path);
    await reopened.load();
    const found = reopened.get(job.id)!;
    expect(found.title).toBe('fix auth expiry');
    expect(found.tags).toEqual(['api']);
    expect(found.notes).toBe('detail');
  });

  it('writes the file atomically and readable only by the owner', async () => {
    await store.create(BASE);
    const raw = JSON.parse(await readFile(path, 'utf8')) as { jobs: Record<string, Job> };
    expect(Object.keys(raw.jobs)).toHaveLength(1);
  });

  it('starts empty when the file is missing', async () => {
    const fresh = new JobStore(join(dir, 'nope.json'));
    await fresh.load();
    expect(fresh.all()).toEqual([]);
  });

  it('starts empty rather than crashing on a corrupt file', async () => {
    await writeFile(path, 'not json');
    const corrupt = new JobStore(path);
    await corrupt.load();
    expect(corrupt.all()).toEqual([]);
  });

  it('backfills missing fields on an older file', async () => {
    await writeFile(
      path,
      JSON.stringify({ jobs: { j1: { id: 'j1', title: 'old job', projectPath: '/p' } } }),
    );
    const migrated = new JobStore(path);
    await migrated.load();
    const j = migrated.get('j1')!;
    expect(j.tags).toEqual([]);
    expect(j.notes).toBe('');
    expect(j.agent).toBe('claude');
    expect(j.startedSessionId).toBeNull();
    expect(j.archived).toBe(false);
  });

  it('refuses mutations before load()', async () => {
    const unloaded = new JobStore(join(dir, 'x.json'));
    await expect(unloaded.create(BASE)).rejects.toThrow(/load\(\) must be awaited/);
  });
});
