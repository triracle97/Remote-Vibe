import { create } from 'zustand';
import type { HistoryEntry, ServerMsg } from '../../types/protocol';
import { getBridgeClient } from '../../services/bridge-client-singleton';

const CACHE_TTL_MS = 60_000;

interface HistoryState {
  claude: HistoryEntry[];
  codex: HistoryEntry[];
  loading: boolean;
  lastFetched: number;
  fetch: () => void;
  invalidate: () => void;
  applyServerMsg: (m: ServerMsg) => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  claude: [],
  codex: [],
  loading: false,
  lastFetched: 0,

  fetch() {
    const s = get();
    if (s.loading) return;
    if (Date.now() - s.lastFetched < CACHE_TTL_MS) return;
    set({ loading: true });
    const correlationId = `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    getBridgeClient().send({ type: 'list_history', correlationId });
  },

  invalidate() {
    set({ lastFetched: 0 });
  },

  applyServerMsg(m: ServerMsg) {
    if (m.type === 'history_list') {
      set({
        claude: m.claude,
        codex: m.codex,
        loading: false,
        lastFetched: Date.now(),
      });
    }
  },
}));
