import { useEffect, useState } from 'react';

/**
 * A clock that re-renders on a beat.
 *
 * "Resets in 2h 10m" is computed against `Date.now()` at render, so a popover
 * left open reads the same minute for as long as it is open. Ticking every
 * half-minute keeps a countdown honest without a re-render per second.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
