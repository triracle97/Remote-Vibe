import { useEffect } from 'react';
import { matchShortcut, type ShortcutId } from './shortcuts';

export type ShortcutHandlers = Partial<Record<ShortcutId, (index?: number) => void>>;

/**
 * One document-level keydown listener for the whole app.
 *
 * Registered in `AppShell` rather than per page, so a shortcut works the same
 * on the board as it does mid-session. Capture phase on purpose: Monaco and the
 * composer both stop propagation for keys they handle, and a bubble-phase
 * listener would simply never see ⌘K while the editor has focus.
 *
 * Handlers are read through a ref-like closure refresh on every render, so a
 * stale callback cannot outlive the component that supplied it.
 */
export function useGlobalShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      // Let the user finish an IME composition before reading the key.
      if (e.isComposing) return;
      const match = matchShortcut({
        key: e.key,
        code: e.code,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        target: e.target,
      });
      if (!match) return;
      const handler = handlers[match.id];
      if (!handler) return;
      // Only claim the keystroke once something is actually going to act on
      // it, or an unhandled binding would silently eat a browser shortcut.
      e.preventDefault();
      e.stopPropagation();
      handler(match.index);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [handlers, enabled]);
}
