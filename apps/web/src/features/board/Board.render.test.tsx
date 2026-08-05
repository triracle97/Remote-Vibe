import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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
  it('requires a second click to delete', () => {
    const onDelete = vi.fn();
    render(
      <JobCard job={job()} starting={false} onStart={vi.fn()} onEdit={vi.fn()} onDelete={onDelete} />,
    );
    fireEvent.click(screen.getByLabelText('Delete job'));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Confirm delete job'));
    expect(onDelete).toHaveBeenCalled();
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
