import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useFileSearchStore } from './fileSearchStore';
import type { SearchHit } from '../../types/protocol';

vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: vi.fn(),
}));

import { getBridgeClient } from '../../services/bridge-client-singleton';

const mkHit = (over: Partial<SearchHit> = {}): SearchHit => ({
  insertText: '@src/foo.ts',
  fullPath: '/Users/me/repo/src/foo.ts',
  dirIndex: 0,
  mtime: 1,
  ...over,
});

describe('fileSearchStore', () => {
  beforeEach(() => {
    useFileSearchStore.setState({ bySession: {} });
    vi.clearAllMocks();
  });

  it('search() sends search_files with sessionId + query', () => {
    const sent: unknown[] = [];
    const send = vi.fn((m: unknown) => sent.push(m));
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });

    useFileSearchStore.getState().search('sess-1', 'foo');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'search_files',
        sessionId: 'sess-1',
        query: 'foo',
        correlationId: expect.any(String),
      }),
    );
  });

  it('applyServerMsg file_search_results stores hits + truncated + query under sessionId', () => {
    const sent: unknown[] = [];
    const send = vi.fn((m: unknown) => sent.push(m));
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });

    useFileSearchStore.getState().search('sess-1', 'foo');
    const cid = (sent[0] as { correlationId: string }).correlationId;

    const hits = [mkHit(), mkHit({ insertText: '@src/bar.ts' })];
    useFileSearchStore.getState().applyServerMsg({
      type: 'file_search_results',
      hits,
      truncated: true,
      correlationId: cid,
    });

    const entry = useFileSearchStore.getState().bySession['sess-1'];
    expect(entry?.hits).toEqual(hits);
    expect(entry?.truncated).toBe(true);
    expect(entry?.query).toBe('foo');
  });

  it('two concurrent searches resolve to their own sessions', () => {
    const sent: unknown[] = [];
    const send = vi.fn((m: unknown) => sent.push(m));
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });

    useFileSearchStore.getState().search('sess-1', 'a');
    useFileSearchStore.getState().search('sess-2', 'b');
    const cid1 = (sent[0] as { correlationId: string }).correlationId;
    const cid2 = (sent[1] as { correlationId: string }).correlationId;

    useFileSearchStore.getState().applyServerMsg({
      type: 'file_search_results',
      hits: [mkHit({ insertText: '@x' })],
      truncated: false,
      correlationId: cid2,
    });
    useFileSearchStore.getState().applyServerMsg({
      type: 'file_search_results',
      hits: [mkHit({ insertText: '@y' })],
      truncated: false,
      correlationId: cid1,
    });

    const s = useFileSearchStore.getState().bySession;
    expect(s['sess-1']?.query).toBe('a');
    expect(s['sess-1']?.hits[0]?.insertText).toBe('@y');
    expect(s['sess-2']?.query).toBe('b');
    expect(s['sess-2']?.hits[0]?.insertText).toBe('@x');
  });

  it('applyServerMsg with unknown correlationId is a no-op', () => {
    useFileSearchStore.getState().applyServerMsg({
      type: 'file_search_results',
      hits: [mkHit()],
      truncated: false,
      correlationId: 'nope',
    });
    expect(useFileSearchStore.getState().bySession).toEqual({});
  });
});
