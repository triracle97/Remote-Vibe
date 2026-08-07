import { create } from 'zustand';
import { getBridgeClient } from '../services/bridge-client-singleton';
import {
  EMPTY_SESSION_USAGE,
  type RateLimitWindow,
  type ServerMsg,
  type SessionUsage,
} from '../types/protocol';

/**
 * Token spend and quota state.
 *
 * Two independent things live here because they answer the same question at
 * different scopes: "how much did *this chat* cost" and "how much of my plan
 * have I burned". The bridge pushes both — per-session totals after each turn,
 * quota windows whenever the CLI volunteers a `rate_limit_event`.
 */
interface UsageState {
  /** sessionId → running totals. */
  bySession: Record<string, SessionUsage>;
  /** limitType → latest window. */
  windows: Record<string, RateLimitWindow>;
  applyServerMsg: (m: ServerMsg) => void;
  refreshRateLimits: () => void;
}

export const useUsageStore = create<UsageState>((set, get) => ({
  bySession: {},
  windows: {},

  applyServerMsg: (m) => {
    switch (m.type) {
      case 'session_usage':
        set({ bySession: { ...get().bySession, [m.sessionId]: m.usage } });
        return;
      case 'rate_limits': {
        const windows: Record<string, RateLimitWindow> = {};
        for (const w of m.windows) windows[w.limitType] = w;
        set({ windows });
        return;
      }
      case 'all_sessions': {
        // The board snapshot carries persisted totals — seed from it so a
        // fresh page load shows real numbers before any turn completes.
        const bySession = { ...get().bySession };
        for (const s of m.sessions) {
          if (s.usage) bySession[s.sessionId] = s.usage;
        }
        set({ bySession });
        return;
      }
      case 'session_deleted': {
        const bySession = { ...get().bySession };
        delete bySession[m.sessionId];
        set({ bySession });
        return;
      }
      default:
        return;
    }
  },

  refreshRateLimits: () => {
    getBridgeClient().send({ type: 'get_rate_limits' });
  },
}));

export function sessionUsage(sessionId: string | null | undefined): SessionUsage {
  if (!sessionId) return EMPTY_SESSION_USAGE;
  return useUsageStore.getState().bySession[sessionId] ?? EMPTY_SESSION_USAGE;
}

/** Every token the session sent or received, cache included. */
export function totalTokens(u: SessionUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

/**
 * How full the context window is now, in tokens.
 *
 * Distinct from `totalTokens`, which only ever grows: this is the input side of
 * the most recent turn, so it rises as the conversation grows and drops when
 * the CLI compacts. Falls back to the last turn's input+cache when the bridge
 * is older than this field.
 */
export function contextTokens(u: SessionUsage): number {
  return u.contextTokens ?? 0;
}

/**
 * Worst window drives the summary indicator — the one closest to its limit is
 * the one that will actually stop you.
 *
 * A window with a null utilization is below its warning threshold, so it loses
 * to any window that named a number. It still wins over nothing: when every
 * window is healthy the indicator shows one of them rather than vanishing.
 */
export function worstWindow(
  windows: Record<string, RateLimitWindow>,
): RateLimitWindow | null {
  const all = Object.values(windows);
  if (all.length === 0) return null;
  return all.reduce((a, b) => {
    if (b.utilization === null) return a;
    if (a.utilization === null) return b;
    return b.utilization > a.utilization ? b : a;
  });
}

/**
 * Green under 60%, amber to 85%, red above. Mirrors nimbalyst's banding.
 *
 * Null — the CLI reported no figure — is green: it only withholds the number
 * while the window is under its own warning threshold.
 */
export function utilizationTone(utilization: number | null): 'ok' | 'warn' | 'danger' {
  if (utilization === null) return 'ok';
  if (utilization >= 0.85) return 'danger';
  if (utilization >= 0.6) return 'warn';
  return 'ok';
}

/** `five_hour` → `5-hour`, `seven_day_opus` → `7-day (Opus)`. */
export function formatLimitType(limitType: string): string {
  const map: Record<string, string> = {
    five_hour: '5-hour',
    seven_day: '7-day',
    seven_day_opus: '7-day (Opus)',
  };
  return map[limitType] ?? limitType.replace(/_/g, ' ');
}

/** "resets in 2h 10m", or "resets soon" once the window has elapsed. */
export function formatResetsIn(resetsAt: number | null, now: number = Date.now()): string {
  if (resetsAt === null) return '';
  const ms = resetsAt * 1000 - now;
  if (ms <= 0) return 'resets soon';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `resets in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `resets in ${days}d ${hours % 24}h`;
}
