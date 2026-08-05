import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { BoardPage } from './Board';
import { useBoardStore } from '../features/board/boardStore';
import { useJobsStore } from '../features/board/jobsStore';
import { useAccountsStore } from '../store/accounts';
import type { ClientMsg } from '../types/protocol';

afterEach(cleanup);

const sent: ClientMsg[] = [];
const fakeClient = { send: (m: ClientMsg) => sent.push(m), on: () => () => {} };

vi.mock('../services/bridge-client-singleton', () => ({
  getBridgeClient: () => fakeClient,
}));

beforeEach(() => {
  sent.length = 0;
  useBoardStore.setState({
    cards: {},
    loaded: true,
    filter: { search: '', tags: [], showDone: true, showArchived: false },
    error: null,
  });
  useJobsStore.setState({ jobs: {}, loaded: true, starting: {}, error: null, lastStarted: null });
  useAccountsStore.setState({
    accounts: [],
    selectedAccount: null,
    claudeConfigs: [],
    selectedClaudeConfig: null,
  });
  if (typeof window !== 'undefined' && !window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  }
});

/** Mount the page the way AppShell does: inside an Outlet carrying `client`. */
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/board']}>
      <Routes>
        <Route element={<Outlet context={{ client: fakeClient }} />}>
          <Route path="/board" element={<BoardPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('BoardPage', () => {
  it('mounts without crashing', () => {
    renderPage();
    expect(screen.getByText('Board')).toBeTruthy();
  });

  it('asks the bridge for both sessions and jobs on mount', () => {
    renderPage();
    expect(sent.some((m) => m.type === 'list_all_sessions')).toBe(true);
    expect(sent.some((m) => m.type === 'list_jobs')).toBe(true);
  });

  it('shows both New job and New session', () => {
    renderPage();
    expect(screen.getByText('New job')).toBeTruthy();
    expect(screen.getByText('New session')).toBeTruthy();
  });

  it('renders the board grid', () => {
    renderPage();
    expect(screen.getByTestId('board')).toBeTruthy();
  });

  it('surfaces a job error in the banner', () => {
    useJobsStore.setState({ error: 'job blew up' });
    renderPage();
    expect(screen.getByRole('alert').textContent).toContain('job blew up');
  });
});
