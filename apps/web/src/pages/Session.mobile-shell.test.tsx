import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, Outlet } from 'react-router-dom';
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
  Chat: ({ onOpenMobileNav }: { onOpenMobileNav?: (opener?: HTMLElement) => void }) => (
    <main data-testid="chat">
      {onOpenMobileNav && (
        <button
          type="button"
          aria-label="Open sessions and history"
          onClick={(event) => onOpenMobileNav(event.currentTarget)}
        >
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

function ContextWrapper(): JSX.Element {
  return <Outlet context={{ client }} />;
}

function renderSession(path = '/session/s1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ContextWrapper />}>
          <Route path="/session/:id" element={<Session />} />
          <Route path="/" element={<div>home</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('Session mobile shell (BottomSheet)', () => {
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

  it('opens the sessions sheet when Menu pressed', async () => {
    renderSession();
    fireEvent.click(screen.getByRole('button', { name: /open sessions and history/i }));
    await waitFor(() => {
      const dialogs = screen.getAllByRole('dialog');
      expect(
        dialogs.find((d) => d.getAttribute('aria-label') === 'Sessions and history'),
      ).toBeDefined();
    });
  });

  it('switches between sessions and history tabs', async () => {
    renderSession();
    fireEvent.click(screen.getByRole('button', { name: /open sessions and history/i }));
    await waitFor(() => {
      expect(
        screen.getAllByRole('dialog').find((d) => d.getAttribute('aria-label') === 'Sessions and history'),
      ).toBeDefined();
    });
    const sheet = screen
      .getAllByRole('dialog')
      .find((d) => d.getAttribute('aria-label') === 'Sessions and history')!;
    expect(within(sheet).getByTestId('session-list')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: /history/i }));
    expect(within(sheet).getByTestId('history-panel').textContent).toMatch(/open history/);
  });

  it('closes the sheet after selecting a session', async () => {
    renderSession();
    fireEvent.click(screen.getByRole('button', { name: /open sessions and history/i }));
    await waitFor(() => {
      expect(
        screen.getAllByRole('dialog').find((d) => d.getAttribute('aria-label') === 'Sessions and history'),
      ).toBeDefined();
    });
    const sheet = screen
      .getAllByRole('dialog')
      .find((d) => d.getAttribute('aria-label') === 'Sessions and history')!;
    fireEvent.click(within(sheet).getByRole('button', { name: /session two/i }));
    await waitFor(() => {
      expect(
        screen
          .queryAllByRole('dialog')
          .find((d) => d.getAttribute('aria-label') === 'Sessions and history'),
      ).toBeUndefined();
    });
  });

  it('closes the sheet after history resume callback', async () => {
    renderSession();
    fireEvent.click(screen.getByRole('button', { name: /open sessions and history/i }));
    await waitFor(() => {
      expect(
        screen.getAllByRole('dialog').find((d) => d.getAttribute('aria-label') === 'Sessions and history'),
      ).toBeDefined();
    });
    const sheet = screen
      .getAllByRole('dialog')
      .find((d) => d.getAttribute('aria-label') === 'Sessions and history')!;
    fireEvent.click(within(sheet).getByRole('button', { name: /history/i }));
    fireEvent.click(within(sheet).getByRole('button', { name: /resume row/i }));
    await waitFor(() => {
      expect(
        screen
          .queryAllByRole('dialog')
          .find((d) => d.getAttribute('aria-label') === 'Sessions and history'),
      ).toBeUndefined();
    });
  });

  it('closes with Escape and restores focus to the chat trigger', async () => {
    renderSession();
    const trigger = screen.getByRole('button', { name: /open sessions and history/i });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(
        screen.getAllByRole('dialog').find((d) => d.getAttribute('aria-label') === 'Sessions and history'),
      ).toBeDefined();
    });
    const sheet = screen
      .getAllByRole('dialog')
      .find((d) => d.getAttribute('aria-label') === 'Sessions and history')!;
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => {
      expect(
        screen
          .queryAllByRole('dialog')
          .find((d) => d.getAttribute('aria-label') === 'Sessions and history'),
      ).toBeUndefined();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps tab focus inside the open sheet', async () => {
    renderSession();
    fireEvent.click(screen.getByRole('button', { name: /open sessions and history/i }));
    await waitFor(() => {
      expect(
        screen.getAllByRole('dialog').find((d) => d.getAttribute('aria-label') === 'Sessions and history'),
      ).toBeDefined();
    });
    const sheet = screen
      .getAllByRole('dialog')
      .find((d) => d.getAttribute('aria-label') === 'Sessions and history')!;

    // Get focusable buttons inside the sheet (tabs + session rows)
    const focusableButtons = within(sheet).getAllByRole('button');
    const firstButton = focusableButtons[0]!;
    const lastButton = focusableButtons[focusableButtons.length - 1]!;

    // Focus first button, then Shift+Tab should wrap to last
    firstButton.focus();
    fireEvent.keyDown(sheet, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastButton);

    // Focus last button, Tab should wrap to first
    lastButton.focus();
    fireEvent.keyDown(sheet, { key: 'Tab' });
    expect(document.activeElement).toBe(firstButton);
  });
});
