import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useFileExplorerStore } from './file-explorer';
import type { ServerDirsResultMsg, ServerFileResultMsg } from '../types/protocol';

beforeEach(() => {
  useFileExplorerStore.setState({
    dirs: {},
    expanded: {},
    loadingPaths: {},
    selectedFile: null,
  });
});

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
    };
    useFileExplorerStore.getState().applyFileResult(msg);
    expect(useFileExplorerStore.getState().selectedFile).toEqual({
      state: 'text',
      path: '/p/file.txt',
      content: 'hello',
      bytesRead: 5,
      truncated: false,
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
      selectedFile: { state: 'text', path: '/p/a', content: '', bytesRead: 0, truncated: false },
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
