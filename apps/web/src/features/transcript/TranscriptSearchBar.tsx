import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { ViewMessage } from './projection';
import { outputToText, summarizeToolInput } from './utils';

/**
 * Find-in-transcript.
 *
 * Nimbalyst's `TranscriptSearchBar.tsx` uses the CSS Custom Highlight API so
 * highlighting survives virtualization without mutating the DOM. This view
 * isn't virtualized, so the simpler and better-supported approach is to search
 * the projected messages and scroll to the matching element by id — no DOM
 * mutation either way, and no reliance on a Safari-only-recently API.
 */

/** Everything in a message that a user might search for. */
export function searchableText(m: ViewMessage): string {
  switch (m.kind) {
    case 'text':
      return m.text;
    case 'thinking':
      return m.text;
    case 'tool_call':
      return [
        m.toolName,
        summarizeToolInput(m.toolName, m.input),
        outputToText(m.output),
      ].join('\n');
    case 'notice':
      return m.text;
    case 'turn_end':
      return m.error ?? '';
    default:
      return '';
  }
}

export function findMatches(messages: readonly ViewMessage[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  return messages.filter((m) => searchableText(m).toLowerCase().includes(q)).map((m) => m.id);
}

interface Props {
  messages: readonly ViewMessage[];
  onClose: () => void;
  onJump: (messageId: string) => void;
  onQueryChange: (q: string) => void;
}

export function TranscriptSearchBar({
  messages,
  onClose,
  onJump,
  onQueryChange,
}: Props): JSX.Element {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const matches = useMemo(() => findMatches(messages, query), [messages, query]);

  useEffect(() => {
    onQueryChange(query);
  }, [query, onQueryChange]);

  // A shorter query can leave the cursor past the end of the new match list.
  useEffect(() => {
    if (cursor >= matches.length) setCursor(0);
  }, [matches.length, cursor]);

  const go = useCallback(
    (delta: number) => {
      if (matches.length === 0) return;
      const next = (cursor + delta + matches.length) % matches.length;
      setCursor(next);
      const id = matches[next];
      if (id !== undefined) onJump(id);
    },
    [cursor, matches, onJump],
  );

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <input
        autoFocus
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Find in transcript…"
        aria-label="Find in transcript"
        className="flex-1 min-w-0 px-2 py-1 rounded text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:outline-none focus:border-[var(--color-accent)]"
      />
      <span className="text-[11px] tabular-nums text-[var(--color-text-dim)] shrink-0 min-w-[3.5rem] text-right">
        {query.trim().length === 0 ? '' : matches.length === 0 ? 'no results' : `${cursor + 1}/${matches.length}`}
      </span>
      <IconButton label="Previous match" onClick={() => go(-1)} disabled={matches.length === 0}>
        <ChevronUp size={14} />
      </IconButton>
      <IconButton label="Next match" onClick={() => go(1)} disabled={matches.length === 0}>
        <ChevronDown size={14} />
      </IconButton>
      <IconButton label="Close search" onClick={onClose}>
        <X size={14} />
      </IconButton>
    </div>
  );
}

function IconButton({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 p-1 rounded text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
