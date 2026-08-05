import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Code, Terminal as TerminalIcon, CornerDownLeft } from 'lucide-react';
import { Modal } from './Modal';
import { NAV_TABS } from './NavRail';
import { useSessionsStore } from '../store/sessions';
import { useTerminalsStore } from '../store/terminals';
import { SHORTCUTS, renderKeys } from './shortcuts';

/**
 * Fuzzy switcher over everything you might want to jump to.
 *
 * Running sessions come first and unfiltered, because "get me back to the other
 * agent" is the reason this exists; routes and actions ride along so there is
 * one thing to reach for rather than a growing set of chords to memorise.
 */

export interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  group: 'Sessions' | 'Terminals' | 'Go to' | 'Actions';
  run(): void;
}

/**
 * Subsequence match, the same rule editors use: every character of the query
 * must appear in order, not necessarily adjacent. Returns a score where lower
 * is better, or null for no match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let lastHit = -1;
  for (const ch of q) {
    const hit = t.indexOf(ch, ti);
    if (hit === -1) return null;
    // Gaps cost, so contiguous runs sort above scattered letters.
    if (lastHit >= 0) score += hit - lastHit - 1;
    lastHit = hit;
    ti = hit + 1;
  }
  // Prefer earlier first-matches and shorter haystacks between equal spreads.
  return score * 100 + t.indexOf(q[0]!) + text.length / 1000;
}

export function rankItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  if (query.trim().length === 0) return items.slice();
  const scored: Array<{ item: PaletteItem; score: number }> = [];
  for (const item of items) {
    const score = fuzzyScore(query.trim(), `${item.label} ${item.hint}`);
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.map((s) => s.item);
}

interface CommandPaletteProps {
  open: boolean;
  onClose(): void;
  onNewSession(): void;
}

export function CommandPalette({ open, onClose, onNewSession }: CommandPaletteProps): JSX.Element {
  const navigate = useNavigate();
  const order = useSessionsStore((s) => s.order);
  const sessions = useSessionsStore((s) => s.sessions);
  const terminals = useTerminalsStore((s) => s.terminals);
  const terminalOrder = useTerminalsStore((s) => s.order);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    for (const id of order) {
      const s = sessions[id];
      if (!s || !s.alive) continue;
      out.push({
        id: `session:${id}`,
        label: s.name && s.name.length > 0 ? s.name : s.projectPath.split('/').filter(Boolean).pop() || id,
        hint: `${s.agent} · ${s.projectPath}`,
        group: 'Sessions',
        run: () => navigate(`/session/${id}`),
      });
    }
    for (const id of terminalOrder) {
      const t = terminals[id];
      if (!t || !t.alive) continue;
      out.push({
        id: `terminal:${id}`,
        label: t.cwd.split('/').filter(Boolean).pop() || id,
        hint: `terminal · ${t.cwd}`,
        group: 'Terminals',
        run: () => navigate(`/terminal/${id}`),
      });
    }
    for (const tab of NAV_TABS) {
      out.push({
        id: `route:${tab.to}`,
        label: tab.label,
        hint: tab.to,
        group: 'Go to',
        run: () => navigate(tab.to),
      });
    }
    out.push({
      id: 'action:new-session',
      label: 'New session',
      hint: renderKeys('Mod+Shift+N'),
      group: 'Actions',
      run: onNewSession,
    });
    return out;
  }, [order, sessions, terminals, terminalOrder, navigate, onNewSession]);

  const ranked = useMemo(() => rankItems(items, query), [items, query]);

  // Reopening should always start clean; a stale query from last time reads as
  // a broken list.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // Modal focuses its own container, so grab focus after that lands.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the highlighted row on screen while arrowing through a long list.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (item: PaletteItem | undefined): void => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Command palette" maxWidthClass="max-w-lg">
      <div className="flex flex-col min-h-0" data-testid="command-palette">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, ranked.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(ranked[active]);
            }
            // Escape is handled by Modal's own key handler.
          }}
          placeholder="Jump to a session, page, or action…"
          aria-label="Search sessions and actions"
          className="w-full px-3 py-3 bg-transparent border-b border-[var(--color-border)] text-[var(--color-text)] outline-none"
        />

        {ranked.length === 0 ? (
          <p className="p-4 text-sm text-[var(--color-text-dim)] m-0">No matches.</p>
        ) : (
          <ul
            ref={listRef}
            className="list-none p-1 m-0 overflow-y-auto max-h-[60vh]"
            role="listbox"
            aria-label="Results"
          >
            {ranked.map((item, i) => {
              const prev = ranked[i - 1];
              const showGroup = i === 0 || prev?.group !== item.group;
              return (
                <li key={item.id}>
                  {showGroup && (
                    <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-dim)]">
                      {item.group}
                    </div>
                  )}
                  <button
                    type="button"
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(item)}
                    className={`w-full text-left px-3 py-2 min-h-[44px] rounded-lg flex items-center gap-2 ${
                      i === active ? 'bg-[var(--color-surface-2)]' : ''
                    }`}
                  >
                    {item.group === 'Sessions' && (
                      <Code size={14} aria-hidden="true" className="shrink-0 text-[var(--color-text-dim)]" />
                    )}
                    {item.group === 'Terminals' && (
                      <TerminalIcon size={14} aria-hidden="true" className="shrink-0 text-[var(--color-text-dim)]" />
                    )}
                    <span className="flex flex-col min-w-0 flex-1">
                      <span className="text-sm text-[var(--color-text)] truncate">{item.label}</span>
                      <span className="text-[11px] font-mono text-[var(--color-text-dim)] truncate">
                        {item.hint}
                      </span>
                    </span>
                    {i === active && (
                      <CornerDownLeft size={13} aria-hidden="true" className="shrink-0 text-[var(--color-text-dim)]" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* The palette is the one thing people find by accident, so it is where
            the rest of the bindings get advertised. */}
        <div className="px-3 py-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-dim)] flex items-center gap-3">
          <span>
            <kbd className="font-mono">↑↓</kbd> move
          </span>
          <span>
            <kbd className="font-mono">↵</kbd> open
          </span>
          <span>
            <kbd className="font-mono">esc</kbd> close
          </span>
          <span className="ml-auto">
            <kbd className="font-mono">?</kbd> all shortcuts
          </span>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The shortcut table itself.
 *
 * Shared by the `?` modal and the Settings page so the two can never disagree,
 * and both are generated from `SHORTCUTS` rather than hand-listed — a binding
 * added to the matcher without a row here would be undiscoverable.
 */
export function ShortcutList(): JSX.Element {
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 m-0">
        {SHORTCUTS.map((s) => (
          <div key={s.id} className="contents">
            <dt className="text-right">
              <kbd className="px-1.5 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[11px] font-mono text-[var(--color-text)] whitespace-nowrap">
                {renderKeys(s.keys)}
              </kbd>
            </dt>
            <dd className="m-0 text-sm text-[var(--color-text-mute)]">{s.description}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 mb-0 text-[11px] text-[var(--color-text-dim)] leading-snug">
        Session switching uses Ctrl rather than ⌘ because the browser owns
        ⌘-digit for its tab bar and will not give it up. On Windows and Linux
        Ctrl-digit switches browser tabs instead — use ⌘K there.
      </p>
      <p className="mt-2 mb-0 text-[11px] text-[var(--color-text-dim)] leading-snug">
        On a phone, Enter still inserts a new line and the send button sends:
        software keyboards cannot produce Shift+Enter, so binding Enter to send
        would leave no way to write a second line. ⌘/Ctrl+Enter sends anywhere.
      </p>
    </>
  );
}

/** The shortcut reference, opened with `?`. */
export function ShortcutHelp({ open, onClose }: { open: boolean; onClose(): void }): JSX.Element {
  return (
    <Modal open={open} onClose={onClose} ariaLabel="Keyboard shortcuts">
      <div className="p-4" data-testid="shortcut-help">
        <h2 className="m-0 mb-3 text-sm font-bold uppercase tracking-wider text-[var(--color-text-dim)]">
          Keyboard shortcuts
        </h2>
        <ShortcutList />
      </div>
    </Modal>
  );
}
