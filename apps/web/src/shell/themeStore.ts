import { create } from 'zustand';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'mrt.theme';

function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // ignore — fall through
  }
  return 'system';
}

function writeStoredMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore — store still updates in-memory
  }
}

interface ThemeState {
  mode: ThemeMode;
  setMode(mode: ThemeMode): void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: readStoredMode(),
  setMode(mode) {
    writeStoredMode(mode);
    set({ mode });
  },
}));

export function resolveTheme(
  mode: ThemeMode,
  prefersLight: () => boolean,
): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode;
  return prefersLight() ? 'light' : 'dark';
}
