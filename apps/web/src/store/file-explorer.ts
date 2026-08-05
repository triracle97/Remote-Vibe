import { create } from 'zustand';
import type {
  ClientMsg,
  ServerDirsResultMsg,
  ServerErrorMsg,
  ServerFileResultMsg,
  ServerFileWrittenMsg,
} from '../types/protocol';

export interface DirEntry {
  name: string;
  kind: 'dir' | 'file';
  size?: number;
}

export type SelectedFile =
  | { state: 'loading'; path: string }
  | {
      state: 'text';
      path: string;
      content: string;
      bytesRead: number;
      truncated: boolean;
      /** Hash of `content` as read; sent back on save to detect conflicts. */
      hash: string;
    }
  | { state: 'binary'; path: string; mime?: string; size: number }
  | { state: 'too_large'; path: string; size: number };

/**
 * Editor state for the currently-selected file. Split out from `selectedFile`
 * so that typing does not re-render the tree, and so a save round-trip cannot
 * clobber the content the user is still editing.
 */
export interface EditorState {
  dirty: boolean;
  saving: boolean;
  /** Human-readable failure from the last save attempt, if any. */
  error: string | null;
  /**
   * The file changed on disk since it was loaded. The UI turns the save button
   * into an explicit overwrite confirmation while this is set.
   */
  conflict: boolean;
}

const IDLE_EDITOR: EditorState = { dirty: false, saving: false, error: null, conflict: false };

/** Error codes a `write_file` round-trip can come back with. */
const WRITE_ERROR_MESSAGES: Record<string, string> = {
  file_conflict: 'File changed on disk since you opened it.',
  file_too_large: 'File is too large to save.',
  file_write_failed: 'Write failed.',
  path_denied: 'Path is on the bridge denylist.',
  path_outside_allowlist: 'Path is outside the bridge allowlist.',
};

interface FileExplorerStore {
  dirs: Record<string, DirEntry[]>;
  expanded: Record<string, true>;
  loadingPaths: Record<string, true>;
  selectedFile: SelectedFile | null;
  editor: EditorState;
  /** Correlation id of the in-flight `write_file`, if any. */
  pendingWriteId: string | null;
  requestDirs(client: { send(m: ClientMsg): void }, path: string): void;
  applyDirsResult(m: ServerDirsResultMsg): void;
  toggleExpand(path: string): void;
  requestFile(client: { send(m: ClientMsg): void }, path: string): void;
  applyFileResult(m: ServerFileResultMsg): void;
  setDirty(dirty: boolean): void;
  /**
   * Persist `content` to the selected file.
   *
   * Sends the hash the file was loaded with, so the bridge refuses the write
   * if anything touched the file in the meantime. `force` drops that check and
   * is only reachable from the overwrite confirmation.
   */
  saveFile(
    client: { send(m: ClientMsg): void },
    content: string,
    opts?: { force?: boolean },
  ): void;
  applyFileWritten(m: ServerFileWrittenMsg): void;
  /**
   * Claim an error that belongs to our in-flight write. Returns true when it
   * did, so the shell can keep it out of the global error banner and let the
   * editor pane show it in context instead.
   */
  applyServerError(m: ServerErrorMsg): boolean;
  clearEditorError(): void;
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
  editor: IDLE_EDITOR,
  pendingWriteId: null,

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
    // Selecting a file always abandons whatever the editor was holding — the
    // pane remounts on the new path, so keeping the old dirty flag would show
    // unsaved changes for a file nobody is editing.
    set({ selectedFile: { state: 'loading', path }, editor: IDLE_EDITOR, pendingWriteId: null });
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
          hash: m.hash,
        },
        editor: IDLE_EDITOR,
      });
    } else if (m.kind === 'binary') {
      set({
        selectedFile: {
          state: 'binary',
          path: m.path,
          ...(m.mime ? { mime: m.mime } : {}),
          size: m.size,
        },
        editor: IDLE_EDITOR,
      });
    } else {
      set({
        selectedFile: { state: 'too_large', path: m.path, size: m.size },
        editor: IDLE_EDITOR,
      });
    }
  },

  setDirty(dirty) {
    set((s) => (s.editor.dirty === dirty ? {} : { editor: { ...s.editor, dirty } }));
  },

  saveFile(client, content, opts) {
    const file = get().selectedFile;
    if (!file || file.state !== 'text') return;
    if (get().editor.saving) return;

    const correlationId = newCorrelationId();
    set((s) => ({
      editor: { ...s.editor, saving: true, error: null },
      pendingWriteId: correlationId,
    }));
    client.send({
      type: 'write_file',
      path: file.path,
      content,
      correlationId,
      ...(opts?.force ? {} : { baseHash: file.hash }),
    });
  },

  applyFileWritten(m) {
    set((s) => {
      if (s.pendingWriteId && m.correlationId && m.correlationId !== s.pendingWriteId) return {};
      const file = s.selectedFile;
      return {
        editor: { dirty: false, saving: false, error: null, conflict: false },
        pendingWriteId: null,
        // Adopt the new hash so the next save's conflict check compares
        // against what we just wrote, not what we originally loaded.
        ...(file && file.state === 'text' && file.path === m.path
          ? { selectedFile: { ...file, hash: m.hash, bytesRead: m.bytesWritten } }
          : {}),
      };
    });
  },

  applyServerError(m) {
    const pending = get().pendingWriteId;
    // Only errors belonging to our own in-flight write concern the editor;
    // everything else on the socket is someone else's problem.
    if (!pending || m.correlationId !== pending) return false;
    set((s) => ({
      editor: {
        ...s.editor,
        saving: false,
        conflict: m.code === 'file_conflict',
        error: WRITE_ERROR_MESSAGES[m.code] ?? `${m.code}: ${m.message}`,
      },
      pendingWriteId: null,
    }));
    return true;
  },

  clearEditorError() {
    set((s) => ({ editor: { ...s.editor, error: null, conflict: false } }));
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
    set({
      dirs: {},
      expanded: {},
      loadingPaths: {},
      selectedFile: null,
      editor: IDLE_EDITOR,
      pendingWriteId: null,
    });
  },
}));
