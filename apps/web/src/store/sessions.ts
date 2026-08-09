import { create } from 'zustand';
import type { AgentKind, HistoryEntry, ServerLifecycleMsg, ServerMsg, ServerStreamMsg } from '../types/protocol';
import { getBridgeClient } from '../services/bridge-client-singleton';

// correlationId → resolver/rejecter for in-flight resume requests.
// Lives at module scope (not store state) because Zustand state must remain
// JSON-serializable for replay/devtools — promise resolvers are not.
const pendingResumes = new Map<
  string,
  {
    resolve: (webSessionId: string) => void;
    reject: (err: { code: string; message: string }) => void;
  }
>();

// correlationId → resolver/rejecter for in-flight rename requests.
const pendingRenames = new Map<
  string,
  {
    resolve: () => void;
    reject: (err: { code: string; message: string }) => void;
  }
>();

function newResumeCorrelationId(): string {
  return `resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export type SessionEvent = (ServerLifecycleMsg | ServerStreamMsg) & {
  /**
   * Web-store-only flag. Set on stream_delta events whose contents have been
   * superseded by a consolidated `assistant` event with text payload. The
   * transcript projection skips them. NEVER carried on the wire — the store
   * sets/clears it locally; replay re-derives it from order.
   */
  superseded?: true;
  /**
   * Web-store-only arrival timestamp (ms). Set on live events so the
   * transcript can compute tool-call durations; absent on replayed history,
   * which the projection treats as "no duration known".
   */
  receivedAt?: number;
};

function applySupersessionWalk(events: SessionEvent[]): SessionEvent[] {
  // Single SSOT for the supersession derivation. Order-only and idempotent:
  // for each `assistant` with a non-empty text payload, walk backwards until
  // any non-`stream_delta` boundary, flagging stream_delta events as
  // `superseded: true`. Already-flagged events are not re-allocated.
  // Used by BOTH the live `assistant` append path and the `history` bulk-merge
  // (replay) path so reload-replay reaches the same superseded set as live.
  //
  // The walk stops at anything from a different speaker. Subagent output rides
  // the same stream, so without that check a subagent's completed message
  // would retire the main agent's still-streaming deltas — and the prose the
  // user was watching would vanish mid-sentence.
  let out: SessionEvent[] | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type !== 'assistant') continue;
    const text = (e.payload as { text?: unknown }).text;
    if (typeof text !== 'string' || text.length === 0) continue;
    const speaker = e.parentToolUseId;
    for (let j = i - 1; j >= 0; j--) {
      const prev = (out ?? events)[j]!;
      if (prev.type !== 'stream_delta' || prev.parentToolUseId !== speaker) break;
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
  name?: string | null;
}

interface SessionsStore {
  sessions: Record<string, SessionView>;
  order: string[];
  activeId: string | null;
  transcriptOnly: Record<string, boolean>;
  /**
   * Names heard for sessions this store has no view for yet.
   *
   * Renaming happens on the board, which keeps its own card list; this store
   * only holds sessions the user has actually opened. Without somewhere to park
   * the name, a board rename was dropped on the floor and the session page
   * still showed the old name (or an id stub) when you finally opened it.
   */
  pendingNames: Record<string, string>;

  applyServerMsg(m: ServerMsg): void;
  setActive(id: string): void;
  markTranscriptOnly(id: string): void;
  /**
   * Resume a known web session via the bridge's registry lookup. Sends a
   * `resume_session` with `webSessionId`; resolves on the matching
   * `session_resumed` reply with the (possibly new) webSessionId.
   */
  resume(webSessionId: string): Promise<string>;
  /**
   * Resume from a native CLI history entry. Sends `resume_session` with
   * agent + sessionId + projectPath; bridge mints a fresh webSessionId and
   * the returned promise resolves with it on the matching reply.
   */
  resumeFromHistory(entry: HistoryEntry): Promise<string>;
  /**
   * Rename a session. Sends `rename_session`; resolves on the matching
   * `session_renamed` reply, rejects on `error` with the same correlationId.
   */
  renameSession(sessionId: string, name: string): Promise<void>;
  /**
   * Stop the turn in flight, leaving the session alive.
   *
   * Distinct from `stop_session`, which ends the session. Fire-and-forget: the
   * transcript's own `result` event is the confirmation, and a session that has
   * already finished its turn simply has nothing to interrupt.
   */
  interruptSession(sessionId: string): void;
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  sessions: {},
  order: [],
  activeId: null,
  transcriptOnly: {},
  pendingNames: {},

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
        // Carry the name across. `session_created` has no `name` on the wire,
        // and opening a session replays this event from the bridge's buffer —
        // so rebuilding the view from scratch used to wipe a name that had
        // already arrived via `session_list` or `session_renamed`, and the
        // header fell back to a session-id stub while the board still showed
        // the real name.
        ...(existing?.name !== undefined
          ? { name: existing.name }
          : get().pendingNames[m.sessionId] !== undefined
            ? { name: get().pendingNames[m.sessionId]! }
            : {}),
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
      // Stamp arrival time so the transcript can time tool calls. The wire
      // carries no timestamps, so this is only available for events seen live;
      // replayed history simply shows no duration rather than a wrong one.
      let nextEvents: SessionEvent[] = [
        ...exists.events,
        { ...m, receivedAt: Date.now() } as SessionEvent,
      ];
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
        // The bridge now joins `name` from its registry. Take it whenever it
        // is present — on a fresh page load there is no `existing` to keep it
        // alive, and `session_renamed` only fires on change, so before this
        // the name was silently lost on every reload.
        sessions[summary.sessionId] = existing
          ? summary.name !== undefined
            ? { ...existing, name: summary.name }
            : existing
          : {
              sessionId: summary.sessionId,
              agent: summary.agent,
              projectPath: summary.projectPath,
              createdAt: summary.createdAt,
              events: [],
              lastSeq: 0,
              alive: true,
              ...(summary.account !== undefined ? { account: summary.account } : {}),
              ...(summary.name !== undefined ? { name: summary.name } : {}),
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

    if (m.type === 'session_renamed') {
      const existing = get().sessions[m.sessionId];
      if (existing) {
        set((s) => ({
          sessions: { ...s.sessions, [m.sessionId]: { ...existing, name: m.name } },
        }));
      } else {
        // Not opened in this tab yet — park it so opening the session later
        // shows the new name instead of a stale one.
        set((s) => ({ pendingNames: { ...s.pendingNames, [m.sessionId]: m.name } }));
      }
      // Resolve the pending promise only when correlationId matches an in-flight rename.
      // Bridge auto-name broadcasts use correlationId: '' and will NOT match any entry.
      const pending = pendingRenames.get(m.correlationId);
      if (pending) {
        pendingRenames.delete(m.correlationId);
        pending.resolve();
      }
      return;
    }

    if (m.type === 'session_resumed') {
      // Defensive sidebar slot: reserve a place in `order` even if the
      // accompanying session_created broadcast hasn't been applied yet (e.g.,
      // backgrounded tab, message-queue race). Once session_created lands it
      // populates sessions[webSessionId] and the existing slot stays put.
      // Without this push the user had to refresh to see freshly-resumed
      // sessions in the sidebar.
      set((s) => {
        const existing = s.sessions[m.webSessionId];
        const orderHasIt = s.order.includes(m.webSessionId);
        // Always clear transcriptOnly on resume — otherwise `inputDisabled`
        // stays latched true and the chat input remains disabled even though
        // the session is now live.
        const transcriptOnly = s.transcriptOnly[m.webSessionId]
          ? { ...s.transcriptOnly, [m.webSessionId]: false }
          : s.transcriptOnly;
        if (!existing && orderHasIt) return { transcriptOnly };
        if (!existing && !orderHasIt) {
          return { order: [...s.order, m.webSessionId], transcriptOnly };
        }
        return {
          sessions: { ...s.sessions, [m.webSessionId]: { ...existing!, alive: true } },
          order: orderHasIt ? s.order : [...s.order, m.webSessionId],
          transcriptOnly,
        };
      });
      const pending = pendingResumes.get(m.correlationId);
      if (pending) {
        pendingResumes.delete(m.correlationId);
        pending.resolve(m.webSessionId);
      }
      return;
    }

    if (m.type === 'error') {
      // Per-session: session_dead flips alive=false on the matching session
      // so <ResumePrompt /> renders. The global error banner is suppressed
      // for this code in App.tsx; other error codes still bubble up there.
      if (m.code === 'session_dead' && m.sessionId) {
        const existing = get().sessions[m.sessionId];
        if (existing) {
          set((s) => ({
            sessions: {
              ...s.sessions,
              [m.sessionId!]: { ...existing, alive: false },
            },
          }));
        }
      }
      // Reject any in-flight resume promise keyed to this correlationId so
      // callers (HistoryPanel / InputBox) can surface the failure.
      if (m.correlationId && pendingResumes.has(m.correlationId)) {
        const pending = pendingResumes.get(m.correlationId)!;
        pendingResumes.delete(m.correlationId);
        pending.reject({ code: m.code, message: m.message });
      }
      // Reject any in-flight rename promise keyed to this correlationId.
      if (m.correlationId && pendingRenames.has(m.correlationId)) {
        const pending = pendingRenames.get(m.correlationId)!;
        pendingRenames.delete(m.correlationId);
        pending.reject({ code: m.code, message: m.message });
      }
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

  async resume(webSessionId: string): Promise<string> {
    const correlationId = newResumeCorrelationId();
    const promise = new Promise<string>((resolve, reject) => {
      pendingResumes.set(correlationId, { resolve, reject });
    });
    getBridgeClient().send({
      type: 'resume_session',
      webSessionId,
      correlationId,
    });
    return promise;
  },

  async resumeFromHistory(entry: HistoryEntry): Promise<string> {
    const correlationId = newResumeCorrelationId();
    const promise = new Promise<string>((resolve, reject) => {
      pendingResumes.set(correlationId, { resolve, reject });
    });
    getBridgeClient().send({
      type: 'resume_session',
      agent: entry.agent,
      sessionId: entry.sessionId,
      projectPath: entry.projectPath,
      correlationId,
    });
    return promise;
  },

  interruptSession(sessionId) {
    getBridgeClient().send({ type: 'interrupt_session', sessionId });
  },

  async renameSession(sessionId: string, name: string): Promise<void> {
    const correlationId = `rename-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve, reject) => {
      pendingRenames.set(correlationId, { resolve, reject });
      getBridgeClient().send({ type: 'rename_session', sessionId, name, correlationId });
    });
  },
}));
