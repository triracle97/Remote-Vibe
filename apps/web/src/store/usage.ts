import { create } from 'zustand';
import { getBridgeClient, hasBridgeClient } from '../services/bridge-client-singleton';
import {
  EMPTY_SESSION_USAGE,
  type AccountRateLimitWindow,
  type RateLimitAccount,
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
  /**
   * `windowKey(w)` → latest window.
   *
   * Keyed by account *and* limit type: two Claude profiles are two plans with
   * two separate 5-hour windows, and keying on the type alone made whichever
   * account spoke last overwrite the other's figure.
   */
  windows: Record<string, AccountRateLimitWindow>;
  applyServerMsg: (m: ServerMsg) => void;
  refreshRateLimits: () => void;
}

/** Identity of one window: which plan, which limit. */
export function windowKey(w: AccountRateLimitWindow): string {
  return `${w.account.key} ${w.limitType}`;
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
        const windows: Record<string, AccountRateLimitWindow> = {};
        for (const w of m.windows) windows[windowKey(w)] = w;
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
    // Quota is decoration: it renders empty without a bridge and must not
    // throw for the sake of it. Usage is fetched only when the user asks for
    // it, so opening the app never starts background quota requests.
    if (!hasBridgeClient()) return;
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
  windows: Record<string, AccountRateLimitWindow> | AccountRateLimitWindow[],
): AccountRateLimitWindow | null {
  const all = Array.isArray(windows) ? windows : Object.values(windows);
  if (all.length === 0) return null;
  return all.reduce((a, b) => {
    if (b.utilization === null) return a;
    if (a.utilization === null) return b;
    return b.utilization > a.utilization ? b : a;
  });
}

/**
 * Reading order for one account's windows: the short window first, because it
 * is the one that stops you this afternoon, then the week.
 *
 * Anything unrecognised sorts last rather than being dropped — a plan that
 * grows a new window should show it, not hide it.
 */
const WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus'];

function windowRank(limitType: string): number {
  const i = WINDOW_ORDER.indexOf(limitType);
  return i === -1 ? WINDOW_ORDER.length : i;
}

/**
 * The windows belonging to one credential, in reading order.
 *
 * This is what the session header asks for: a session running as `claude1`
 * should show `claude1`'s 5-hour and weekly figures, not the worst window
 * across every account the bridge happens to drive.
 *
 * Windows the account does not report simply are not here — a Codex plan
 * reports one weekly window and no 5-hour one, so a Codex session shows a
 * single row rather than an empty "5h —".
 */
export function windowsForAccount(
  windows: Record<string, AccountRateLimitWindow> | AccountRateLimitWindow[],
  accountKey: string | null | undefined,
): AccountRateLimitWindow[] {
  if (!accountKey) return [];
  const all = Array.isArray(windows) ? windows : Object.values(windows);
  return all
    .filter((w) => w.account.key === accountKey)
    .sort(
      (a, b) => windowRank(a.limitType) - windowRank(b.limitType) ||
        a.limitType.localeCompare(b.limitType),
    );
}

export interface AccountWindows {
  account: RateLimitAccount;
  /** That account's windows, worst first. */
  windows: AccountRateLimitWindow[];
  /** The one that will stop this account first. Never null — groups are non-empty. */
  worst: AccountRateLimitWindow;
}

/**
 * One group per plan, so the popover can say *whose* 78% it is.
 *
 * Accounts sort by how close they are to a limit, then by name — the account
 * about to run out is the one worth reading first. Within a group, windows the
 * CLI put a number on come before the healthy ones it stayed quiet about.
 */
export function groupByAccount(
  windows: Record<string, AccountRateLimitWindow>,
): AccountWindows[] {
  const groups = new Map<string, AccountRateLimitWindow[]>();
  for (const w of Object.values(windows)) {
    const list = groups.get(w.account.key);
    if (list) list.push(w);
    else groups.set(w.account.key, [w]);
  }
  return [...groups.values()]
    .map((list) => {
      const sorted = [...list].sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1));
      return { account: sorted[0]!.account, windows: sorted, worst: worstWindow(sorted)! };
    })
    .sort(
      (a, b) =>
        (b.worst.utilization ?? -1) - (a.worst.utilization ?? -1) ||
        a.account.label.localeCompare(b.account.label),
    );
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

/** `five_hour` → `5h`. For the header chip, where `5-hour` will not fit. */
export function shortLimitType(limitType: string): string {
  const map: Record<string, string> = {
    five_hour: '5h',
    seven_day: '7d',
    seven_day_opus: '7d opus',
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

/**
 * The clock time a window resets, for planning around it: "14:35" if that is
 * today, "Thu 14:35" later in the week, "10 Sep 14:35" beyond that. Local
 * time in the browser's own locale, because that is the clock on the wall —
 * a countdown says how long, this says *when*.
 */
export function formatResetsAt(resetsAt: number | null, now: number = Date.now()): string {
  if (resetsAt === null) return '';
  const at = new Date(resetsAt * 1000);
  const ref = new Date(now);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay =
    at.getFullYear() === ref.getFullYear() &&
    at.getMonth() === ref.getMonth() &&
    at.getDate() === ref.getDate();
  if (sameDay) return time;
  const withinWeek = resetsAt * 1000 - now < 6 * 24 * 3_600_000;
  const day = withinWeek
    ? at.toLocaleDateString([], { weekday: 'short' })
    : at.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return `${day} ${time}`;
}

/** "resets in 2h 10m · 14:35", or "resets soon" once the window has elapsed. */
export function describeReset(resetsAt: number | null, now: number = Date.now()): string {
  if (resetsAt === null) return '';
  const relative = formatResetsIn(resetsAt, now);
  if (relative === 'resets soon') return relative;
  return `${relative} · ${formatResetsAt(resetsAt, now)}`;
}
