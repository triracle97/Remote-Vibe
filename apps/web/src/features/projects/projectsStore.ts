import { create } from 'zustand';

const STORAGE_KEY = 'mrt.projects';

function readStored(): string[] {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (!v) return [];
    const parsed: unknown = JSON.parse(v);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return [];
}

function writeStored(paths: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
  } catch {
    // ignore
  }
}

interface ProjectsState {
  paths: string[];
  add(path: string): void;
  remove(path: string): void;
  move(from: number, to: number): void;
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
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
  move(from, to) {
    const current = get().paths;
    if (from < 0 || from >= current.length || to < 0 || to >= current.length) return;
    const next = current.slice();
    const [item] = next.splice(from, 1);
    if (item === undefined) return;
    next.splice(to, 0, item);
    writeStored(next);
    set({ paths: next });
  },
}));
