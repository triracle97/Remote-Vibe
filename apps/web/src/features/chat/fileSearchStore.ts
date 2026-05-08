import { create } from 'zustand';
import type { SearchHit, ServerMsg } from '../../types/protocol';
import { getBridgeClient } from '../../services/bridge-client-singleton';

// correlationId → {sessionId, query} for in-flight search_files requests.
// Module-scope (not zustand state) so non-serializable in-flight metadata
// doesn't pollute the persistable view.
const pendingBySession = new Map<string, { sessionId: string; query: string }>();

interface FileSearchState {
  bySession: Record<string, { hits: SearchHit[]; truncated: boolean; query: string }>;
  search: (sessionId: string, query: string) => void;
  applyServerMsg: (m: ServerMsg) => void;
}

export const useFileSearchStore = create<FileSearchState>((set, get) => ({
  bySession: {},

  search(sessionId: string, query: string) {
    const correlationId = `fs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingBySession.set(correlationId, { sessionId, query });
    getBridgeClient().send({ type: 'search_files', sessionId, query, correlationId });
  },

  applyServerMsg(m: ServerMsg) {
    if (m.type === 'file_search_results') {
      const ctx = pendingBySession.get(m.correlationId);
      pendingBySession.delete(m.correlationId);
      if (!ctx) return;
      set({
        bySession: {
          ...get().bySession,
          [ctx.sessionId]: { hits: m.hits, truncated: m.truncated, query: ctx.query },
        },
      });
    }
  },
}));
