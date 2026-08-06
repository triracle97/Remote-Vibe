import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, Outlet } from 'react-router-dom';
import { Session } from './Session';
import { useSessionsStore } from '../store/sessions';
import { useConnectionStore } from '../store/connection';
import type { SessionView } from '../store/sessions';
import type { BridgeClient } from '../services/bridge-client';
import type { TranscriptEvent } from '../services/transcript-fetcher';

vi.mock('../features/project-picker/useNewSession', () => ({
  useNewSession: () => ({ open: vi.fn(), pickerNode: null }),
}));

vi.mock('../features/file-explorer/FileExplorer', () => ({
  FileExplorer: () => <aside data-testid="file-explorer" />,
}));

vi.mock('../features/session-list/SessionList', () => ({
  SessionList: () => <nav data-testid="session-list" />,
}));

vi.mock('../features/history/HistoryPanel', () => ({
  HistoryPanel: () => <section data-testid="history-panel" />,
}));

vi.mock('../features/chat/Chat', () => ({
  Chat: ({ session }: { session: SessionView }) => (
    <main data-testid="chat">
      <span data-testid="event-count">{session.events.length}</span>
    </main>
  ),
}));

const streamTranscript = vi.fn();
vi.mock('../services/transcript-fetcher', () => ({
  streamTranscript: (id: string) => streamTranscript(id),
}));

const client = { send: vi.fn() } as unknown as BridgeClient;

const TRANSCRIPT: TranscriptEvent[] = [
  {
    type: 'system',
    event: 'session_created',
    sessionId: 's1',
    seq: 1,
    agent: 'claude',
    projectPath: '/Users/me/project',
    createdAt: 1,
  },
  { type: 'user', sessionId: 's1', seq: 2, payload: { text: 'hi' } },
  { type: 'assistant', sessionId: 's1', seq: 3, payload: { text: 'hello' } },
  { type: 'result', sessionId: 's1', seq: 4, payload: {} },
  { type: 'system', event: 'session_ended', sessionId: 's1', seq: 5, exitCode: 0 },
];

function replay(events: TranscriptEvent[]): AsyncGenerator<TranscriptEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

function ContextWrapper(): JSX.Element {
  return <Outlet context={{ client }} />;
}

function renderSession() {
  return render(
    <MemoryRouter initialEntries={['/session/s1']}>
      <Routes>
        <Route element={<ContextWrapper />}>
          <Route path="/session/:id" element={<Session />} />
          <Route path="/" element={<div>home</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('Session transcript-only fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionsStore.setState({
      sessions: {},
      order: [],
      activeId: null,
      transcriptOnly: { s1: true },
      pendingNames: {},
    });
    useConnectionStore.setState({ status: 'open' });
  });

  afterEach(() => {
    cleanup();
  });

  it('replays the transcript into the store on first open', async () => {
    streamTranscript.mockImplementation(() => replay(TRANSCRIPT));
    renderSession();
    await waitFor(() => {
      expect(screen.getByTestId('event-count').textContent).toBe('5');
    });
    expect(streamTranscript).toHaveBeenCalledTimes(1);
  });

  it('does not re-stream or duplicate events when the session is re-entered', async () => {
    streamTranscript.mockImplementation(() => replay(TRANSCRIPT));
    const first = renderSession();
    await waitFor(() => {
      expect(screen.getByTestId('event-count').textContent).toBe('5');
    });
    first.unmount();

    // Re-entering from the board mounts the page again. The transcript of a
    // dead session is frozen, so a second replay can only duplicate it.
    renderSession();
    await waitFor(() => {
      expect(screen.getByTestId('event-count')).toBeTruthy();
    });
    expect(screen.getByTestId('event-count').textContent).toBe('5');
    expect(streamTranscript).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed transcript fetch instead of spinning forever', async () => {
    streamTranscript.mockImplementation(() => {
      throw new Error('GET /transcripts/s1 failed with 404');
    });
    renderSession();
    await waitFor(() => {
      expect(screen.getByText(/no transcript/i)).toBeTruthy();
    });
    expect(screen.queryByText(/loading transcript/i)).toBeNull();
  });
});
