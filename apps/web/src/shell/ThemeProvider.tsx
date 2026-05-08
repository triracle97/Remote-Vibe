import { useEffect, type ReactNode } from 'react';
import { useThemeStore, resolveTheme } from './themeStore';

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps): JSX.Element {
  const mode = useThemeStore((s) => s.mode);

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const apply = (): void => {
      const resolved = resolveTheme(mode, () => mql.matches);
      document.documentElement.setAttribute('data-theme', resolved);
    };
    apply();
    if (mode !== 'system') return;
    const handler = (): void => apply();
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [mode]);

  return <>{children}</>;
}
