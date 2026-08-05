import { useEffect, useState } from 'react';

/**
 * True when the device has a real keyboard, i.e. a fine pointer.
 *
 * Exists for exactly one decision: whether Enter should send the message.
 *
 * On a desktop, Enter-to-send with Shift+Enter for a newline is what everyone
 * expects. On a phone it is a trap — iOS and Android software keyboards have no
 * way to produce Shift+Enter, so binding Enter to send leaves no way at all to
 * type a second line.
 *
 * `(pointer: coarse)` is the right test rather than a width breakpoint: it
 * tracks the input device, which is the thing that actually determines whether
 * Shift+Enter is reachable. A narrow desktop window keeps its keyboard; a
 * tablet in landscape does not grow one.
 */
const FINE_POINTER = '(pointer: fine)';

export function useHasKeyboard(): boolean {
  const [fine, setFine] = useState(
    () => typeof window === 'undefined' || window.matchMedia(FINE_POINTER).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(FINE_POINTER);
    const onChange = (): void => setFine(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return fine;
}
