import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useHistoryStore } from './historyStore';
import type { HistoryEntry } from '../../types/protocol';

vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: vi.fn(),
}));

import { getBridgeClient } from '../../services/bridge-client-singleton';

describe('historyStore', () => {
  beforeEach(() => {
    useHistoryStore.setState({
      claude: [],
      codex: [],
      loading: false,
      lastFetched: 0,
    });
    vi.clearAllMocks();
  });

  it('fetch() sends list_history over WS', async () => {
    const send = vi.fn();
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });
    useHistoryStore.getState().fetch();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'list_history' }));
    expect(useHistoryStore.getState().loading).toBe(true);
  });

  it('60s dedupe: second fetch within window does NOT re-send', async () => {
    const send = vi.fn();
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });
    useHistoryStore.setState({ lastFetched: Date.now(), loading: false });
    useHistoryStore.getState().fetch();
    expect(send).not.toHaveBeenCalled();
  });

  it('applyServerMsg history_list populates lists and clears loading', () => {
    const claude: HistoryEntry[] = [{
      agent: 'claude', sessionId: 'a', projectPath: '/p', mtime: 1, firstPrompt: 'hi',
    }];
    const codex: HistoryEntry[] = [];
    useHistoryStore.setState({ loading: true });
    useHistoryStore.getState().applyServerMsg({
      type: 'history_list',
      claude,
      codex,
      correlationId: 'x',
    });
    const s = useHistoryStore.getState();
    expect(s.claude).toEqual(claude);
    expect(s.codex).toEqual(codex);
    expect(s.loading).toBe(false);
    expect(s.lastFetched).toBeGreaterThan(0);
  });

  it('invalidate() resets lastFetched so next fetch goes through', () => {
    useHistoryStore.setState({ lastFetched: Date.now() });
    useHistoryStore.getState().invalidate();
    expect(useHistoryStore.getState().lastFetched).toBe(0);
  });
});
