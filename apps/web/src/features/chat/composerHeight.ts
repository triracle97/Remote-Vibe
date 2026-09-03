import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

/**
 * Composer sizing.
 *
 * Two things are going on, and they are deliberately separate. The textarea
 * grows on its own as you type, so the common "it's too small" never needs a
 * gesture at all — which matters on a phone, where a drag handle is the worst
 * possible primary control. The handle is the override: once you drag (or
 * arrow-key) it, that height sticks and survives reloads until you reset.
 */

/** Roughly the old fixed `rows={3}` — the floor, never smaller than this. */
export const COMPOSER_MIN_HEIGHT = 72;
/** Ceiling as a share of the visible viewport; the transcript keeps the rest. */
const MAX_VIEWPORT_FRACTION = 0.6;
/** One arrow-key press. */
export const COMPOSER_NUDGE_STEP = 24;

const STORAGE_KEY = 'mrt.composerHeight';

/**
 * Visible viewport, not `innerHeight`. On iOS the software keyboard shrinks
 * `visualViewport` but not `innerHeight`, so using the latter would let the
 * composer claim a height that is entirely behind the keyboard.
 */
export function viewportHeight(): number {
  if (typeof window === 'undefined') return 0;
  return Math.round(window.visualViewport?.height ?? window.innerHeight ?? 0);
}

export function composerMaxHeight(viewport: number): number {
  return Math.max(COMPOSER_MIN_HEIGHT, Math.round(viewport * MAX_VIEWPORT_FRACTION));
}

export function clampComposerHeight(px: number, viewport: number): number {
  if (!Number.isFinite(px)) return COMPOSER_MIN_HEIGHT;
  return Math.min(Math.max(Math.round(px), COMPOSER_MIN_HEIGHT), composerMaxHeight(viewport));
}

export function readStoredComposerHeight(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  } catch {
    return null;
  }
}

export function writeStoredComposerHeight(px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(Math.round(px)));
  } catch {
    // ignore — the in-memory height still applies for this session
  }
}

export interface ComposerHeight {
  /** Pixel height to put on the textarea. */
  height: number;
  /** True while a user-chosen height is in force (auto-grow is suspended). */
  manual: boolean;
  onGripPointerDown(e: ReactPointerEvent<HTMLElement>): void;
  onGripKeyDown(e: ReactKeyboardEvent<HTMLElement>): void;
  /** Drop the manual height and go back to growing with the content. */
  resetHeight(): void;
  max: number;
}

/**
 * Height of the composer textarea: auto-grown from content, or pinned by the
 * user via the grip.
 *
 * `text` is a dependency rather than an `onChange` hook because the composer
 * is written to from several places that never touch the keyboard — pasted
 * file paths, prompt history, the resume-and-send flow — and all of them
 * should re-measure.
 */
export function useComposerHeight(
  taRef: RefObject<HTMLTextAreaElement>,
  text: string,
): ComposerHeight {
  const [manualHeight, setManualHeight] = useState<number | null>(readStoredComposerHeight);
  const [autoHeight, setAutoHeight] = useState(COMPOSER_MIN_HEIGHT);
  const [max, setMax] = useState(() => composerMaxHeight(viewportHeight()));

  // Measure after layout so `scrollHeight` reflects the text just committed.
  // Collapsing to `auto` first is what makes shrinking work: `scrollHeight`
  // never reports less than the height already set.
  useLayoutEffect(() => {
    if (manualHeight !== null) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const next = clampComposerHeight(ta.scrollHeight, viewportHeight());
    ta.style.height = `${next}px`;
    setAutoHeight(next);
  }, [taRef, text, manualHeight, max]);

  // The ceiling moves when the window resizes or the phone keyboard opens; a
  // height chosen against the old ceiling has to come back down with it.
  useEffect(() => {
    const onResize = (): void => {
      const vh = viewportHeight();
      setMax(composerMaxHeight(vh));
      setManualHeight((h) => (h === null ? null : clampComposerHeight(h, vh)));
    };
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, []);

  const height = manualHeight ?? autoHeight;
  const heightRef = useRef(height);
  heightRef.current = height;

  const resetHeight = useCallback(() => {
    setManualHeight(null);
    writeStoredComposerHeight(null);
  }, []);

  const onGripPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    // Left button / touch / pen only, and never while a text selection drag
    // is in flight.
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = heightRef.current;
    const vh = viewportHeight();
    let latest = startH;

    const onMove = (ev: PointerEvent): void => {
      // Grip sits on top of the composer, so dragging *up* makes it taller.
      latest = clampComposerHeight(startH + (startY - ev.clientY), vh);
      setManualHeight(latest);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      writeStoredComposerHeight(latest);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, []);

  const onGripKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>): void => {
      const vh = viewportHeight();
      const apply = (px: number): void => {
        e.preventDefault();
        const next = clampComposerHeight(px, vh);
        setManualHeight(next);
        writeStoredComposerHeight(next);
      };
      switch (e.key) {
        case 'ArrowUp':
          return apply(heightRef.current + COMPOSER_NUDGE_STEP);
        case 'ArrowDown':
          return apply(heightRef.current - COMPOSER_NUDGE_STEP);
        case 'Home':
          return apply(COMPOSER_MIN_HEIGHT);
        case 'End':
          return apply(composerMaxHeight(vh));
        case 'Enter':
        case ' ':
        case 'Escape':
          e.preventDefault();
          resetHeight();
          return;
        default:
          return;
      }
    },
    [resetHeight],
  );

  return { height, manual: manualHeight !== null, onGripPointerDown, onGripKeyDown, resetHeight, max };
}
