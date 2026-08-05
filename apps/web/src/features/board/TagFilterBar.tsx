import { useMemo, type JSX } from 'react';
import { allTags, useBoardStore } from './boardStore';

/** Search box plus tag chips. Selected tags AND together. */
export function TagFilterBar(): JSX.Element {
  const cards = useBoardStore((s) => s.cards);
  const filter = useBoardStore((s) => s.filter);
  const setFilter = useBoardStore((s) => s.setFilter);
  const toggleTag = useBoardStore((s) => s.toggleTag);

  const tags = useMemo(() => allTags(cards), [cards]);

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
        label="Done"
        on={filter.showDone}
        onChange={(v) => setFilter({ showDone: v })}
      />
      <Toggle
        label="Archived"
        on={filter.showArchived}
        onChange={(v) => setFilter({ showArchived: v })}
      />

      {tags.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap w-full md:w-auto">
          {tags.map((t) => {
            const on = filter.tags.includes(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() => toggleTag(t)}
                className={[
                  'text-[11px] px-2 py-0.5 rounded-full border transition-colors',
                  on
                    ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] text-[var(--color-text)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-mute)] hover:text-[var(--color-text)]',
                ].join(' ')}
              >
                {t}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={[
        'text-xs px-2.5 py-1.5 rounded-lg border transition-colors shrink-0',
        on
          ? 'border-[var(--color-accent)] text-[var(--color-text)]'
          : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text-mute)]',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
