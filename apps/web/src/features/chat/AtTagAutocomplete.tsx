import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
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
      <div className="autocomplete-popup at-tag-autocomplete" role="listbox" aria-label="File suggestions">
        {visible.map((h, i) => (
          <button
            key={h.fullPath}
            type="button"
            role="option"
            aria-selected={i === active}
            className={`autocomplete-row ${i === active ? 'active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              insert(h.insertText);
            }}
            title={h.fullPath}
          >
            <span className="autocomplete-row-primary">
              <span className="autocomplete-row-head">
                <span className="autocomplete-row-title">{filenameFor(h.fullPath)}</span>
                <span className="autocomplete-row-insert">{h.insertText}</span>
              </span>
              <span className="autocomplete-row-path">{h.fullPath}</span>
            </span>
            <span className="autocomplete-row-time">{relTime(h.mtime)}</span>
          </button>
        ))}
        {truncated && (
          <div className="autocomplete-truncated">
            (showing first {visible.length} of many; refine query)
          </div>
        )}
      </div>
    );
  },
);

function relTime(mtime: number): string {
  const ms = Date.now() - mtime;
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(mtime).toLocaleDateString();
}
