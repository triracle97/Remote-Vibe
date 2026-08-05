import { useEffect, useState } from 'react';
import type { ResolvedTheme } from './themeStore';

function read(): ResolvedTheme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/**
 * The theme actually in effect, read off `documentElement[data-theme]`.
 *
 * `ThemeProvider` is the single writer of that attribute, and it already
 * resolves `system` against the media query — observing the attribute means
 * consumers get the resolved value without duplicating that logic or
 * subscribing to the media query a second time.
 */
export function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(read);

  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    // The attribute may have changed between first render and effect.
    setTheme(read());
    return () => observer.disconnect();
  }, []);

  return theme;
}
