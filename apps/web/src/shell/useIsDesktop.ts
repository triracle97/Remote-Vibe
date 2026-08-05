import { useEffect, useState } from 'react';

/**
 * The one place the desktop breakpoint is defined in JS.
 *
 * Must stay in step with Tailwind's `md:` (768px), because several components
 * pair a CSS `md:` rule with a JS branch on the same boundary — a mismatch
 * shows up as a panel that is hidden by CSS while its JS thinks it is visible.
 */
const DESKTOP_QUERY = '(min-width: 768px)';

/**
 * True when the viewport is at or above the `md:` breakpoint.
 *
 * Needed wherever the mobile and desktop presentations are structurally
 * different rather than just styled differently — a bottom sheet versus a
 * docked panel, say, which cannot be expressed by toggling classes on one tree.
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(DESKTOP_QUERY);
    const onChange = (e: MediaQueryListEvent): void => setIsDesktop(e.matches);
    mql.addEventListener('change', onChange);
    // Re-sync in case the width changed between first render and this effect.
    setIsDesktop(mql.matches);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isDesktop;
}
