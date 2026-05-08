import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Session } from './Session';
import { useSessionsStore } from '../store/sessions';
import type { SessionView } from '../store/sessions';
import type { BridgeClient } from '../services/bridge-client';

vi.mock('../features/project-picker/useNewSession', () => ({
  useNewSession: () => ({ open: vi.fn(), pickerNode: null }),
}));

vi.mock('../features/file-explorer/FileExplorer', () => ({
  FileExplorer: () => <aside data-testid="file-explorer" />,
}));

vi.mock('../features/chat/Chat', () => ({
  Chat: ({ onOpenMobileNav }: { onOpenMobileNav?: () => void }) => (
    <main data-testid="chat">
      {onOpenMobileNav && (
        <button type="button" aria-label="Open sessions and history" onClick={onOpenMobileNav}>
          menu
        </button>
      )}
    </main>
  ),
}));

vi.mock('../features/session-list/SessionList', () => ({
  SessionList: ({
    sessions,
    onSelect,
    onAfterSelect,
  }: {
    sessions: SessionView[];
    onSelect(id: string): void;
    onAfterSelect?: () => void;
  }) => (
    <nav data-testid="session-list">
      {sessions.map((session) => (
        <button
          key={session.sessionId}
          type="button"
          onClick={() => {
            onSelect(session.sessionId);
            onAfterSelect?.();
          }}
        >
          {session.name ?? session.sessionId}
        </button>
      ))}
    </nav>
  ),
}));

vi.mock('../features/history/HistoryPanel', () => ({
  HistoryPanel: ({
    defaultOpen,
    onAfterResume,
  }: {
    defaultOpen?: boolean;
    onAfterResume?: () => void;
  }) => (
    <section data-testid="history-panel">
      <span>{defaultOpen ? 'open history' : 'collapsed history'}</span>
      {onAfterResume && (
        <button type="button" onClick={onAfterResume}>
          resume row
        </button>
      )}
    </section>
  ),
}));

const client = {
  send: vi.fn(),
} as unknown as BridgeClient;

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: 's1',
    agent: 'claude',
    projectPath: '/Users/me/project',
    createdAt: 1,
    events: [],
    lastSeq: 0,
    alive: true,
    name: 'Session One',
    ...overrides,
  };
}

function renderSession(path = '/session/s1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/session/:id" element={<Session client={client} />} />
        <Route path="/" element={<div>home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Session mobile shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionsStore.setState({
      sessions: {
        s1: makeSession(),
        s2: makeSession({ sessionId: 's2', name: 'Session Two' }),
      },
      order: ['s1', 's2'],
      activeId: null,
      transcriptOnly: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the mobile drawer from the chat trigger', () => {
    const { container, getByLabelText, getByRole } = renderSession();
    fireEvent.click(getByLabelText(/open sessions and history/i));
    const drawer = getByRole('dialog', { name: /mobile navigation/i });
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(
      within(drawer).getByRole('button', { name: /close mobile navigation/i }),
    );
    expect(container.querySelector('.mobile-nav-backdrop')?.getAttribute('tabindex')).toBe('-1');
  });

  it('switches between sessions and history tabs', () => {
    const { getByLabelText, getByRole } = renderSession();
    fireEvent.click(getByLabelText(/open sessions and history/i));
    const drawer = getByRole('dialog', { name: /mobile navigation/i });
    expect(within(drawer).getByTestId('session-list')).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: /history/i }));
    expect(within(drawer).getByTestId('history-panel').textContent).toMatch(/open history/);
  });

  it('closes the drawer after selecting a session', () => {
    const { getByLabelText, getByRole, queryByRole } = renderSession();
    fireEvent.click(getByLabelText(/open sessions and history/i));
    const drawer = getByRole('dialog', { name: /mobile navigation/i });
    fireEvent.click(within(drawer).getByRole('button', { name: /session two/i }));
    expect(queryByRole('dialog', { name: /mobile navigation/i })).toBeNull();
  });

  it('closes the drawer after history resume callback', () => {
    const { getByLabelText, getByRole, queryByRole } = renderSession();
    fireEvent.click(getByLabelText(/open sessions and history/i));
    const drawer = getByRole('dialog', { name: /mobile navigation/i });
    fireEvent.click(within(drawer).getByRole('button', { name: /history/i }));
    fireEvent.click(within(drawer).getByRole('button', { name: /resume row/i }));
    expect(queryByRole('dialog', { name: /mobile navigation/i })).toBeNull();
  });

  it('closes with Escape and restores focus to the chat trigger', () => {
    const { getByLabelText, getByRole, queryByRole } = renderSession();
    const trigger = getByLabelText(/open sessions and history/i);
    trigger.focus();
    fireEvent.click(trigger);
    const drawer = getByRole('dialog', { name: /mobile navigation/i });
    fireEvent.keyDown(drawer, { key: 'Escape' });
    expect(queryByRole('dialog', { name: /mobile navigation/i })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps tab focus inside the open drawer', () => {
    const { getByLabelText, getByRole } = renderSession();
    fireEvent.click(getByLabelText(/open sessions and history/i));
    const drawer = getByRole('dialog', { name: /mobile navigation/i });
    const closeButton = within(drawer).getByRole('button', { name: /close mobile navigation/i });
    const lastSessionButton = within(drawer).getByRole('button', { name: /session two/i });

    closeButton.focus();
    fireEvent.keyDown(drawer, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastSessionButton);

    fireEvent.keyDown(drawer, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);
  });
});
