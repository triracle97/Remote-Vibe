import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { useSlashCommandStore } from './slashCommandStore';
import type { SlashCommand } from '../../types/protocol';

interface SlashAutocompleteProps {
  sessionId: string;
  agent: 'claude' | 'codex';
  /** Current text in the textarea — drives filtering. */
  text: string;
  /** Cursor position in the text. */
  cursor: number;
  /** Called with the FULL replacement text + new cursor when user picks. */
  onPick: (newText: string, newCursor: number) => void;
}

/**
 * Imperative handle InputBox uses to forward ↑↓+Enter+Esc keys from the
 * textarea into the popup. The popup itself doesn't focus — keyboard nav
 * lives on the textarea so typing is uninterrupted.
 */
export interface SlashAutocompleteHandle {
  /** True when popup is currently rendered (trigger matched + has results). */
  isOpen(): boolean;
  /**
   * Forward a keyboard event from the textarea. Returns true if the popup
   * handled it (caller should preventDefault/stop further handling).
   */
  handleKey(e: { key: string; preventDefault?: () => void }): boolean;
}

/** Detect `/<word>` at start-of-line preceding `cursor`. Exported for tests. */
export function findSlashTrigger(text: string, cursor: number): { start: number; query: string } | null {
  const beforeCursor = text.slice(0, cursor);
  const m = /(^|\n)\/([\w-]*)$/.exec(beforeCursor);
  if (!m) return null;
  const query = m[2] ?? '';
  // m.index is where the (^|\n) capture starts; the `/` sits at m.index + (m[1]?.length ?? 0).
  const slashStart = (m.index ?? 0) + (m[1]?.length ?? 0);
  return { start: slashStart, query };
}

export const SlashAutocomplete = forwardRef<SlashAutocompleteHandle, SlashAutocompleteProps>(
  function SlashAutocomplete(
    { sessionId, agent, text, cursor, onPick }: SlashAutocompleteProps,
    ref,
  ): JSX.Element | null {
    const trigger = findSlashTrigger(text, cursor);
    const slashStart = trigger?.start ?? -1;
    const query = trigger?.query ?? '';

    const fetchCmds = useSlashCommandStore((s) => s.fetch);
    const cmds = useSlashCommandStore((s) => s.bySession[sessionId]?.commands ?? []);

    useEffect(() => {
      if (slashStart >= 0) fetchCmds(sessionId);
    }, [slashStart, sessionId, fetchCmds]);

    const filtered = useMemo<SlashCommand[]>(() => {
      if (slashStart < 0) return [];
      const q = query.toLowerCase();
      const matched = cmds.filter((c) => {
        if (c.agent !== agent && c.agent !== 'both') return false;
        const n = c.name.toLowerCase().slice(1); // strip leading /
        if (q.length === 0) return true;
        return n.startsWith(q) || n.includes(q);
      });
      return matched.slice(0, 10);
    }, [cmds, agent, query, slashStart]);

    const [active, setActive] = useState(0);

    useEffect(() => {
      setActive(0);
    }, [filtered.length, query]);

    const open = slashStart >= 0 && filtered.length > 0;

    const insert = (cmd: SlashCommand): void => {
      const before = text.slice(0, slashStart);
      const after = text.slice(cursor);
      const inserted = `${cmd.name} `;
      const newText = before + inserted + after;
      const newCursor = before.length + inserted.length;
      onPick(newText, newCursor);
    };

    useImperativeHandle(
      ref,
      (): SlashAutocompleteHandle => ({
        isOpen: () => open,
        handleKey: (e) => {
          if (!open) return false;
          if (e.key === 'ArrowDown') {
            e.preventDefault?.();
            setActive((a) => (a + 1) % filtered.length);
            return true;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault?.();
            setActive((a) => (a - 1 + filtered.length) % filtered.length);
            return true;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            const pick = filtered[active];
            if (!pick) return false;
            e.preventDefault?.();
            insert(pick);
            return true;
          }
          return false;
        },
      }),
      // active/filtered/insert change every render; re-bind handle so the
      // key handler always sees the current selection.
      [open, active, filtered, insert],
    );

    if (!open) return null;

    return (
      <div className="autocomplete-popup slash-autocomplete" role="listbox" aria-label="Slash commands">
        {filtered.map((c, i) => (
          <button
            key={c.name}
            type="button"
            role="option"
            aria-selected={i === active}
            className={`autocomplete-row ${i === active ? 'active' : ''}`}
            onMouseEnter={() => setActive(i)}
            // Use onMouseDown so click fires before textarea blur swallows
            // the event on mobile / certain keyboard layouts.
            onMouseDown={(e) => {
              e.preventDefault();
              insert(c);
            }}
          >
            <span className="autocomplete-row-primary">{c.name}</span>
            <span className="autocomplete-row-source">[{c.source}]</span>
            {c.description && <span className="autocomplete-row-desc">{c.description}</span>}
          </button>
        ))}
      </div>
    );
  },
);
