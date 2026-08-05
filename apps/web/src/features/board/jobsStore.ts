import { create } from 'zustand';
import { getBridgeClient } from '../../services/bridge-client-singleton';
import type { AgentKind, EffortLevel, JobSummary, ServerMsg } from '../../types/protocol';

/**
 * Backlog jobs — work written down before an agent runs.
 *
 * Unlike the session board, mutations here are *not* optimistic: creating a
 * job is a deliberate act with a form behind it, so waiting for the bridge to
 * echo `job_upserted` costs nothing and avoids inventing an id client-side.
 * The one exception is delete, which removes the card immediately because the
 * card is the only feedback the action has.
 */

export interface NewJobInput {
  title: string;
  notes: string;
  tags: string[];
  projectPath: string;
  additionalDirs: string[];
  agent: AgentKind;
  account: string | null;
  claudeConfig: string | null;
  model: string | null;
  effort: EffortLevel | null;
}

interface JobsState {
  jobs: Record<string, JobSummary>;
  loaded: boolean;
  /** Job ids with a `start_job` in flight, so the button can show progress. */
  starting: Record<string, true>;
  error: string | null;
  /** Session id from the most recent start, for the caller to navigate to. */
  lastStarted: { jobId: string; sessionId: string } | null;

  applyServerMsg: (m: ServerMsg) => void;
  refresh: () => void;
  createJob: (input: NewJobInput) => void;
  updateJob: (jobId: string, patch: Partial<NewJobInput> & { archived?: boolean }) => void;
  deleteJob: (jobId: string) => void;
  startJob: (jobId: string) => void;
  clearError: () => void;
  clearLastStarted: () => void;
}

let counter = 0;
function nextCorrelationId(kind: string): string {
  counter += 1;
  return `job-${kind}-${counter}`;
}

/** Correlation id → job it belongs to, so an error can clear the right state. */
const pending = new Map<string, { jobId: string | null; restore?: JobSummary }>();

export const useJobsStore = create<JobsState>((set, get) => ({
  jobs: {},
  loaded: false,
  starting: {},
  error: null,
  lastStarted: null,

  applyServerMsg: (m) => {
    switch (m.type) {
      case 'job_list': {
        const jobs: Record<string, JobSummary> = {};
        for (const j of m.jobs) jobs[j.id] = j;
        set({ jobs, loaded: true });
        return;
      }
      case 'job_upserted': {
        if (m.correlationId) pending.delete(m.correlationId);
        // A started job leaves the Backlog — drop it rather than render a
        // card whose work has moved to a session.
        if (m.job.startedSessionId !== null || m.job.archived) {
          const jobs = { ...get().jobs };
          delete jobs[m.job.id];
          set({ jobs });
          return;
        }
        set({ jobs: { ...get().jobs, [m.job.id]: m.job } });
        return;
      }
      case 'job_deleted': {
        if (m.correlationId) pending.delete(m.correlationId);
        const jobs = { ...get().jobs };
        delete jobs[m.jobId];
        set({ jobs });
        return;
      }
      case 'job_started': {
        if (m.correlationId) pending.delete(m.correlationId);
        const starting = { ...get().starting };
        delete starting[m.jobId];
        set({ starting, lastStarted: { jobId: m.jobId, sessionId: m.sessionId } });
        return;
      }
      case 'error': {
        const entry = m.correlationId ? pending.get(m.correlationId) : undefined;
        if (!entry) return;
        pending.delete(m.correlationId!);
        const next: Partial<JobsState> = { error: m.message };
        if (entry.jobId !== null) {
          const starting = { ...get().starting };
          delete starting[entry.jobId];
          next.starting = starting;
          // Put back a card removed optimistically by delete.
          if (entry.restore) next.jobs = { ...get().jobs, [entry.jobId]: entry.restore };
        }
        set(next);
        return;
      }
      default:
        return;
    }
  },

  refresh: () => {
    getBridgeClient().send({ type: 'list_jobs' });
  },

  createJob: (input) => {
    const correlationId = nextCorrelationId('create');
    pending.set(correlationId, { jobId: null });
    getBridgeClient().send({
      type: 'create_job',
      title: input.title,
      notes: input.notes,
      tags: input.tags,
      projectPath: input.projectPath,
      additionalDirs: input.additionalDirs,
      agent: input.agent,
      account: input.account,
      claudeConfig: input.claudeConfig,
      correlationId,
    });
  },

  updateJob: (jobId, patch) => {
    const correlationId = nextCorrelationId('update');
    pending.set(correlationId, { jobId });
    getBridgeClient().send({ type: 'update_job', jobId, ...patch, correlationId });
  },

  deleteJob: (jobId) => {
    const existing = get().jobs[jobId];
    if (!existing) return;
    const correlationId = nextCorrelationId('delete');
    pending.set(correlationId, { jobId, restore: existing });
    const jobs = { ...get().jobs };
    delete jobs[jobId];
    set({ jobs });
    getBridgeClient().send({ type: 'delete_job', jobId, correlationId });
  },

  startJob: (jobId) => {
    if (get().starting[jobId]) return;
    const correlationId = nextCorrelationId('start');
    pending.set(correlationId, { jobId });
    set({ starting: { ...get().starting, [jobId]: true } });
    getBridgeClient().send({ type: 'start_job', jobId, correlationId });
  },

  clearError: () => set({ error: null }),
  clearLastStarted: () => set({ lastStarted: null }),
}));

/** Backlog order: newest first, matching the bridge. */
export function sortedJobs(jobs: Record<string, JobSummary>): JobSummary[] {
  return Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt);
}

/** Same filter semantics as session cards, so the filter bar governs both. */
export function jobMatchesFilter(
  job: JobSummary,
  filter: { search: string; tags: string[] },
): boolean {
  if (filter.tags.length > 0 && !filter.tags.every((t) => job.tags.includes(t))) return false;
  const q = filter.search.trim().toLowerCase();
  if (q.length === 0) return true;
  return (
    job.title.toLowerCase().includes(q) ||
    job.notes.toLowerCase().includes(q) ||
    job.projectPath.toLowerCase().includes(q) ||
    job.tags.some((t) => t.toLowerCase().includes(q))
  );
}
