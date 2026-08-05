import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  CommandPalette,
  ShortcutList,
  fuzzyScore,
  rankItems,
  type PaletteItem,
} from './CommandPalette';
import { useSessionsStore } from '../store/sessions';
import { useTerminalsStore } from '../store/terminals';
import { SHORTCUTS } from './shortcuts';

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

afterEach(cleanup);

function item(over: Partial<PaletteItem>): PaletteItem {
  return {
    id: 'x',
    label: 'label',
    hint: 'hint',
    group: 'Sessions',
    run: () => {},
    ...over,
  };
}

describe('fuzzyScore', () => {
  it('matches a subsequence, not just a substring', () => {
    expect(fuzzyScore('prs', 'parser tests')).not.toBeNull();
    expect(fuzzyScore('xyz', 'parser tests')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('PARSER', 'parser tests')).not.toBeNull();
  });

  it('scores a contiguous run better than a scattered one', () => {
    const tight = fuzzyScore('par', 'parser')!;
    const loose = fuzzyScore('par', 'p a r')!;
    expect(tight).toBeLessThan(loose);
  });

  it('treats an empty query as a match', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
  });
});

describe('rankItems', () => {
  it('returns everything, in order, for an empty query', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' })];
    expect(rankItems(items, '  ').map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('drops non-matches and sorts the rest by score', () => {
    const items = [
      item({ id: 'far', label: 'p x y z a x r' }),
      item({ id: 'near', label: 'parser' }),
      item({ id: 'none', label: 'unrelated' }),
    ];
    const out = rankItems(items, 'par').map((i) => i.id);
    expect(out).toEqual(['near', 'far']);
  });

  it('searches the hint as well as the label', () => {
    const items = [item({ id: 'a', label: 'Session', hint: 'codex · /Users/me/widgets' })];
    expect(rankItems(items, 'widgets')).toHaveLength(1);
  });
});

describe('CommandPalette', () => {
  beforeEach(() => {
    navigate.mockClear();
    useSessionsStore.setState({
      order: ['s1', 's2', 'dead'],
      sessions: {
        s1: {
          sessionId: 's1',
          agent: 'claude',
          projectPath: '/Users/me/alpha',
          createdAt: 1,
          events: [],
          lastSeq: 0,
          alive: true,
          name: 'Fix the parser',
        },
        s2: {
          sessionId: 's2',
          agent: 'codex',
          projectPath: '/Users/me/beta',
          createdAt: 2,
          events: [],
          lastSeq: 0,
          alive: true,
          name: 'Port the tests',
        },
        dead: {
          sessionId: 'dead',
          agent: 'claude',
          projectPath: '/Users/me/gamma',
          createdAt: 3,
          events: [],
          lastSeq: 0,
          alive: false,
          name: 'Old work',
        },
      },
      activeId: null,
      transcriptOnly: {},
      pendingNames: {},
    });
    useTerminalsStore.setState({ terminals: {}, order: [] });
  });

  function renderPalette(onNewSession = vi.fn()) {
    render(
      <MemoryRouter>
        <CommandPalette open onClose={() => {}} onNewSession={onNewSession} />
      </MemoryRouter>,
    );
  }

  it('lists running sessions and leaves out dead ones', () => {
    renderPalette();
    expect(screen.getByText('Fix the parser')).toBeTruthy();
    expect(screen.getByText('Port the tests')).toBeTruthy();
    // Switching is about live work; an ended session is the board's job.
    expect(screen.queryByText('Old work')).toBeNull();
  });

  it('filters as you type and navigates on Enter', () => {
    renderPalette();
    const input = screen.getByLabelText('Search sessions and actions');
    fireEvent.change(input, { target: { value: 'port' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/session/s2');
  });

  it('moves the selection with the arrow keys', () => {
    renderPalette();
    const input = screen.getByLabelText('Search sessions and actions');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/session/s2');
  });

  it('does not run past the end of the list', () => {
    renderPalette();
    const input = screen.getByLabelText('Search sessions and actions');
    fireEvent.change(input, { target: { value: 'parser' } });
    // One result; arrowing down repeatedly must stay on it.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/session/s1');
  });

  it('offers routes and the new-session action too', () => {
    const onNewSession = vi.fn();
    renderPalette(onNewSession);
    const input = screen.getByLabelText('Search sessions and actions');
    fireEvent.change(input, { target: { value: 'new session' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNewSession).toHaveBeenCalled();
  });

  it('says so when nothing matches', () => {
    renderPalette();
    fireEvent.change(screen.getByLabelText('Search sessions and actions'), {
      target: { value: 'zzzzzz' },
    });
    expect(screen.getByText(/no matches/i)).toBeTruthy();
  });
});

describe('ShortcutList', () => {
  it('renders a row for every documented shortcut', () => {
    render(<ShortcutList />);
    // Generated from SHORTCUTS, so a binding added to the matcher without a
    // row here would be undiscoverable in the UI.
    for (const s of SHORTCUTS) {
      expect(screen.getByText(s.description)).toBeTruthy();
    }
  });

  it('explains why session switching is not on Cmd', () => {
    render(<ShortcutList />);
    expect(screen.getByText(/browser owns/i)).toBeTruthy();
  });
});
