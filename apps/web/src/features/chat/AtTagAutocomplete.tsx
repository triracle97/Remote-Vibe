import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { FileText, Folder } from 'lucide-react';
import { useFileSearchStore } from './fileSearchStore';

interface AtTagAutocompleteProps {
  sessionId: string;
  text: string;
  cursor: number;
  onPick: (newText: string, newCursor: number) => void;
}

export interface AtTagAutocompleteHandle {
  isOpen(): boolean;
  handleKey(e: { key: string; preventDefault?: () => void }): boolean;
}

/** Detect `@<query>` preceded by start-of-string or whitespace. Exported for tests. */
export function findAtTrigger(text: string, cursor: number): { start: number; query: string } | null {
  const beforeCursor = text.slice(0, cursor);
  const m = /(^|\s)@([\w./-]*)$/.exec(beforeCursor);
  if (!m) return null;
  const query = m[2] ?? '';
  const atStart = (m.index ?? 0) + (m[1]?.length ?? 0);
  return { start: atStart, query };
}

export const AtTagAutocomplete = forwardRef<AtTagAutocompleteHandle, AtTagAutocompleteProps>(
  function AtTagAutocomplete(
    { sessionId, text, cursor, onPick }: AtTagAutocompleteProps,
    ref,
  ): JSX.Element | null {
    const trigger = findAtTrigger(text, cursor);
    const atStart = trigger?.start ?? -1;
    const query = trigger?.query ?? '';

    const search = useFileSearchStore((s) => s.search);
    const result = useFileSearchStore((s) => s.bySession[sessionId]);

    useEffect(() => {
      if (atStart >= 0) {
        const t = setTimeout(() => search(sessionId, query), 150);
        return () => clearTimeout(t);
      }
      return undefined;
    }, [atStart, sessionId, query, search]);

    const hits = result?.hits ?? [];
    const truncated = result?.truncated ?? false;
    const visible = hits.slice(0, 10);

    const [active, setActive] = useState(0);
    useEffect(() => {
      setActive(0);
    }, [hits.length, query]);

    const open = atStart >= 0 && visible.length > 0;

    const insert = (insertText: string): void => {
      const before = text.slice(0, atStart);
      const after = text.slice(cursor);
      const newText = before + insertText + ' ' + after;
      const newCursor = before.length + insertText.length + 1;
      onPick(newText, newCursor);
    };

    const filenameFor = (fullPath: string): string => {
      const parts = fullPath.split('/').filter(Boolean);
      return parts[parts.length - 1] ?? fullPath;
    };

    useImperativeHandle(
      ref,
      (): AtTagAutocompleteHandle => ({
        isOpen: () => open,
        handleKey: (e) => {
          if (!open) return false;
          if (e.key === 'ArrowDown') {
            e.preventDefault?.();
            setActive((a) => (a + 1) % visible.length);
            return true;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault?.();
            setActive((a) => (a - 1 + visible.length) % visible.length);
            return true;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            const pick = visible[active];
            if (!pick) return false;
            e.preventDefault?.();
            insert(pick.insertText);
            return true;
          }
          return false;
        },
      }),
      [open, active, visible, insert],
    );

    if (!open) return null;

    return (
      <div className="autocomplete-popup at-tag-autocomplete absolute bottom-full left-0 right-0 mb-2 max-h-[32vh] overflow-y-auto z-30 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-2xl" role="listbox" aria-label="File suggestions">
        {visible.map((h, i) => (
          <button
            key={h.fullPath}
            type="button"
            role="option"
            aria-selected={i === active}
            className={[
              'autocomplete-row flex gap-2 items-center w-full min-h-[44px] max-md:min-h-[56px] px-3 py-2 bg-transparent text-[var(--color-text)] border-0 border-b border-[var(--color-border)] last:border-b-0 text-left text-sm cursor-pointer hover:bg-[var(--color-surface-2)]',
              i === active ? 'active bg-[var(--color-surface-2)]' : '',
            ].join(' ')}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              insert(h.insertText);
            }}
            title={h.fullPath}
          >
            {h.isDir ? (
              <Folder size={14} aria-hidden="true" className="shrink-0 text-[var(--color-warn)]" />
            ) : (
              <FileText size={14} aria-hidden="true" className="shrink-0 text-[var(--color-text-dim)]" />
            )}
            <span className="autocomplete-row-primary flex flex-col gap-0.5 min-w-0 flex-1 text-[var(--color-accent)] font-mono">
              <span className="autocomplete-row-head flex items-center gap-2 min-w-0">
                <span className="autocomplete-row-title flex-1 min-w-0 truncate text-[var(--color-text)] font-semibold">{filenameFor(h.fullPath)}</span>
                <span className="autocomplete-row-insert text-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] border border-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] rounded-full px-1.5 py-[1px] text-[10px] max-w-[45%] truncate">{h.insertText}</span>
              </span>
              <span className="autocomplete-row-path text-[var(--color-text-dim)] text-[11px] truncate font-mono">{h.fullPath}</span>
            </span>
          </button>
        ))}
        {truncated && (
          <div className="autocomplete-truncated px-3 py-2 text-[var(--color-text-dim)] text-xs border-t border-[var(--color-border)]">
            (showing first {visible.length} of many; refine query)
          </div>
        )}
      </div>
    );
  },
);
