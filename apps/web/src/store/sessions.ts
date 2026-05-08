import { create } from 'zustand';
import type { AgentKind, ServerLifecycleMsg, ServerMsg, ServerStreamMsg } from '../types/protocol';

export type SessionEvent = (ServerLifecycleMsg | ServerStreamMsg) & {
  /**
   * Web-store-only flag. Set on stream_delta events whose contents have been
   * superseded by a consolidated `assistant` event with text payload.
   * MessageBubble early-returns null for these. NEVER carried on the wire —
   * the store sets/clears it locally; replay re-derives it from order.
   */
  superseded?: true;
};

function applySupersessionWalk(events: SessionEvent[]): SessionEvent[] {
  // Single SSOT for the supersession derivation. Order-only and idempotent:
  // for each `assistant` with a non-empty text payload, walk backwards until
  // any non-`stream_delta` boundary, flagging stream_delta events as
  // `superseded: true`. Already-flagged events are not re-allocated.
  // Used by BOTH the live `assistant` append path and the `history` bulk-merge
  // (replay) path so reload-replay reaches the same superseded set as live.
  let out: SessionEvent[] | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type !== 'assistant') continue;
    const text = (e.payload as { text?: unknown }).text;
    if (typeof text !== 'string' || text.length === 0) continue;
    for (let j = i - 1; j >= 0; j--) {
      const prev = (out ?? events)[j]!;
      if (prev.type !== 'stream_delta') break;
      if (prev.superseded) continue;
      if (out === null) out = events.slice();
      out[j] = { ...prev, superseded: true };
    }
  }
  return out ?? events;
}

export interface SessionView {
  sessionId: string;
  agent: AgentKind;
  projectPath: string;
  createdAt: number;
  events: SessionEvent[];
  lastSeq: number;
  alive: boolean;
  account?: string;
}

interface SessionsStore {
  sessions: Record<string, SessionView>;
  order: string[];
  activeId: string | null;
  transcriptOnly: Record<string, boolean>;

  applyServerMsg(m: ServerMsg): void;
  setActive(id: string): void;
  markTranscriptOnly(id: string): void;
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  sessions: {},
  order: [],
  activeId: null,
  transcriptOnly: {},

  applyServerMsg(m) {
    if (m.type === 'system' && m.event === 'init') return;

    if (m.type === 'system' && m.event === 'session_created') {
      const existing = get().sessions[m.sessionId];
      const resolvedAccount = m.account ?? existing?.account;
      const view: SessionView = {
        sessionId: m.sessionId,
        agent: m.agent ?? existing?.agent ?? 'claude',
        projectPath: m.projectPath ?? existing?.projectPath ?? '',
        createdAt: m.createdAt ?? existing?.createdAt ?? Date.now(),
        events: [...(existing?.events ?? []), m],
        lastSeq: m.seq,
        alive: true,
        ...(resolvedAccount !== undefined ? { account: resolvedAccount } : {}),
      };
      const isTranscriptOnly = Boolean(get().transcriptOnly[m.sessionId]);
      set((s) => ({
        sessions: { ...s.sessions, [m.sessionId]: view },
        // Live sessions get added to the sidebar; transcript-only replays
        // hydrate events into the store but stay OFF the sidebar.
        order: isTranscriptOnly
          ? s.order
          : s.order.includes(m.sessionId)
            ? s.order
            : [...s.order, m.sessionId],
      }));
      return;
    }

    if (m.type === 'system' && m.event === 'session_ended') {
      const exists = get().sessions[m.sessionId];
      if (!exists) return;
      const next: SessionView = {
        ...exists,
        events: [...exists.events, m],
        lastSeq: m.seq,
        alive: false,
      };
      set((s) => ({ sessions: { ...s.sessions, [m.sessionId]: next } }));
      return;
    }

    if (
      m.type === 'assistant' ||
      m.type === 'stream_delta' ||
      m.type === 'tool_result' ||
      m.type === 'result' ||
      m.type === 'status' ||
      m.type === 'user'
    ) {
      const exists = get().sessions[m.sessionId];
      if (!exists) return;
      let nextEvents: SessionEvent[] = [...exists.events, m as SessionEvent];
      // Only the `assistant` append can introduce a new supersession boundary —
      // skip the walk on every other event type for performance.
      if (m.type === 'assistant') {
        nextEvents = applySupersessionWalk(nextEvents);
      }
      const next: SessionView = {
        ...exists,
        events: nextEvents,
        lastSeq: m.seq,
      };
      set((s) => ({ sessions: { ...s.sessions, [m.sessionId]: next } }));
      return;
    }

    if (m.type === 'session_list') {
      const sessions: Record<string, SessionView> = {};
      const order: string[] = [];
      for (const summary of m.sessions) {
        const existing = get().sessions[summary.sessionId];
        sessions[summary.sessionId] = existing ?? {
          sessionId: summary.sessionId,
          agent: summary.agent,
          projectPath: summary.projectPath,
          createdAt: summary.createdAt,
          events: [],
          lastSeq: 0,
          alive: true,
          ...(summary.account !== undefined ? { account: summary.account } : {}),
        };
        order.push(summary.sessionId);
      }
      set({ sessions, order });
      return;
    }

    if (m.type === 'history') {
      const existing = get().sessions[m.sessionId];
      if (!existing) return;
      // No-op guard: if every replayed seq is already known, do not write
      // a new state object. Without this, opening a session that asks for
      // history on every render would loop (history → state write → render
      // → another get_history → another history reply).
      if (m.events.length === 0) return;
      const knownSeqs = new Set<number>();
      for (const e of existing.events) {
        const seq = (e as { seq?: number }).seq;
        if (typeof seq === 'number') knownSeqs.add(seq);
      }
      const novel = m.events.filter((e) => !knownSeqs.has(e.seq));
      if (novel.length === 0) return;

      const bySeq = new Map<number, SessionEvent>();
      for (const e of existing.events) {
        const seq = (e as { seq?: number }).seq;
        if (typeof seq === 'number') bySeq.set(seq, e);
      }
      for (const e of novel) bySeq.set(e.seq, e);
      const merged = [...bySeq.values()].sort(
        (a, b) => (a as { seq: number }).seq - (b as { seq: number }).seq,
      );
      // Re-derive supersession flags on the merged array. The walk is purely
      // additive and order-only — replay reaches the same flag set as live.
      const mergedWithFlags = applySupersessionWalk(merged);
      const lastSeq =
        mergedWithFlags.length > 0
          ? (mergedWithFlags[mergedWithFlags.length - 1] as { seq: number }).seq
          : existing.lastSeq;
      const next: SessionView = { ...existing, events: mergedWithFlags, lastSeq };
      set((s) => ({ sessions: { ...s.sessions, [m.sessionId]: next } }));
      return;
    }

    if (m.type === 'error') {
      // Bridge error messages are surfaced via the connection store
      // (App routes them there) so the UI can display them. The sessions
      // store ignores them — they are not session-scoped events.
      return;
    }
  },

  setActive(id) {
    if (!get().sessions[id]) return;
    set({ activeId: id });
  },

  markTranscriptOnly(id) {
    set((s) => ({ transcriptOnly: { ...s.transcriptOnly, [id]: true } }));
  },
}));
