import { create } from 'zustand';
import type { ClientMsg, ServerDirsResultMsg, ServerFileResultMsg } from '../types/protocol';

export interface DirEntry {
  name: string;
  kind: 'dir' | 'file';
  size?: number;
}

export type SelectedFile =
  | { state: 'loading'; path: string }
  | { state: 'text'; path: string; content: string; bytesRead: number; truncated: boolean }
  | { state: 'binary'; path: string; mime?: string; size: number }
  | { state: 'too_large'; path: string; size: number };

interface FileExplorerStore {
  dirs: Record<string, DirEntry[]>;
  expanded: Record<string, true>;
  loadingPaths: Record<string, true>;
  selectedFile: SelectedFile | null;
  requestDirs(client: { send(m: ClientMsg): void }, path: string): void;
  applyDirsResult(m: ServerDirsResultMsg): void;
  toggleExpand(path: string): void;
  requestFile(client: { send(m: ClientMsg): void }, path: string): void;
  applyFileResult(m: ServerFileResultMsg): void;
  /**
   * Refresh the currently-rendered subtree: clear cached entries for every
   * currently-expanded path, then re-request each one. Called from the
   * drawer's refresh button. Spec §6 step 7.
   */
  refreshOpen(client: { send(m: ClientMsg): void }): void;
  reset(): void;
}

function newCorrelationId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const useFileExplorerStore = create<FileExplorerStore>((set, get) => ({
  dirs: {},
  expanded: {},
  loadingPaths: {},
  selectedFile: null,

  requestDirs(client, path) {
    set((s) => ({ loadingPaths: { ...s.loadingPaths, [path]: true } }));
    client.send({ type: 'list_dirs', path, correlationId: newCorrelationId() });
  },

  applyDirsResult(m) {
    set((s) => {
      const { [m.path]: _drop, ...restLoading } = s.loadingPaths;
      return {
        dirs: { ...s.dirs, [m.path]: m.entries.slice() },
        expanded: { ...s.expanded, [m.path]: true },
        loadingPaths: restLoading,
      };
    });
  },

  toggleExpand(path) {
    set((s) => {
      if (s.expanded[path]) {
        const { [path]: _drop, ...rest } = s.expanded;
        return { expanded: rest };
      }
      return { expanded: { ...s.expanded, [path]: true } };
    });
  },

  requestFile(client, path) {
    set({ selectedFile: { state: 'loading', path } });
    client.send({ type: 'read_file', path, correlationId: newCorrelationId() });
  },

  applyFileResult(m) {
    if (m.kind === 'text') {
      set({
        selectedFile: {
          state: 'text',
          path: m.path,
          content: m.content,
          bytesRead: m.bytesRead,
          truncated: m.truncated,
        },
      });
    } else if (m.kind === 'binary') {
      set({
        selectedFile: {
          state: 'binary',
          path: m.path,
          ...(m.mime ? { mime: m.mime } : {}),
          size: m.size,
        },
      });
    } else {
      set({ selectedFile: { state: 'too_large', path: m.path, size: m.size } });
    }
  },

  refreshOpen(client) {
    const openPaths = Object.keys(get().expanded);
    if (openPaths.length === 0) return;
    set((s) => {
      const dirs = { ...s.dirs };
      const loadingPaths = { ...s.loadingPaths };
      for (const p of openPaths) {
        delete dirs[p];
        loadingPaths[p] = true;
      }
      return { dirs, loadingPaths };
    });
    for (const p of openPaths) {
      client.send({ type: 'list_dirs', path: p, correlationId: newCorrelationId() });
    }
  },

  reset() {
    set({ dirs: {}, expanded: {}, loadingPaths: {}, selectedFile: null });
  },
}));
