import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useFileExplorerStore } from './file-explorer';
import type {
  ClientMsg,
  ServerDirsResultMsg,
  ServerErrorMsg,
  ServerFileResultMsg,
} from '../types/protocol';

beforeEach(() => {
  useFileExplorerStore.setState({
    dirs: {},
    expanded: {},
    loadingPaths: {},
    selectedFile: null,
    editor: { dirty: false, saving: false, error: null, conflict: false },
    pendingWriteId: null,
  });
});

/** A text file already loaded into the editor, ready to be saved. */
function seedTextFile(path = '/p/a.ts', content = 'v1', hash = 'h1'): void {
  useFileExplorerStore.setState({
    selectedFile: {
      state: 'text',
      path,
      content,
      bytesRead: content.length,
      truncated: false,
      hash,
    },
  });
}

function makeClient() {
  const sent: ClientMsg[] = [];
  const send = vi.fn((m: ClientMsg): void => {
    sent.push(m);
  });
  return { send, sent };
}

describe('file-explorer store', () => {
  it('applyDirsResult caches entries by path and clears loading', () => {
    useFileExplorerStore.setState({ loadingPaths: { '/p': true } });
    const msg: ServerDirsResultMsg = {
      type: 'dirs_result',
      path: '/p',
      entries: [
        { name: 'src', kind: 'dir' },
        { name: 'a.txt', kind: 'file', size: 12 },
      ],
    };
    useFileExplorerStore.getState().applyDirsResult(msg);
    const s = useFileExplorerStore.getState();
    expect(s.dirs['/p']!.length).toBe(2);
    expect(s.loadingPaths['/p']).toBeUndefined();
    expect(s.expanded['/p']).toBe(true);
  });

  it('toggleExpand collapses an expanded path', () => {
    useFileExplorerStore.setState({ expanded: { '/p': true } });
    useFileExplorerStore.getState().toggleExpand('/p');
    expect(useFileExplorerStore.getState().expanded['/p']).toBeUndefined();
  });

  it('requestDirs calls client.send with list_dirs and tracks loading', () => {
    const client = { send: vi.fn() };
    useFileExplorerStore.getState().requestDirs(client as unknown as { send: (m: unknown) => void }, '/p');
    expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'list_dirs', path: '/p' }));
    expect(useFileExplorerStore.getState().loadingPaths['/p']).toBe(true);
  });

  it('applyFileResult sets selectedFile to text', () => {
    const msg: ServerFileResultMsg = {
      type: 'file_result',
      kind: 'text',
      path: '/p/file.txt',
      content: 'hello',
      bytesRead: 5,
      truncated: false,
      hash: 'abc123',
    };
    useFileExplorerStore.getState().applyFileResult(msg);
    expect(useFileExplorerStore.getState().selectedFile).toEqual({
      state: 'text',
      path: '/p/file.txt',
      content: 'hello',
      bytesRead: 5,
      truncated: false,
      hash: 'abc123',
    });
  });

  it('applyFileResult sets selectedFile to binary', () => {
    const msg: ServerFileResultMsg = {
      type: 'file_result',
      kind: 'binary',
      path: '/p/img.png',
      mime: 'image/png',
      size: 1024,
    };
    useFileExplorerStore.getState().applyFileResult(msg);
    expect(useFileExplorerStore.getState().selectedFile).toEqual({
      state: 'binary',
      path: '/p/img.png',
      mime: 'image/png',
      size: 1024,
    });
  });

  it('applyFileResult sets selectedFile to too_large', () => {
    const msg: ServerFileResultMsg = {
      type: 'file_result',
      kind: 'too_large',
      path: '/p/huge.txt',
      size: 1e9,
    };
    useFileExplorerStore.getState().applyFileResult(msg);
    expect(useFileExplorerStore.getState().selectedFile).toEqual({
      state: 'too_large',
      path: '/p/huge.txt',
      size: 1e9,
    });
  });

  it('reset clears all state', () => {
    useFileExplorerStore.setState({
      dirs: { '/p': [] },
      expanded: { '/p': true },
      loadingPaths: { '/p': true },
      selectedFile: {
        state: 'text',
        path: '/p/a',
        content: '',
        bytesRead: 0,
        truncated: false,
        hash: 'h0',
      },
    });
    useFileExplorerStore.getState().reset();
    const s = useFileExplorerStore.getState();
    expect(s.dirs).toEqual({});
    expect(s.expanded).toEqual({});
    expect(s.loadingPaths).toEqual({});
    expect(s.selectedFile).toBeNull();
  });

  it('refreshOpen clears entries for every expanded path and re-requests them', () => {
    const send = vi.fn();
    const client = { send };
    useFileExplorerStore.setState({
      dirs: {
        '/p': [{ name: 'src', kind: 'dir' }],
        '/p/src': [{ name: 'index.ts', kind: 'file', size: 10 }],
      },
      expanded: { '/p': true, '/p/src': true },
      loadingPaths: {},
      selectedFile: null,
    });
    useFileExplorerStore.getState().refreshOpen(client as unknown as { send: (m: unknown) => void });

    const s = useFileExplorerStore.getState();
    // Cached entries for both expanded paths cleared:
    expect(s.dirs['/p']).toBeUndefined();
    expect(s.dirs['/p/src']).toBeUndefined();
    expect(s.loadingPaths['/p']).toBe(true);
    expect(s.loadingPaths['/p/src']).toBe(true);
    // Two list_dirs sends:
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((c) => (c[0] as { path: string }).path).sort()).toEqual(['/p', '/p/src']);
  });
});

describe('file-explorer editor state', () => {
  it('setDirty flips the flag and is a no-op when unchanged', () => {
    const s = useFileExplorerStore.getState();
    s.setDirty(true);
    const afterFirst = useFileExplorerStore.getState().editor;
    expect(afterFirst.dirty).toBe(true);

    useFileExplorerStore.getState().setDirty(true);
    // Same object identity: no needless re-render for subscribers.
    expect(useFileExplorerStore.getState().editor).toBe(afterFirst);
  });

  it('saveFile sends write_file with the loaded hash and marks saving', () => {
    seedTextFile('/p/a.ts', 'v1', 'h1');
    const { send, sent } = makeClient();
    useFileExplorerStore.getState().saveFile({ send }, 'v2');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'write_file',
      path: '/p/a.ts',
      content: 'v2',
      baseHash: 'h1',
    });
    const s = useFileExplorerStore.getState();
    expect(s.editor.saving).toBe(true);
    expect(s.pendingWriteId).toBe((sent[0] as { correlationId: string }).correlationId);
  });

  it('saveFile with force omits baseHash', () => {
    seedTextFile();
    const { send, sent } = makeClient();
    useFileExplorerStore.getState().saveFile({ send }, 'v2', { force: true });
    expect(sent[0]).not.toHaveProperty('baseHash');
  });

  it('saveFile does nothing without a loaded text file', () => {
    const { send } = makeClient();
    useFileExplorerStore.getState().saveFile({ send }, 'v2');
    expect(send).not.toHaveBeenCalled();

    useFileExplorerStore.setState({ selectedFile: { state: 'binary', path: '/p/x.png', size: 1 } });
    useFileExplorerStore.getState().saveFile({ send }, 'v2');
    expect(send).not.toHaveBeenCalled();
  });

  it('saveFile refuses to stack a second write while one is in flight', () => {
    seedTextFile();
    const { send } = makeClient();
    useFileExplorerStore.getState().saveFile({ send }, 'v2');
    useFileExplorerStore.getState().saveFile({ send }, 'v3');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('applyFileWritten clears dirty and adopts the new hash', () => {
    seedTextFile('/p/a.ts', 'v1', 'h1');
    const { send, sent } = makeClient();
    useFileExplorerStore.getState().setDirty(true);
    useFileExplorerStore.getState().saveFile({ send }, 'v2');
    const correlationId = (sent[0] as { correlationId: string }).correlationId;

    useFileExplorerStore.getState().applyFileWritten({
      type: 'file_written',
      path: '/p/a.ts',
      bytesWritten: 2,
      hash: 'h2',
      correlationId,
    });

    const s = useFileExplorerStore.getState();
    expect(s.editor).toEqual({ dirty: false, saving: false, error: null, conflict: false });
    expect(s.pendingWriteId).toBeNull();
    expect(s.selectedFile).toMatchObject({ hash: 'h2', bytesRead: 2 });
  });

  it('applyFileWritten ignores a result for a superseded write', () => {
    seedTextFile('/p/a.ts', 'v1', 'h1');
    const { send } = makeClient();
    useFileExplorerStore.getState().saveFile({ send }, 'v2');

    useFileExplorerStore.getState().applyFileWritten({
      type: 'file_written',
      path: '/p/a.ts',
      bytesWritten: 9,
      hash: 'stale',
      correlationId: 'some-other-id',
    });

    const s = useFileExplorerStore.getState();
    expect(s.editor.saving).toBe(true);
    expect(s.selectedFile).toMatchObject({ hash: 'h1' });
  });

  it('applyServerError claims a conflict for the in-flight write', () => {
    seedTextFile();
    const { send, sent } = makeClient();
    useFileExplorerStore.getState().saveFile({ send }, 'v2');
    const correlationId = (sent[0] as { correlationId: string }).correlationId;

    const err: ServerErrorMsg = {
      type: 'error',
      code: 'file_conflict',
      message: 'changed on disk',
      correlationId,
    };
    expect(useFileExplorerStore.getState().applyServerError(err)).toBe(true);

    const s = useFileExplorerStore.getState();
    expect(s.editor.saving).toBe(false);
    expect(s.editor.conflict).toBe(true);
    expect(s.editor.error).toMatch(/changed on disk/i);
    expect(s.pendingWriteId).toBeNull();
  });

  it('applyServerError leaves unrelated errors to the shell', () => {
    seedTextFile();
    const { send, sent } = makeClient();
    useFileExplorerStore.getState().saveFile({ send }, 'v2');

    const unrelated: ServerErrorMsg = {
      type: 'error',
      code: 'session_dead',
      message: 'gone',
      correlationId: 'other',
    };
    expect(useFileExplorerStore.getState().applyServerError(unrelated)).toBe(false);
    expect(useFileExplorerStore.getState().editor.saving).toBe(true);

    // And an error arriving with no write in flight at all.
    useFileExplorerStore.setState({ pendingWriteId: null });
    expect(
      useFileExplorerStore.getState().applyServerError({
        type: 'error',
        code: 'file_write_failed',
        message: 'nope',
        correlationId: (sent[0] as { correlationId: string }).correlationId,
      }),
    ).toBe(false);
  });

  it('surfaces a readable message for each write failure code', () => {
    for (const code of ['file_too_large', 'file_write_failed', 'path_denied'] as const) {
      seedTextFile();
      useFileExplorerStore.setState({ pendingWriteId: null });
      const { send, sent } = makeClient();
      useFileExplorerStore.getState().saveFile({ send }, 'v2');
      useFileExplorerStore.getState().applyServerError({
        type: 'error',
        code,
        message: 'raw',
        correlationId: (sent[0] as { correlationId: string }).correlationId,
      });
      const { error, conflict } = useFileExplorerStore.getState().editor;
      expect(error).toBeTruthy();
      expect(error).not.toContain('raw');
      expect(conflict).toBe(false);
    }
  });

  it('falls back to the raw code for an unmapped error', () => {
    seedTextFile();
    const { send, sent } = makeClient();
    useFileExplorerStore.getState().saveFile({ send }, 'v2');
    useFileExplorerStore.getState().applyServerError({
      type: 'error',
      code: 'unsupported_message',
      message: 'weird',
      correlationId: (sent[0] as { correlationId: string }).correlationId,
    });
    expect(useFileExplorerStore.getState().editor.error).toBe('unsupported_message: weird');
  });

  it('clearEditorError drops the error and the conflict flag', () => {
    useFileExplorerStore.setState({
      editor: { dirty: true, saving: false, error: 'boom', conflict: true },
    });
    useFileExplorerStore.getState().clearEditorError();
    const { editor } = useFileExplorerStore.getState();
    expect(editor).toEqual({ dirty: true, saving: false, error: null, conflict: false });
  });

  it('selecting another file abandons the previous editor state', () => {
    useFileExplorerStore.setState({
      editor: { dirty: true, saving: true, error: 'boom', conflict: true },
      pendingWriteId: 'x',
    });
    const { send } = makeClient();
    useFileExplorerStore.getState().requestFile({ send }, '/p/b.ts');
    const s = useFileExplorerStore.getState();
    expect(s.editor).toEqual({ dirty: false, saving: false, error: null, conflict: false });
    expect(s.pendingWriteId).toBeNull();
  });

  it('applyFileResult resets editor state for the newly-loaded file', () => {
    useFileExplorerStore.setState({
      editor: { dirty: true, saving: true, error: 'boom', conflict: true },
    });
    const msg: ServerFileResultMsg = {
      type: 'file_result',
      kind: 'text',
      path: '/p/a.ts',
      content: 'fresh',
      bytesRead: 5,
      truncated: false,
      hash: 'h9',
    };
    useFileExplorerStore.getState().applyFileResult(msg);
    expect(useFileExplorerStore.getState().editor).toEqual({
      dirty: false,
      saving: false,
      error: null,
      conflict: false,
    });
  });
});
