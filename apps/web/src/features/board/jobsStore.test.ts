import { describe, it, expect, beforeEach, vi } from 'vitest';
import { jobMatchesFilter, sortedJobs, useJobsStore } from './jobsStore';
import type { ClientMsg, JobSummary } from '../../types/protocol';

const sent: ClientMsg[] = [];
vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: () => ({
    send: (m: ClientMsg) => {
      sent.push(m);
    },
  }),
}));

function job(over: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 'j1',
    title: 'fix auth expiry',
    notes: '',
    tags: [],
    projectPath: '/Volumes/Code/thing',
    additionalDirs: [],
    agent: 'claude',
    account: null,
    claudeConfig: null,
  model: null,
  effort: null,
    createdAt: 1000,
    updatedAt: 1000,
    startedSessionId: null,
    startedAt: null,
    archived: false,
    ...over,
  };
}

const INPUT = {
  title: 'fix auth expiry',
  notes: 'detail',
  tags: ['api'],
  projectPath: '/proj',
  additionalDirs: [],
  agent: 'claude' as const,
  account: null,
  claudeConfig: null,
  model: null,
  effort: null,
};

beforeEach(() => {
  sent.length = 0;
  useJobsStore.setState({
    jobs: {},
    loaded: false,
    starting: {},
    error: null,
    lastStarted: null,
  });
});

describe('sortedJobs', () => {
  it('puts newest first', () => {
    const jobs = {
      old: job({ id: 'old', createdAt: 1 }),
      new: job({ id: 'new', createdAt: 99 }),
    };
    expect(sortedJobs(jobs).map((j) => j.id)).toEqual(['new', 'old']);
  });
});

describe('jobMatchesFilter', () => {
  const base = { search: '', tags: [] as string[] };

  it('matches title, notes, path and tags', () => {
    const j = job({ title: 'Fix Parser', notes: 'the lexer', projectPath: '/a/widgets', tags: ['urgent'] });
    for (const q of ['fix', 'LEXER', 'widgets', 'urg']) {
      expect(jobMatchesFilter(j, { ...base, search: q })).toBe(true);
    }
    expect(jobMatchesFilter(j, { ...base, search: 'nope' })).toBe(false);
  });

  it('requires every selected tag', () => {
    const j = job({ tags: ['api'] });
    expect(jobMatchesFilter(j, { ...base, tags: ['api'] })).toBe(true);
    expect(jobMatchesFilter(j, { ...base, tags: ['api', 'bug'] })).toBe(false);
  });

  it('matches everything on an empty query', () => {
    expect(jobMatchesFilter(job(), base)).toBe(true);
  });
});

describe('jobs store server messages', () => {
  it('hydrates from job_list', () => {
    useJobsStore.getState().applyServerMsg({ type: 'job_list', jobs: [job({ id: 'a' })] });
    expect(useJobsStore.getState().loaded).toBe(true);
    expect(useJobsStore.getState().jobs.a).toBeDefined();
  });

  it('adds a job on upsert', () => {
    useJobsStore.getState().applyServerMsg({ type: 'job_upserted', job: job({ id: 'a' }) });
    expect(useJobsStore.getState().jobs.a!.title).toBe('fix auth expiry');
  });

  it('drops a started job from the backlog', () => {
    useJobsStore.setState({ jobs: { a: job({ id: 'a' }) } });
    useJobsStore.getState().applyServerMsg({
      type: 'job_upserted',
      job: job({ id: 'a', startedSessionId: 'sess-1' }),
    });
    expect(useJobsStore.getState().jobs.a).toBeUndefined();
  });

  it('drops an archived job from the backlog', () => {
    useJobsStore.setState({ jobs: { a: job({ id: 'a' }) } });
    useJobsStore.getState().applyServerMsg({
      type: 'job_upserted',
      job: job({ id: 'a', archived: true }),
    });
    expect(useJobsStore.getState().jobs.a).toBeUndefined();
  });

  it('drops a deleted job', () => {
    useJobsStore.setState({ jobs: { a: job({ id: 'a' }) } });
    useJobsStore.getState().applyServerMsg({ type: 'job_deleted', jobId: 'a' });
    expect(useJobsStore.getState().jobs.a).toBeUndefined();
  });

  it('records the session a start produced and clears the pending flag', () => {
    useJobsStore.setState({ starting: { a: true } });
    useJobsStore.getState().applyServerMsg({
      type: 'job_started',
      jobId: 'a',
      sessionId: 'sess-7',
    });
    expect(useJobsStore.getState().starting.a).toBeUndefined();
    expect(useJobsStore.getState().lastStarted).toEqual({ jobId: 'a', sessionId: 'sess-7' });
  });
});

describe('jobs store mutations', () => {
  it('sends create_job with the form values', () => {
    useJobsStore.getState().createJob(INPUT);
    expect(sent[0]).toMatchObject({
      type: 'create_job',
      title: 'fix auth expiry',
      notes: 'detail',
      tags: ['api'],
      projectPath: '/proj',
      agent: 'claude',
    });
  });

  it('does not invent a card before the bridge confirms', () => {
    useJobsStore.getState().createJob(INPUT);
    expect(Object.keys(useJobsStore.getState().jobs)).toHaveLength(0);
  });

  it('removes a deleted card immediately and restores it on failure', () => {
    useJobsStore.setState({ jobs: { a: job({ id: 'a', title: 'keepme' }) } });
    useJobsStore.getState().deleteJob('a');
    expect(useJobsStore.getState().jobs.a).toBeUndefined();

    const correlationId = (sent[0] as { correlationId: string }).correlationId;
    useJobsStore.getState().applyServerMsg({
      type: 'error',
      code: 'job_not_found',
      message: 'gone',
      correlationId,
    });
    expect(useJobsStore.getState().jobs.a!.title).toBe('keepme');
    expect(useJobsStore.getState().error).toBe('gone');
  });

  it('marks a job as starting and clears it on failure', () => {
    useJobsStore.setState({ jobs: { a: job({ id: 'a' }) } });
    useJobsStore.getState().startJob('a');
    expect(useJobsStore.getState().starting.a).toBe(true);

    const correlationId = (sent[0] as { correlationId: string }).correlationId;
    useJobsStore.getState().applyServerMsg({
      type: 'error',
      code: 'job_already_started',
      message: 'already started',
      correlationId,
    });
    expect(useJobsStore.getState().starting.a).toBeUndefined();
    expect(useJobsStore.getState().error).toBe('already started');
  });

  it('ignores a repeat start while one is in flight', () => {
    useJobsStore.setState({ jobs: { a: job({ id: 'a' }) } });
    useJobsStore.getState().startJob('a');
    useJobsStore.getState().startJob('a');
    expect(sent.filter((m) => m.type === 'start_job')).toHaveLength(1);
  });

  it('ignores an unrelated error', () => {
    useJobsStore.setState({ jobs: { a: job({ id: 'a' }) } });
    useJobsStore.getState().startJob('a');
    useJobsStore.getState().applyServerMsg({
      type: 'error',
      code: 'agent_not_installed',
      message: 'unrelated',
      correlationId: 'someone-else',
    });
    expect(useJobsStore.getState().starting.a).toBe(true);
    expect(useJobsStore.getState().error).toBeNull();
  });

  it('does nothing when deleting an unknown job', () => {
    useJobsStore.getState().deleteJob('ghost');
    expect(sent).toHaveLength(0);
  });
});
