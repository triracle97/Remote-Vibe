import { create } from 'zustand';
import { DEFAULT_WORKSPACE_DIRS } from './default-workspaces';

const STORAGE_KEY = 'mrt.defaultWorkspaces';

function readStored(): string[] {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === null) return [...DEFAULT_WORKSPACE_DIRS];
    const parsed: unknown = JSON.parse(v);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return [...DEFAULT_WORKSPACE_DIRS];
}

function writeStored(paths: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
  } catch {
    // ignore
  }
}

interface State {
  paths: string[];
  add(path: string): void;
  remove(path: string): void;
}

export const useDefaultWorkspacesStore = create<State>((set, get) => ({
  paths: readStored(),
  add(path) {
    if (!path) return;
    const current = get().paths;
    if (current.includes(path)) return;
    const next = [...current, path];
    writeStored(next);
    set({ paths: next });
  },
  remove(path) {
    const next = get().paths.filter((p) => p !== path);
    writeStored(next);
    set({ paths: next });
  },
}));
