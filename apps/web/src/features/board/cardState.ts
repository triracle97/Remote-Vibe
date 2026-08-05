import type { BoardSession } from '../../types/protocol';

/**
 * How a card should read at a glance.
 *
 * Ported from nimbalyst's `SessionKanbanBoard.tsx` (`CardVisualState`). The
 * precedence is the whole point: a session that is both running and unread
 * should read as *running*, because that is the thing that changes on its own.
 */
export type CardVisualState = 'running' | 'waiting' | 'unread' | 'idle';

export interface CardStateInfo {
  state: CardVisualState;
  badgeLabel: string | null;
  /** Whether the badge icon should spin. */
  spin: boolean;
  /** CSS custom property for the accent colour, or null for idle. */
  token: string | null;
}

const INFO: Record<CardVisualState, CardStateInfo> = {
  running: { state: 'running', badgeLabel: 'running', spin: true, token: '--color-state-running' },
  waiting: { state: 'waiting', badgeLabel: 'needs input', spin: false, token: '--color-state-waiting' },
  unread: { state: 'unread', badgeLabel: 'new', spin: false, token: '--color-state-unread' },
  idle: { state: 'idle', badgeLabel: null, spin: false, token: null },
};

export interface LiveHints {
  /** Session is mid-turn (bridge is streaming for it). */
  processing?: boolean;
  /** Output arrived since the user last opened this session. */
  unread?: boolean;
}

export function cardVisualState(card: BoardSession, hints: LiveHints = {}): CardStateInfo {
  if (!card.alive) return INFO.idle;
  if (hints.processing) return INFO.running;
  if (hints.unread) return INFO.unread;
  // Alive but quiet: the agent is up and waiting on the human.
  return INFO.waiting;
}

/** Inline style for a card, tinted by its state. */
export function cardTint(info: CardStateInfo): React.CSSProperties {
  if (info.token === null) return {};
  const c = `var(${info.token})`;
  return {
    background: `color-mix(in srgb, ${c} 7%, transparent)`,
    borderColor: `color-mix(in srgb, ${c} 35%, transparent)`,
  };
}

/**
 * Compact relative time. Board cards are scanned, not read, so `3m` beats
 * `3 minutes ago` — and the unit alone carries the urgency.
 */
export function timeAgo(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  return `${Math.floor(d / 30)}mo`;
}

/** Last path segment, which is how people actually refer to a project. */
export function projectLabel(projectPath: string): string {
  return projectPath.split('/').filter(Boolean).pop() ?? projectPath;
}
