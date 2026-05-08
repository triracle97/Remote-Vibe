import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { HistoryPanel } from './HistoryPanel';
import { useHistoryStore } from './historyStore';

vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: vi.fn(() => ({ send: vi.fn() })),
}));

vi.mock('../../store/sessions', () => ({
  useSessionsStore: {
    getState: vi.fn(() => ({ resumeFromHistory: vi.fn() })),
  },
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

import { useSessionsStore } from '../../store/sessions';

describe('HistoryPanel', () => {
  beforeEach(() => {
    // Use a recent lastFetched so the open-effect's cache check skips fetch()
    // (otherwise fetch flips loading: true and the "no past sessions" empty
    // state hides behind "Loading…").
    useHistoryStore.setState({ claude: [], codex: [], loading: false, lastFetched: Date.now() });
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows empty state for both tabs when lists are empty', () => {
    const { container, getByText } = render(<HistoryPanel />);
    fireEvent.click(getByText(/history/i));
    expect(container.textContent).toMatch(/no past sessions/i);
  });

  it('renders Claude rows when claude list is populated', () => {
    useHistoryStore.setState({
      claude: [{
        agent: 'claude', sessionId: 'a', projectPath: '/x/proj', mtime: Date.now() - 3600_000, firstPrompt: 'fix login',
      }],
      codex: [],
      loading: false,
      lastFetched: Date.now(),
    });
    const { container, getByText } = render(<HistoryPanel />);
    fireEvent.click(getByText(/history/i));
    expect(container.textContent).toMatch(/proj/);
    expect(container.textContent).toMatch(/fix login/);
  });

  it('switches to Codex tab and renders codex rows', () => {
    useHistoryStore.setState({
      claude: [],
      codex: [{
        agent: 'codex', sessionId: 'b', projectPath: '/y/repo', mtime: Date.now(), firstPrompt: 'refactor',
      }],
      loading: false,
      lastFetched: Date.now(),
    });
    const { container, getByText } = render(<HistoryPanel />);
    fireEvent.click(getByText(/history/i));
    fireEvent.click(getByText(/codex/i));
    expect(container.textContent).toMatch(/repo/);
    expect(container.textContent).toMatch(/refactor/);
  });

  it('clicking a row calls resumeFromHistory(entry)', () => {
    const resumeFromHistory = vi.fn().mockResolvedValue('new-id');
    (useSessionsStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({ resumeFromHistory });
    const entry = {
      agent: 'claude' as const,
      sessionId: 'a',
      projectPath: '/x/proj',
      mtime: Date.now(),
      firstPrompt: 'hi',
    };
    useHistoryStore.setState({ claude: [entry], codex: [], loading: false, lastFetched: Date.now() });
    const { container, getByText } = render(<HistoryPanel />);
    fireEvent.click(getByText(/history/i));
    const row = container.querySelector('button.history-row') as HTMLButtonElement;
    fireEvent.click(row);
    expect(resumeFromHistory).toHaveBeenCalledWith(entry);
  });

  it('renders 50 rows max', () => {
    const claude = Array.from({ length: 60 }, (_, i) => ({
      agent: 'claude' as const,
      sessionId: `s-${i}`,
      projectPath: '/p',
      mtime: Date.now() - i * 1000,
      firstPrompt: `prompt ${i}`,
    }));
    useHistoryStore.setState({ claude, codex: [], loading: false, lastFetched: Date.now() });
    const { container, getByText } = render(<HistoryPanel />);
    fireEvent.click(getByText(/history/i));
    const rows = container.querySelectorAll('button.history-row');
    expect(rows.length).toBe(50);
  });
});
