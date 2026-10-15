import { type JSX } from 'react';
import { useBoardStore } from './boardStore';

/** Search box plus the Working on, Done, and Archived toggles. */
export function FilterBar(): JSX.Element {
  const filter = useBoardStore((s) => s.filter);
  const setFilter = useBoardStore((s) => s.setFilter);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="search"
        value={filter.search}
        onChange={(e) => setFilter({ search: e.target.value })}
        placeholder="Filter sessions…"
        aria-label="Filter sessions"
        className={[
          'flex-1 min-w-[10rem] px-3 py-1.5 rounded-lg text-sm',
          'bg-[var(--color-surface)] border border-[var(--color-border)]',
          'text-[var(--color-text)] placeholder:text-[var(--color-text-dim)]',
          'focus:outline-none focus:border-[var(--color-accent)]',
        ].join(' ')}
      />

      <Toggle
        label="Working on"
        on={filter.onlyHighlighted}
        onChange={(v) => setFilter({ onlyHighlighted: v })}
        tone="warn"
      />
      <Toggle
        label="Done"
        on={filter.showDone}
        onChange={(v) => setFilter({ showDone: v })}
      />
      <Toggle
        label="Archived"
        on={filter.showArchived}
        onChange={(v) => setFilter({ showArchived: v })}
      />
    </div>
  );
}

function Toggle({
  label,
  on,
  onChange,
  tone = 'accent',
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  tone?: 'accent' | 'warn';
}): JSX.Element {
  const active =
    tone === 'warn'
      ? 'border-[var(--color-warn)] text-[var(--color-text)]'
      : 'border-[var(--color-accent)] text-[var(--color-text)]';
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={[
        'text-xs px-2.5 py-1.5 rounded-lg border transition-colors shrink-0',
        on
          ? active
          : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text-mute)]',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
