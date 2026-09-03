import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { JSX } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { Board } from './Board';
import { JobCard } from './JobCard';
import { JobEditor } from './JobEditor';
import { useBoardStore } from './boardStore';
import { useJobsStore } from './jobsStore';
import { useAccountsStore } from '../../store/accounts';
import { SESSION_PHASE_COLUMNS } from '../../types/protocol';
import type { BoardSession, ClientMsg, JobSummary } from '../../types/protocol';

// vitest runs with `globals: false`, so RTL auto-cleanup never registers.
afterEach(cleanup);

const sent: ClientMsg[] = [];
vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: () => ({ send: (m: ClientMsg) => sent.push(m) }),
}));

function job(over: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 'j1',
    title: 'fix auth expiry',
    notes: 'use <= not <',
    tags: ['api'],
    projectPath: '/Volumes/Code/thing',
    additionalDirs: [],
    agent: 'claude',
    account: null,
    claudeConfig: null,
    model: null,
    effort: null,
    priority: 'normal',
    createdAt: 1000,
    updatedAt: 1000,
    startedSessionId: null,
    startedAt: null,
    archived: false,
    ...over,
  };
}

function session(over: Partial<BoardSession> = {}): BoardSession {
  return {
    sessionId: 's1',
    agent: 'claude',
    projectPath: '/Volumes/Code/thing',
    additionalDirs: [],
    createdAt: 1000,
    lastActiveAt: 1000,
    endedAt: null,
    name: 'a session',
    namePinned: false,
    status: 'ended',
    alive: false,
    phase: 'done',
    phasePinned: false,
    tags: [],
    archived: false,
    account: null,
    claudeConfigDir: null,
    headroom: false,
    resumable: false,
    model: null,
    effort: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      turns: 0,
    },
    ...over,
  };
}

const DEFAULT_FILTER = { search: '', tags: [], showDone: true, showArchived: false };

beforeEach(() => {
  sent.length = 0;
  useBoardStore.setState({ cards: {}, loaded: true, filter: DEFAULT_FILTER, error: null });
  useJobsStore.setState({ jobs: {}, loaded: true, starting: {}, error: null, lastStarted: null });
  useAccountsStore.setState({
    accounts: [],
    selectedAccount: null,
    claudeConfigs: [],
    selectedClaudeConfig: null,
  });
});

function renderBoard(props: Partial<Parameters<typeof Board>[0]> = {}) {
  return render(
    <MemoryRouter>
      <Board
        onDetails={props.onDetails ?? vi.fn()}
        onNewJob={props.onNewJob ?? vi.fn()}
        onEditJob={props.onEditJob ?? vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('Board renders', () => {
  it('renders every phase column with an empty board', () => {
    renderBoard();
    for (const col of SESSION_PHASE_COLUMNS) {
      expect(screen.getByText(col.label)).toBeTruthy();
    }
  });

  it('puts Investigating between Backlog and Planning', () => {
    // Investigation precedes planning, and the order drives the forward-only
    // inference rule on the bridge — so it is behaviour, not decoration.
    expect(SESSION_PHASE_COLUMNS.map((c) => c.value)).toEqual([
      'backlog',
      'investigating',
      'planning',
      'implementing',
      'verifying',
      'done',
    ]);
  });

  it('renders an investigation card in its own column', () => {
    useBoardStore.setState({
      cards: { s1: session({ phase: 'investigating', name: 'why is startup slow' }) },
    });
    renderBoard();
    const col = document.querySelector('[data-testid="board-column-investigating"]');
    expect(col).toBeTruthy();
    expect(col!.textContent).toContain('why is startup slow');
  });

  it('renders a job card in Backlog', () => {
    useJobsStore.setState({ jobs: { j1: job() } });
    renderBoard();
    expect(screen.getByTestId('job-card')).toBeTruthy();
    expect(screen.getByText('fix auth expiry')).toBeTruthy();
    expect(screen.getByText('api')).toBeTruthy();
  });

  it('renders session cards alongside jobs without clashing', () => {
    useJobsStore.setState({ jobs: { j1: job() } });
    useBoardStore.setState({ cards: { s1: session() } });
    renderBoard();
    expect(screen.getByTestId('job-card')).toBeTruthy();
    expect(screen.getByTestId('board-card')).toBeTruthy();
  });

  it('badges a live card that finished its turn as waiting, not running', () => {
    useBoardStore.setState({
      cards: {
        s1: session({ alive: true, status: 'live', phase: 'implementing', turnRunning: false }),
      },
    });
    renderBoard();
    const badge = screen.getByText('needs input');
    expect(badge.getAttribute('style')).toContain('--color-state-waiting');
  });

  it('badges a card mid-turn as running', () => {
    useBoardStore.setState({
      cards: {
        s1: session({ alive: true, status: 'live', phase: 'implementing', turnRunning: true }),
      },
    });
    renderBoard();
    const badge = screen.getByText('running');
    expect(badge.getAttribute('style')).toContain('--color-state-running');
  });

  it('offers an add-a-job affordance when Backlog is empty', () => {
    renderBoard();
    expect(screen.getByText('+ Add a job')).toBeTruthy();
  });

  it('starts a job from the card', () => {
    useJobsStore.setState({ jobs: { j1: job() } });
    renderBoard();
    fireEvent.click(screen.getByText('Start'));
    expect(sent.some((m) => m.type === 'start_job')).toBe(true);
  });

  it('shows progress while a start is in flight', () => {
    useJobsStore.setState({ jobs: { j1: job() }, starting: { j1: true } });
    renderBoard();
    expect(screen.getByText('Starting…')).toBeTruthy();
  });

  it('counts jobs and sessions together in the Backlog header', () => {
    useJobsStore.setState({ jobs: { j1: job(), j2: job({ id: 'j2' }) } });
    useBoardStore.setState({ cards: { s1: session({ phase: 'backlog' }) } });
    const { container } = renderBoard();
    const header = container.querySelector('[data-testid="board-column-backlog"] header');
    expect(header?.textContent).toContain('3');
  });

  it('applies the shared filter to job cards', () => {
    useJobsStore.setState({ jobs: { j1: job({ title: 'alpha' }), j2: job({ id: 'j2', title: 'beta' }) } });
    useBoardStore.setState({ filter: { ...DEFAULT_FILTER, search: 'alpha' } });
    renderBoard();
    expect(screen.getAllByTestId('job-card')).toHaveLength(1);
    expect(screen.getByText('alpha')).toBeTruthy();
  });
});

describe('JobCard', () => {
  const card = (j: JobSummary, over: Partial<Parameters<typeof JobCard>[0]> = {}): JSX.Element => (
    <JobCard
      job={j}
      starting={false}
      onStart={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onSetPriority={vi.fn()}
      {...over}
    />
  );

  it('requires a second click to delete', () => {
    const onDelete = vi.fn();
    render(card(job(), { onDelete }));
    fireEvent.click(screen.getByLabelText('Delete job'));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Confirm delete job'));
    expect(onDelete).toHaveBeenCalled();
  });

  it('raises a normal job to high from the card', () => {
    const onSetPriority = vi.fn();
    render(card(job(), { onSetPriority }));
    expect(screen.queryByTestId('job-priority')).toBeNull();
    fireEvent.click(screen.getByLabelText('Mark high priority'));
    expect(onSetPriority).toHaveBeenCalledWith(expect.objectContaining({ id: 'j1' }), 'high');
  });

  it('flags a high job and offers to lower it', () => {
    const onSetPriority = vi.fn();
    render(card(job({ priority: 'high' }), { onSetPriority }));
    expect(screen.getByTestId('job-priority').textContent).toMatch(/high/);
    expect(screen.getByTestId('job-card').getAttribute('data-priority')).toBe('high');
    fireEvent.click(screen.getByLabelText('Set normal priority'));
    expect(onSetPriority).toHaveBeenCalledWith(expect.objectContaining({ id: 'j1' }), 'normal');
  });
});

describe('Board — job priority', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('lists high-priority jobs above newer normal ones', () => {
    useJobsStore.setState({
      jobs: {
        newer: job({ id: 'newer', createdAt: 5000 }),
        urgent: job({ id: 'urgent', createdAt: 1000, priority: 'high' }),
      },
    });
    renderBoard();
    const order = screen.getAllByTestId('job-card').map((el) => el.getAttribute('data-job-id'));
    expect(order).toEqual(['urgent', 'newer']);
  });

  it('re-ranks from the card and tells the bridge', () => {
    useJobsStore.setState({
      jobs: {
        newer: job({ id: 'newer', createdAt: 5000 }),
        older: job({ id: 'older', createdAt: 1000 }),
      },
    });
    renderBoard();
    const older = screen.getAllByTestId('job-card')[1]!;
    fireEvent.click(older.querySelector('[aria-label="Mark high priority"]') as HTMLElement);
    expect(sent.find((m) => m.type === 'update_job')).toMatchObject({ jobId: 'older', priority: 'high' });
    // Optimistic: the card has already moved to the top.
    const order = screen.getAllByTestId('job-card').map((el) => el.getAttribute('data-job-id'));
    expect(order).toEqual(['older', 'newer']);
  });
});

describe('JobEditor', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <JobEditor target={null} onClose={vi.fn()} mobile={false} />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders a create form', () => {
    render(<JobEditor target="new" onClose={vi.fn()} mobile={false} />);
    expect(screen.getByText('New job')).toBeTruthy();
    expect(screen.getByLabelText('Job title')).toBeTruthy();
  });

  it('renders an edit form seeded from the job', () => {
    render(<JobEditor target={job()} onClose={vi.fn()} mobile={false} />);
    expect((screen.getByLabelText('Job title') as HTMLInputElement).value).toBe('fix auth expiry');
    expect((screen.getByLabelText('Job notes') as HTMLTextAreaElement).value).toBe('use <= not <');
  });

  it('refuses to save without a title', () => {
    const onClose = vi.fn();
    render(<JobEditor target="new" onClose={onClose} mobile={false} />);
    fireEvent.click(screen.getByText('Add to Backlog'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('A title is required.')).toBeTruthy();
  });

  it('refuses to save without a directory', () => {
    const onClose = vi.fn();
    render(<JobEditor target="new" onClose={onClose} mobile={false} />);
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'a job' } });
    fireEvent.click(screen.getByText('Add to Backlog'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Pick at least one directory.')).toBeTruthy();
  });

  it('creates a job with the form values', () => {
    const onClose = vi.fn();
    render(
      <JobEditor
        target="new"
        onClose={onClose}
        mobile={false}
        defaultProjectPath="/Volumes/Code/thing"
      />,
    );
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'a new job' } });
    fireEvent.click(screen.getByText('Add to Backlog'));
    expect(onClose).toHaveBeenCalled();
    const msg = sent.find((m) => m.type === 'create_job');
    expect(msg).toMatchObject({ title: 'a new job', projectPath: '/Volumes/Code/thing' });
  });

  it('renders on mobile without crashing', () => {
    render(<JobEditor target="new" onClose={vi.fn()} mobile />);
    expect(screen.getByLabelText('Job title')).toBeTruthy();
  });

  it('creates a high-priority job', () => {
    render(
      <JobEditor
        target="new"
        onClose={vi.fn()}
        mobile={false}
        defaultProjectPath="/Volumes/Code/thing"
      />,
    );
    expect(screen.getByLabelText('normal priority').getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'first thing' } });
    fireEvent.click(screen.getByLabelText('high priority'));
    fireEvent.click(screen.getByText('Add to Backlog'));
    expect(sent.find((m) => m.type === 'create_job')).toMatchObject({
      title: 'first thing',
      priority: 'high',
    });
  });

  it('seeds priority from the job being edited', () => {
    render(<JobEditor target={job({ priority: 'high' })} onClose={vi.fn()} mobile={false} />);
    expect(screen.getByLabelText('high priority').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByLabelText('normal priority'));
    fireEvent.click(screen.getByText('Save'));
    expect(sent.find((m) => m.type === 'update_job')).toMatchObject({ jobId: 'j1', priority: 'normal' });
  });
});

describe('Board — clear the Done column', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('offers the button only when Done has cards', () => {
    useBoardStore.setState({ cards: {}, loaded: true, filter: DEFAULT_FILTER });
    renderBoard();
    expect(screen.queryByLabelText('Clear the Done column')).toBeNull();

    cleanup();
    useBoardStore.setState({
      cards: { s1: session({ sessionId: 's1', phase: 'done' }) },
      loaded: true,
      filter: DEFAULT_FILTER,
    });
    renderBoard();
    expect(screen.getByLabelText('Clear the Done column')).toBeTruthy();
  });

  it('takes two presses, and archives nothing on the first', () => {
    useBoardStore.setState({
      cards: {
        s1: session({ sessionId: 's1', phase: 'done' }),
        s2: session({ sessionId: 's2', phase: 'done' }),
      },
      loaded: true,
      filter: DEFAULT_FILTER,
    });
    renderBoard();

    fireEvent.click(screen.getByLabelText('Clear the Done column'));
    // A stray tap on a phone must not clear the column.
    expect(sent.filter((m) => m.type === 'archive_session')).toHaveLength(0);
    // The count is shown so you know what you are about to do.
    expect(screen.getByText('Archive 2?')).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Confirm archiving 2 done sessions/));
    expect(sent.filter((m) => m.type === 'archive_session')).toHaveLength(2);
  });

  it('backs out of the confirmation when the button loses focus', () => {
    useBoardStore.setState({
      cards: { s1: session({ sessionId: 's1', phase: 'done' }) },
      loaded: true,
      filter: DEFAULT_FILTER,
    });
    renderBoard();

    const btn = screen.getByLabelText('Clear the Done column');
    fireEvent.click(btn);
    expect(screen.getByText('Archive 1?')).toBeTruthy();
    fireEvent.blur(btn);
    expect(screen.queryByText('Archive 1?')).toBeNull();
    expect(sent.filter((m) => m.type === 'archive_session')).toHaveLength(0);
  });

  it('does not offer it on any other column', () => {
    useBoardStore.setState({
      cards: { s1: session({ sessionId: 's1', phase: 'implementing' }) },
      loaded: true,
      filter: DEFAULT_FILTER,
    });
    renderBoard();
    expect(screen.queryByLabelText('Clear the Done column')).toBeNull();
  });
});
