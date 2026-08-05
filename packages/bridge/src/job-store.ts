import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEffortLevel, parseModelId, type EffortLevel } from './models.js';
import type { AgentKind } from './types.js';

/**
 * A **job** is work you intend to do, written down before any agent runs.
 *
 * This is the Backlog column. Sessions are the record of work that *has*
 * started, so a session can never sit in Backlog — by the time it exists, the
 * work is underway. Starting a job spawns a session seeded with the job's
 * text, copies the tags across, and links the two.
 *
 * Modelled on nimbalyst's tracker → session launch
 * (`packages/electron/src/renderer/components/TrackerMode/trackerSessionLaunch.ts`).
 */
export interface Job {
  id: string;
  title: string;
  /** Free-form detail appended to the launch prompt. */
  notes: string;
  tags: string[];
  /** Primary cwd for the session this job will start. */
  projectPath: string;
  /** Extra dirs, passed through to the spawn as `--add-dir`. */
  additionalDirs: string[];
  agent: AgentKind;
  /** Codex account name, if the job targets Codex. */
  account: string | null;
  /** Named Claude profile, if not the default. */
  claudeConfig: string | null;
  /** Model/effort the launched session should run with; null = CLI default. */
  model: string | null;
  effort: EffortLevel | null;
  createdAt: number;
  updatedAt: number;
  /**
   * Set once the job is started. A started job leaves the Backlog — its
   * session card carries the work from then on. Kept rather than deleted so
   * the session can be traced back to the job that asked for it.
   */
  startedSessionId: string | null;
  startedAt: number | null;
  archived: boolean;
}

interface JobsFile {
  jobs: Record<string, Job>;
}

export interface CreateJobInput {
  title: string;
  notes?: string;
  tags?: string[];
  projectPath: string;
  additionalDirs?: string[];
  agent: AgentKind;
  account?: string | null;
  claudeConfig?: string | null;
  model?: string | null;
  effort?: EffortLevel | null;
}

export class InvalidJobError extends Error {
  code = 'job_invalid' as const;
  constructor(message: string) {
    super(message);
  }
}

export class JobNotFoundError extends Error {
  code = 'job_not_found' as const;
  constructor(public jobId: string) {
    super(`[job_not_found] no job ${jobId}`);
  }
}

const MAX_TITLE = 200;
const MAX_NOTES = 10_000;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;

/** Shared with session tags so a job's tags survive the hand-off unchanged. */
export function normalizeTags(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new InvalidJobError('tags must be an array');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') throw new InvalidJobError('tags must be strings');
    const tag = item.trim().replace(/\s+/g, '-');
    if (tag.length === 0) continue;
    if (tag.length > MAX_TAG_LEN) throw new InvalidJobError(`tag too long: ${tag.slice(0, 20)}…`);
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(tag)) throw new InvalidJobError('tags must not contain control characters');
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  if (out.length > MAX_TAGS) throw new InvalidJobError(`at most ${MAX_TAGS} tags`);
  return out;
}

function validateTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidJobError('title is required');
  const title = raw.trim().replace(/\s+/g, ' ');
  if (title.length === 0) throw new InvalidJobError('title cannot be empty');
  if (title.length > MAX_TITLE) throw new InvalidJobError(`title must be ≤ ${MAX_TITLE} chars`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(title)) throw new InvalidJobError('title must not contain control characters');
  return title;
}

function validateNotes(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new InvalidJobError('notes must be a string');
  if (raw.length > MAX_NOTES) throw new InvalidJobError(`notes must be ≤ ${MAX_NOTES} chars`);
  return raw;
}

/**
 * The prompt a started job hands to the agent.
 *
 * Title first so it reads as an instruction; notes appended verbatim because
 * they are the detail the user bothered to write down.
 */
export function jobLaunchPrompt(job: Job): string {
  const notes = job.notes.trim();
  return notes.length > 0 ? `${job.title}\n\n${notes}` : job.title;
}

/**
 * Disk-backed job list. Mirrors `SessionRegistry`'s durability: atomic
 * tmpfile + fsync + rename through a serialized write queue, 0600, and a
 * corrupt file degrades to empty rather than crashing the bridge on boot.
 */
export class JobStore {
  private state: JobsFile = { jobs: {} };
  private writeQueue: Promise<void> = Promise.resolve();
  private writeCounter = 0;
  private loaded = false;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const buf = await fsp.readFile(this.path, 'utf-8');
      const parsed = JSON.parse(buf) as JobsFile;
      if (parsed && typeof parsed === 'object' && parsed.jobs && typeof parsed.jobs === 'object') {
        this.state = parsed;
        for (const [id, raw] of Object.entries(this.state.jobs)) {
          const j = raw as Partial<Job>;
          this.state.jobs[id] = {
            id: j.id ?? id,
            title: j.title ?? '(untitled)',
            notes: j.notes ?? '',
            tags: j.tags ?? [],
            projectPath: j.projectPath ?? '',
            additionalDirs: j.additionalDirs ?? [],
            agent: j.agent ?? 'claude',
            account: j.account ?? null,
            claudeConfig: j.claudeConfig ?? null,
            model: parseModelId(j.model),
            effort: parseEffortLevel(j.effort),
            createdAt: j.createdAt ?? 0,
            updatedAt: j.updatedAt ?? j.createdAt ?? 0,
            startedSessionId: j.startedSessionId ?? null,
            startedAt: j.startedAt ?? null,
            archived: j.archived ?? false,
          };
        }
      } else {
        this.state = { jobs: {} };
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[job-store] failed to load, starting empty:', err);
      }
      this.state = { jobs: {} };
    }
    this.loaded = true;
  }

  get(id: string): Job | undefined {
    return this.state.jobs[id];
  }

  /** Newest first — the Backlog reads top-down. */
  all(opts: { includeArchived?: boolean; includeStarted?: boolean } = {}): Job[] {
    return Object.values(this.state.jobs)
      .filter((j) => (opts.includeArchived ? true : !j.archived))
      .filter((j) => (opts.includeStarted ? true : j.startedSessionId === null))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async create(input: CreateJobInput): Promise<Job> {
    this.assertLoaded();
    if (typeof input.projectPath !== 'string' || input.projectPath.length === 0) {
      throw new InvalidJobError('projectPath is required');
    }
    if (input.agent !== 'claude' && input.agent !== 'codex') {
      throw new InvalidJobError('agent must be claude or codex');
    }
    const now = Date.now();
    const job: Job = {
      id: randomUUID(),
      title: validateTitle(input.title),
      notes: validateNotes(input.notes),
      tags: normalizeTags(input.tags),
      projectPath: input.projectPath,
      additionalDirs: Array.isArray(input.additionalDirs) ? input.additionalDirs : [],
      agent: input.agent,
      account: input.account ?? null,
      claudeConfig: input.claudeConfig ?? null,
      model: parseModelId(input.model),
      effort: parseEffortLevel(input.effort),
      createdAt: now,
      updatedAt: now,
      startedSessionId: null,
      startedAt: null,
      archived: false,
    };
    this.state.jobs[job.id] = job;
    await this.persist();
    return job;
  }

  /** Only the user-editable fields; lifecycle fields move via `markStarted`. */
  async update(
    id: string,
    patch: {
      title?: unknown;
      notes?: unknown;
      tags?: unknown;
      projectPath?: string;
      additionalDirs?: string[];
      agent?: AgentKind;
      account?: string | null;
      claudeConfig?: string | null;
      model?: string | null;
      effort?: EffortLevel | null;
      archived?: boolean;
    },
  ): Promise<Job> {
    this.assertLoaded();
    const existing = this.state.jobs[id];
    if (!existing) throw new JobNotFoundError(id);

    const next: Job = { ...existing, updatedAt: Date.now() };
    if (patch.title !== undefined) next.title = validateTitle(patch.title);
    if (patch.notes !== undefined) next.notes = validateNotes(patch.notes);
    if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags);
    if (patch.projectPath !== undefined) next.projectPath = patch.projectPath;
    if (patch.additionalDirs !== undefined) next.additionalDirs = patch.additionalDirs;
    if (patch.agent !== undefined) {
      if (patch.agent !== 'claude' && patch.agent !== 'codex') {
        throw new InvalidJobError('agent must be claude or codex');
      }
      next.agent = patch.agent;
    }
    if (patch.account !== undefined) next.account = patch.account;
    if (patch.claudeConfig !== undefined) next.claudeConfig = patch.claudeConfig;
    // Re-validated on every write: a job row is user input that outlives the
    // request that created it.
    if (patch.model !== undefined) next.model = parseModelId(patch.model);
    if (patch.effort !== undefined) next.effort = parseEffortLevel(patch.effort);
    if (patch.archived !== undefined) next.archived = patch.archived === true;

    this.state.jobs[id] = next;
    await this.persist();
    return next;
  }

  /** Link the job to the session it spawned. Idempotent per job. */
  async markStarted(id: string, sessionId: string): Promise<Job> {
    this.assertLoaded();
    const existing = this.state.jobs[id];
    if (!existing) throw new JobNotFoundError(id);
    const next: Job = {
      ...existing,
      startedSessionId: sessionId,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.state.jobs[id] = next;
    await this.persist();
    return next;
  }

  async remove(id: string): Promise<void> {
    this.assertLoaded();
    if (!(id in this.state.jobs)) throw new JobNotFoundError(id);
    delete this.state.jobs[id];
    await this.persist();
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('JobStore: load() must be awaited before mutations');
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    const counter = ++this.writeCounter;
    const tmpPath = `${this.path}.tmp.${process.pid}.${counter}`;
    const queued = this.writeQueue.then(async () => {
      await fsp.mkdir(dirname(this.path), { recursive: true });
      const fh = await fsp.open(tmpPath, 'w', 0o600);
      try {
        await fh.writeFile(snapshot, 'utf-8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fsp.rename(tmpPath, this.path);
    });
    // Keep the chain alive even if one write fails.
    this.writeQueue = queued.catch(() => {});
    return queued;
  }
}
