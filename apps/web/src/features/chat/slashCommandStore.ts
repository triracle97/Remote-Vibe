import { create } from 'zustand';
import type { SlashCommand, ServerMsg } from '../../types/protocol';
import { getBridgeClient } from '../../services/bridge-client-singleton';

const CACHE_TTL_MS = 60_000;

// correlationId → sessionId for in-flight list_slash_commands requests.
// Module-scope (not zustand state) so we don't bloat the persistable view.
const pendingBySession = new Map<string, string>();

interface SlashCommandState {
  bySession: Record<string, { commands: SlashCommand[]; lastFetched: number }>;
  fetch: (sessionId: string) => void;
  applyServerMsg: (m: ServerMsg) => void;
}

export const useSlashCommandStore = create<SlashCommandState>((set, get) => ({
  bySession: {},

  fetch(sessionId: string) {
    const existing = get().bySession[sessionId];
    if (existing && Date.now() - existing.lastFetched < CACHE_TTL_MS) return;
    const correlationId = `sc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingBySession.set(correlationId, sessionId);
    getBridgeClient().send({ type: 'list_slash_commands', sessionId, correlationId });
  },

  applyServerMsg(m: ServerMsg) {
    if (m.type === 'slash_commands_list') {
      const sessionId = pendingBySession.get(m.correlationId);
      pendingBySession.delete(m.correlationId);
      if (sessionId === undefined) return;
      set({
        bySession: {
          ...get().bySession,
          [sessionId]: { commands: m.commands, lastFetched: Date.now() },
        },
      });
    }
  },
}));
