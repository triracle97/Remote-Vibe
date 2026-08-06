import { create } from 'zustand';
import { getBridgeClient } from '../../services/bridge-client-singleton';
import type { BoardSession, ServerMsg, SessionPhase } from '../../types/protocol';

/**
 * Board state.
 *
 * Hydrated from `all_sessions` (the bridge registry, which spans dead
 * sessions), then patched in place by the ordinary live broadcasts so a card
 * turns green the moment its session starts producing output.
 *
 * Mutations are optimistic: the card moves immediately and rolls back if the
 * bridge rejects it. Success needs no reply — the bridge broadcasts the change
 * to every client, including this one.
 */

export interface BoardFilter {
  search: string;
  /** Cards must carry every selected tag. */
  tags: string[];
  showDone: boolean;
  showArchived: boolean;
}

const DEFAULT_FILTER: BoardFilter = {
  search: '',
  tags: [],
  showDone: true,
  showArchived: false,
};

interface BoardState {
  cards: Record<string, BoardSession>;
  loaded: boolean;
  filter: BoardFilter;
  /** Last mutation error, surfaced as a dismissible banner. */
  error: string | null;

  applyServerMsg: (m: ServerMsg) => void;
  refresh: () => void;
  setFilter: (patch: Partial<BoardFilter>) => void;
  toggleTag: (tag: string) => void;
  setPhase: (sessionId: string, phase: SessionPhase) => void;
  setTags: (sessionId: string, tags: string[]) => void;
  setArchived: (sessionId: string, archived: boolean) => void;
  /**
   * Archive every visible card sitting in `phase`, and report how many.
   *
   * Archive rather than delete: it clears the column but keeps the transcript
   * and the registry row, and the "show archived" filter plus the card sheet's
   * Unarchive make it a real undo rather than a promise of one.
   */
  archivePhase: (phase: SessionPhase) => number;
  remove: (sessionId: string) => void;
  clearError: () => void;
}

/**
 * Correlation ids for in-flight mutations, so a rejection can roll the right
 * card back. Module scope rather than store state: these are transport
 * bookkeeping, and nothing renders from them.
 *
 * `undo` takes the *current* card, which may be undefined — a failed delete has
 * to put a whole row back, not patch one that is no longer there.
 */
const pending = new Map<
  string,
  { sessionId: string; undo: (c: BoardSession | undefined) => BoardSession }
>();

let correlationCounter = 0;
function nextCorrelationId(kind: string): string {
  correlationCounter += 1;
  return `board-${kind}-${correlationCounter}`;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  cards: {},
  loaded: false,
  filter: DEFAULT_FILTER,
  error: null,

  applyServerMsg: (m) => {
    switch (m.type) {
      case 'all_sessions': {
        const cards: Record<string, BoardSession> = {};
        for (const s of m.sessions) cards[s.sessionId] = s;
        set({ cards, loaded: true });
        return;
      }
      case 'session_model_changed': {
        patch(set, get, m.sessionId, (c) => ({ ...c, model: m.model, effort: m.effort }));
        return;
      }
      case 'session_phase_changed': {
        if (m.correlationId) pending.delete(m.correlationId);
        patch(set, get, m.sessionId, (c) => ({
          ...c,
          phase: m.phase,
          phasePinned: m.phasePinned,
        }));
        return;
      }
      case 'session_tags_changed': {
        if (m.correlationId) pending.delete(m.correlationId);
        patch(set, get, m.sessionId, (c) => ({ ...c, tags: m.tags }));
        return;
      }
      case 'session_archived': {
        if (m.correlationId) pending.delete(m.correlationId);
        patch(set, get, m.sessionId, (c) => ({ ...c, archived: m.archived }));
        return;
      }
      case 'session_deleted': {
        if (m.correlationId) pending.delete(m.correlationId);
        const cards = { ...get().cards };
        delete cards[m.sessionId];
        set({ cards });
        return;
      }
      case 'session_renamed': {
        patch(set, get, m.sessionId, (c) => ({ ...c, name: m.name }));
        return;
      }
      case 'system': {
        if (m.event === 'session_created') {
          // A brand-new session has no registry row here yet; ask for a fresh
          // snapshot rather than half-inventing a card from the lifecycle msg.
          if (get().cards[m.sessionId] === undefined) {
            get().refresh();
            return;
          }
          patch(set, get, m.sessionId, (c) => ({
            ...c,
            alive: true,
            status: 'live',
            turnRunning: false,
          }));
          return;
        }
        if (m.event === 'session_ended') {
          patch(set, get, m.sessionId, (c) => ({
            ...c,
            alive: false,
            status: 'ended',
            turnRunning: false,
            endedAt: Date.now(),
          }));
        }
        return;
      }
      case 'user': {
        // Opens a turn: the agent is working until a `result` closes it. Same
        // rule the bridge seeds `turnRunning` with, so the card does not flip
        // on the first message after a page load.
        patch(set, get, m.sessionId, (c) => touch(c, true));
        return;
      }
      case 'result': {
        // Closes the turn — the agent is done and the human is up.
        patch(set, get, m.sessionId, (c) => touch(c, false));
        return;
      }
      case 'assistant':
      case 'stream_delta':
      case 'tool_result': {
        // Any traffic is activity. Keeps board ordering fresh without a poll.
        patch(set, get, m.sessionId, (c) => touch(c, c.turnRunning));
        return;
      }
      case 'error': {
        const entry = m.correlationId ? pending.get(m.correlationId) : undefined;
        if (!entry) return;
        pending.delete(m.correlationId!);
        // Roll the optimistic change back, and say why. Assigns directly
        // rather than going through `patch`, so a failed delete can restore a
        // card that is no longer in the map.
        const cards = get().cards;
        set({
          cards: { ...cards, [entry.sessionId]: entry.undo(cards[entry.sessionId]) },
          error: m.message,
        });
        return;
      }
      default:
        return;
    }
  },

  refresh: () => {
    getBridgeClient().send({
      type: 'list_all_sessions',
      includeArchived: get().filter.showArchived,
    });
  },

  setFilter: (patchFilter) => {
    const next = { ...get().filter, ...patchFilter };
    set({ filter: next });
    // Archived cards are not sent unless asked for, so this needs a re-fetch.
    if (patchFilter.showArchived !== undefined) {
      getBridgeClient().send({
        type: 'list_all_sessions',
        includeArchived: next.showArchived,
      });
    }
  },

  toggleTag: (tag) => {
    const { tags } = get().filter;
    set({
      filter: {
        ...get().filter,
        tags: tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag],
      },
    });
  },

  setPhase: (sessionId, phase) => {
    const card = get().cards[sessionId];
    if (!card || card.phase === phase) return;
    const before = { phase: card.phase, phasePinned: card.phasePinned };
    const correlationId = nextCorrelationId('phase');
    pending.set(correlationId, {
      sessionId,
      undo: (c) => ({ ...(c ?? card), ...before }),
    });
    patch(set, get, sessionId, (c) => ({ ...c, phase, phasePinned: true }));
    getBridgeClient().send({ type: 'set_session_phase', sessionId, phase, correlationId });
  },

  setTags: (sessionId, tags) => {
    const card = get().cards[sessionId];
    if (!card) return;
    const before = card.tags;
    const correlationId = nextCorrelationId('tags');
    pending.set(correlationId, { sessionId, undo: (c) => ({ ...(c ?? card), tags: before }) });
    patch(set, get, sessionId, (c) => ({ ...c, tags }));
    getBridgeClient().send({ type: 'set_session_tags', sessionId, tags, correlationId });
  },

  setArchived: (sessionId, archived) => {
    const card = get().cards[sessionId];
    if (!card) return;
    const before = card.archived;
    const correlationId = nextCorrelationId('archive');
    pending.set(correlationId, { sessionId, undo: (c) => ({ ...(c ?? card), archived: before }) });
    patch(set, get, sessionId, (c) => ({ ...c, archived }));
    getBridgeClient().send({ type: 'archive_session', sessionId, archived, correlationId });
  },

  archivePhase: (phase) => {
    const { cards, filter } = get();
    // Only what the user can currently see. Archiving a card hidden behind a
    // tag filter would be a surprise they never asked for and cannot see undone.
    const targets = Object.values(cards).filter(
      (c) => c.phase === phase && !c.archived && matchesFilter(c, filter),
    );
    if (targets.length === 0) return 0;

    const next = { ...get().cards };
    for (const card of targets) {
      const correlationId = nextCorrelationId('archive');
      // Each card rolls back independently: one rejected archive must not undo
      // the others that succeeded.
      pending.set(correlationId, {
        sessionId: card.sessionId,
        undo: (c) => ({ ...(c ?? card), archived: false }),
      });
      next[card.sessionId] = { ...card, archived: true };
      getBridgeClient().send({
        type: 'archive_session',
        sessionId: card.sessionId,
        archived: true,
        correlationId,
      });
    }
    set({ cards: next });
    return targets.length;
  },

  remove: (sessionId) => {
    const card = get().cards[sessionId];
    if (!card) return;
    const correlationId = nextCorrelationId('delete');
    // Deletion can't be undone by patching a card that is gone, so restore the
    // whole row on failure.
    pending.set(correlationId, { sessionId, undo: () => card });
    const cards = { ...get().cards };
    delete cards[sessionId];
    set({ cards });
    getBridgeClient().send({ type: 'delete_session', sessionId, correlationId });
  },

  clearError: () => set({ error: null }),
}));

type SetFn = (partial: Partial<BoardState>) => void;
type GetFn = () => BoardState;

/**
 * Stamp activity on a card and set where the turn stands.
 *
 * Traffic on a card the store thinks is dead revives it: the registry snapshot
 * can be older than the session it describes (spawned by an agent, resumed in
 * another tab), and an event is proof of a live driver.
 */
function touch(c: BoardSession, turnRunning: boolean | undefined): BoardSession {
  const base = c.alive ? c : { ...c, alive: true, status: 'live' as const };
  return { ...base, lastActiveAt: Date.now(), turnRunning: turnRunning === true };
}

/** Apply `fn` to one card, no-op when the card is unknown. */
function patch(
  set: SetFn,
  get: GetFn,
  sessionId: string,
  fn: (c: BoardSession) => BoardSession,
): void {
  const card = get().cards[sessionId];
  if (!card) return;
  const next = fn(card);
  if (next === card) return;
  set({ cards: { ...get().cards, [sessionId]: next } });
}

// --- selectors (pure, exported for testing) ---

export function matchesFilter(card: BoardSession, filter: BoardFilter): boolean {
  if (!filter.showArchived && card.archived) return false;
  if (!filter.showDone && card.phase === 'done') return false;
  if (filter.tags.length > 0 && !filter.tags.every((t) => card.tags.includes(t))) return false;
  const q = filter.search.trim().toLowerCase();
  if (q.length === 0) return true;
  return (
    (card.name ?? '').toLowerCase().includes(q) ||
    card.projectPath.toLowerCase().includes(q) ||
    card.tags.some((t) => t.toLowerCase().includes(q))
  );
}

/**
 * Group filtered cards by phase. Live sessions sort above dead ones within a
 * column — a running session is what you want to click — then by recency.
 */
export function groupByPhase(
  cards: Record<string, BoardSession>,
  filter: BoardFilter,
): Map<SessionPhase, BoardSession[]> {
  const out = new Map<SessionPhase, BoardSession[]>();
  for (const card of Object.values(cards)) {
    if (!matchesFilter(card, filter)) continue;
    const list = out.get(card.phase);
    if (list) list.push(card);
    else out.set(card.phase, [card]);
  }
  for (const list of out.values()) {
    list.sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      return b.lastActiveAt - a.lastActiveAt;
    });
  }
  return out;
}

/** All tags in use, most-used first, for the filter bar. */
export function allTags(cards: Record<string, BoardSession>): string[] {
  const counts = new Map<string, number>();
  for (const card of Object.values(cards)) {
    for (const t of card.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}
