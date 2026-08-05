import { describe, it, expect } from 'vitest';
import { matchShortcut, renderKeys, isTypingTarget, SHORTCUTS } from './shortcuts';

function ev(over: Partial<Parameters<typeof matchShortcut>[0]> = {}) {
  return {
    key: 'a',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    ...over,
  };
}

/** A stand-in for a focused textarea, which is the normal state of this app. */
const TEXTAREA = { tagName: 'TEXTAREA', isContentEditable: false } as unknown as EventTarget;

describe('matchShortcut', () => {
  it('opens the palette on either modifier', () => {
    expect(matchShortcut(ev({ key: 'k', metaKey: true }))).toEqual({ id: 'palette' });
    expect(matchShortcut(ev({ key: 'k', ctrlKey: true }))).toEqual({ id: 'palette' });
  });

  it('still fires while the composer has focus', () => {
    // The whole reason every binding carries a modifier: you are always typing.
    expect(matchShortcut(ev({ key: 'k', metaKey: true, target: TEXTAREA }))).toEqual({
      id: 'palette',
    });
  });

  it('ignores an unmodified letter so typing works', () => {
    expect(matchShortcut(ev({ key: 'k' }))).toBeNull();
    expect(matchShortcut(ev({ key: 'n', target: TEXTAREA }))).toBeNull();
  });

  it('cycles sessions with Ctrl-bracket, not Cmd', () => {
    expect(matchShortcut(ev({ key: ']', ctrlKey: true }))).toEqual({ id: 'next-session' });
    expect(matchShortcut(ev({ key: '[', ctrlKey: true }))).toEqual({ id: 'prev-session' });
    // Cmd+] is browser history navigation and is not ours to take.
    expect(matchShortcut(ev({ key: ']', metaKey: true }))).toBeNull();
  });

  it('jumps to a session by Ctrl+digit, carrying the index', () => {
    expect(matchShortcut(ev({ key: '3', ctrlKey: true }))).toEqual({
      id: 'jump-session',
      index: 3,
    });
    // Cmd+digit is the browser tab bar on macOS and cannot be intercepted.
    expect(matchShortcut(ev({ key: '3', metaKey: true }))).toBeNull();
    // Zero is not a session index.
    expect(matchShortcut(ev({ key: '0', ctrlKey: true }))).toBeNull();
  });

  it('maps the shifted actions', () => {
    expect(matchShortcut(ev({ key: 'N', metaKey: true, shiftKey: true, code: 'KeyN' }))).toEqual({
      id: 'new-session',
    });
    expect(matchShortcut(ev({ key: 'E', metaKey: true, shiftKey: true, code: 'KeyE' }))).toEqual({
      id: 'toggle-files',
    });
  });

  it('uses the physical key so a non-US layout still matches', () => {
    // Shift can produce any character; `code` is what the key actually is.
    expect(
      matchShortcut(ev({ key: 'Ñ', metaKey: true, shiftKey: true, code: 'KeyN' })),
    ).toEqual({ id: 'new-session' });
  });

  it('focuses the composer on Mod+/', () => {
    expect(matchShortcut(ev({ key: '/', metaKey: true }))).toEqual({ id: 'focus-input' });
  });

  it('shows help on a bare ? only outside a text field', () => {
    expect(matchShortcut(ev({ key: '?' }))).toEqual({ id: 'help' });
    // Otherwise you could never type a question mark.
    expect(matchShortcut(ev({ key: '?', target: TEXTAREA }))).toBeNull();
    // And a modified ? belongs to the browser.
    expect(matchShortcut(ev({ key: '?', metaKey: true }))).toBeNull();
  });

  it('claims nothing else', () => {
    expect(matchShortcut(ev({ key: 't', metaKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: 'w', metaKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: 'Enter', metaKey: true }))).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('recognises the fields a shortcut must not steal from', () => {
    expect(isTypingTarget(TEXTAREA)).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(
      isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget),
    ).toBe(true);
  });

  it('treats a plain element as fair game', () => {
    expect(
      isTypingTarget({
        tagName: 'DIV',
        isContentEditable: false,
        closest: () => null,
      } as unknown as EventTarget),
    ).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('renderKeys', () => {
  it('uses glyphs on Apple platforms and words elsewhere', () => {
    expect(renderKeys('Mod+K', true)).toBe('⌘K');
    expect(renderKeys('Mod+K', false)).toBe('Ctrl+K');
    expect(renderKeys('Mod+Shift+N', true)).toBe('⌘⇧N');
    expect(renderKeys('Ctrl+]', true)).toBe('⌃]');
  });
});

describe('SHORTCUTS table', () => {
  it('documents the composer bindings as local', () => {
    const local = SHORTCUTS.filter((s) => s.local).map((s) => s.id);
    expect(local).toEqual(['send', 'newline', 'interrupt']);
    // And the global listener must not try to claim Enter or Escape — the
    // textarea owns Enter, and Escape belongs to whatever popover is open.
    expect(matchShortcut(ev({ key: 'Enter' }))).toBeNull();
    expect(matchShortcut(ev({ key: 'Escape' }))).toBeNull();
    expect(matchShortcut(ev({ key: 'Enter', shiftKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: 'Enter', metaKey: true }))).toBeNull();
  });

  it('documents every id the matcher can return', () => {
    // `local` bindings (Enter / Shift+Enter) are the composer's own — a
    // textarea has to own its Enter key — so they are documented but never
    // returned by the global matcher.
    const documented = new Set(SHORTCUTS.filter((s) => !s.local).map((s) => s.id));
    const produced = [
      matchShortcut(ev({ key: 'k', metaKey: true })),
      matchShortcut(ev({ key: ']', ctrlKey: true })),
      matchShortcut(ev({ key: '[', ctrlKey: true })),
      matchShortcut(ev({ key: '1', ctrlKey: true })),
      matchShortcut(ev({ key: 'N', metaKey: true, shiftKey: true, code: 'KeyN' })),
      matchShortcut(ev({ key: 'E', metaKey: true, shiftKey: true, code: 'KeyE' })),
      matchShortcut(ev({ key: '/', metaKey: true })),
      matchShortcut(ev({ key: '?' })),
    ];
    for (const m of produced) {
      expect(m).not.toBeNull();
      expect(documented.has(m!.id)).toBe(true);
    }
    // And nothing documented is unreachable.
    expect(documented.size).toBe(new Set(produced.map((m) => m!.id)).size);
  });
});
