/**
 * Global keyboard shortcuts.
 *
 * Two constraints shape every choice here.
 *
 * The chat composer holds focus almost all the time, so a shortcut has to be
 * usable mid-sentence. That rules out bare letters and anything the textarea
 * needs, and means every binding except the help key carries a modifier.
 *
 * The browser gets the keystroke first. `Cmd+1..9`, `Cmd+T`, `Cmd+W` and
 * friends are claimed by the tab bar and cannot be intercepted on macOS, so
 * session switching uses **Ctrl** rather than Cmd — Mac browsers leave
 * `Ctrl+digit` and `Ctrl+[`/`]` alone. On Windows and Linux `Ctrl+1..9` does
 * switch tabs; this is a Mac-first tool and that is the trade.
 */

export type ShortcutId =
  | 'send'
  | 'newline'
  | 'interrupt'
  | 'palette'
  | 'next-session'
  | 'prev-session'
  | 'jump-session'
  | 'new-session'
  | 'toggle-files'
  | 'focus-input'
  | 'help';

export interface ShortcutSpec {
  id: ShortcutId;
  /** Rendered in the help sheet, using the platform's modifier glyphs. */
  keys: string;
  description: string;
  /**
   * True for bindings the composer handles itself rather than the global
   * matcher. They belong in the documentation — they are the first thing anyone
   * asks about — but `matchShortcut` will never return them, because a textarea
   * has to own its own Enter key.
   */
  local?: boolean;
}

/** Documented bindings, in the order the help sheet lists them. */
export const SHORTCUTS: readonly ShortcutSpec[] = [
  // Handled inside the composer rather than by the global matcher, but it is
  // the binding people ask about first, so it leads the list.
  { id: 'send', keys: 'Enter', description: 'Send the message', local: true },
  { id: 'newline', keys: 'Shift+Enter', description: 'New line without sending', local: true },
  {
    id: 'interrupt',
    keys: 'Esc',
    description: 'Stop the current turn (Ctrl+C also works)',
    local: true,
  },
  { id: 'palette', keys: 'Mod+K', description: 'Command palette — jump to any session' },
  { id: 'next-session', keys: 'Ctrl+]', description: 'Next running session' },
  { id: 'prev-session', keys: 'Ctrl+[', description: 'Previous running session' },
  { id: 'jump-session', keys: 'Ctrl+1…9', description: 'Jump to the Nth running session' },
  { id: 'new-session', keys: 'Mod+Shift+N', description: 'New session' },
  { id: 'toggle-files', keys: 'Mod+Shift+E', description: 'Toggle the file drawer' },
  { id: 'focus-input', keys: 'Mod+/', description: 'Focus the message box' },
  { id: 'help', keys: '?', description: 'This list' },
];

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** `Mod` renders as ⌘ on Apple platforms and Ctrl everywhere else. */
export function renderKeys(keys: string, mac = isMac()): string {
  return keys
    .replace(/\bMod\b/g, mac ? '⌘' : 'Ctrl')
    .replace(/\bShift\b/g, mac ? '⇧' : 'Shift')
    .replace(/\bCtrl\b/g, mac ? '⌃' : 'Ctrl')
    .replace(/\+/g, mac ? '' : '+');
}

/**
 * Whether the event originated inside something the user is typing into.
 *
 * Bare-key shortcuts must stand down here or `?` becomes impossible to type.
 * Modified combos still fire — that is the whole point of requiring a modifier.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  // Monaco renders into a container it marks; its own textarea is caught above,
  // but clicks on the editor chrome land on a div inside this class.
  return el.closest?.('.monaco-code-editor') !== null && el.closest?.('.monaco-code-editor') !== undefined;
}

export interface ShortcutMatch {
  id: ShortcutId;
  /** For `jump-session`, the 1-based index that was pressed. */
  index?: number;
}

/**
 * Map a keydown to a shortcut, or null when it is not one of ours.
 *
 * Pure so the binding table can be tested without a DOM: the hook does nothing
 * but call this and dispatch.
 */
export function matchShortcut(e: {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target?: EventTarget | null;
}): ShortcutMatch | null {
  const mod = e.metaKey || e.ctrlKey;
  const typing = isTypingTarget(e.target ?? null);

  // Bare `?`. Only outside a text field, and never with a modifier held, or it
  // would swallow the browser's own combos.
  if (!mod && !e.altKey && e.key === '?' && !typing) {
    return { id: 'help' };
  }

  if (!mod) return null;

  if (e.shiftKey) {
    // Compared on `code` so the physical key wins regardless of what the shift
    // modifier turned it into on a non-US layout.
    if (e.code === 'KeyN' || e.key.toLowerCase() === 'n') return { id: 'new-session' };
    if (e.code === 'KeyE' || e.key.toLowerCase() === 'e') return { id: 'toggle-files' };
    return null;
  }

  if (e.key.toLowerCase() === 'k') return { id: 'palette' };
  if (e.key === '/') return { id: 'focus-input' };

  // Session cycling and jumping are Ctrl-only: Cmd+digit is the browser's tab
  // bar and is not interceptable on macOS.
  if (e.ctrlKey && !e.metaKey) {
    if (e.key === ']') return { id: 'next-session' };
    if (e.key === '[') return { id: 'prev-session' };
    if (/^[1-9]$/.test(e.key)) return { id: 'jump-session', index: Number(e.key) };
  }

  return null;
}
