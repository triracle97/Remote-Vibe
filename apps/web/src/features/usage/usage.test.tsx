import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { UsageIndicator } from './UsageIndicator';
import { SessionUsageBadge } from './SessionUsageBadge';
import {
  formatLimitType,
  formatResetsIn,
  groupByAccount,
  totalTokens,
  useUsageStore,
  utilizationTone,
  windowKey,
  worstWindow,
} from '../../store/usage';
import type {
  AccountRateLimitWindow,
  ClientMsg,
  RateLimitAccount,
  SessionUsage,
} from '../../types/protocol';

afterEach(cleanup);

const sent: ClientMsg[] = [];
vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: () => ({ send: (m: ClientMsg) => sent.push(m) }),
}));

function acct(label = 'default'): RateLimitAccount {
  return { key: `claude:${label}`, label, agent: 'claude', configDir: `/home/me/.${label}` };
}

function win(over: Partial<AccountRateLimitWindow> = {}): AccountRateLimitWindow {
  return {
    limitType: 'seven_day',
    utilization: 0.78,
    resetsAt: null,
    status: 'allowed_warning',
    isUsingOverage: false,
    observedAt: 1000,
    account: acct(),
    ...over,
  };
}

/** The store's own keying, so a test never invents a shape the reducer won't. */
function windowMap(...ws: AccountRateLimitWindow[]): Record<string, AccountRateLimitWindow> {
  return Object.fromEntries(ws.map((w) => [windowKey(w), w]));
}

function usage(over: Partial<SessionUsage> = {}): SessionUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 900,
    cacheCreationTokens: 200,
    costUsd: 0.1234,
    turns: 3,
    // 100 + 900 + 200 — the input side of the last turn.
    contextTokens: 1200,
    ...over,
  };
}

beforeEach(() => {
  sent.length = 0;
  useUsageStore.setState({ bySession: {}, windows: {} });
});

describe('usage selectors', () => {
  it('sums every token kind', () => {
    expect(totalTokens(usage())).toBe(1250);
  });

  it('picks the window closest to its limit', () => {
    const worst = worstWindow(
      windowMap(win({ limitType: 'five_hour', utilization: 0.2 }), win({ utilization: 0.9 })),
    );
    expect(worst?.limitType).toBe('seven_day');
  });

  it('returns null when nothing has been observed', () => {
    expect(worstWindow({})).toBeNull();
  });

  it('prefers a window with a real number over one that reported none', () => {
    // A healthy window carries no utilization at all, so it must not outrank
    // — nor be outranked into invisibility by — one that does.
    const worst = worstWindow(
      windowMap(
        win({ limitType: 'five_hour', utilization: null, status: 'allowed' }),
        win({ utilization: 0.4 }),
      ),
    );
    expect(worst?.limitType).toBe('seven_day');
  });

  it('still picks a window when none of them reported a number', () => {
    const worst = worstWindow(
      windowMap(win({ limitType: 'five_hour', utilization: null, status: 'allowed' })),
    );
    expect(worst?.limitType).toBe('five_hour');
  });

  it('keeps each account on its own plan', () => {
    // The bug this exists for: two profiles both report a `five_hour` window,
    // and keying on the limit type alone made the second overwrite the first.
    const windows = windowMap(
      win({ limitType: 'five_hour', utilization: 0.2, account: acct('default') }),
      win({ limitType: 'five_hour', utilization: 0.9, account: acct('claude1') }),
    );
    expect(Object.keys(windows)).toHaveLength(2);

    const groups = groupByAccount(windows);
    expect(groups.map((g) => g.account.label)).toEqual(['claude1', 'default']);
    expect(groups[0]!.worst.utilization).toBe(0.9);
    expect(groups[1]!.worst.utilization).toBe(0.2);
    // The ring reports the account about to stop you, not an average.
    expect(worstWindow(windows)?.account.label).toBe('claude1');
  });

  it('sorts an account with no figure below one that has one', () => {
    const groups = groupByAccount(
      windowMap(
        win({ utilization: null, status: 'allowed', account: acct('claude1') }),
        win({ utilization: 0.3, account: acct('default') }),
      ),
    );
    expect(groups.map((g) => g.account.label)).toEqual(['default', 'claude1']);
  });

  it('bands utilization', () => {
    expect(utilizationTone(0.1)).toBe('ok');
    expect(utilizationTone(0.6)).toBe('warn');
    expect(utilizationTone(0.85)).toBe('danger');
    expect(utilizationTone(1)).toBe('danger');
    // Below the CLI's warning threshold — healthy, not empty.
    expect(utilizationTone(null)).toBe('ok');
  });

  it('gives limit types readable names', () => {
    expect(formatLimitType('five_hour')).toBe('5-hour');
    expect(formatLimitType('seven_day_opus')).toBe('7-day (Opus)');
    expect(formatLimitType('some_new_window')).toBe('some new window');
  });

  it('formats reset times relative to now', () => {
    const now = 1_000_000_000_000;
    const at = (ms: number): number => (now + ms) / 1000;
    expect(formatResetsIn(at(30 * 60_000), now)).toBe('resets in 30m');
    expect(formatResetsIn(at(150 * 60_000), now)).toBe('resets in 2h 30m');
    expect(formatResetsIn(at(-1000), now)).toBe('resets soon');
    expect(formatResetsIn(null, now)).toBe('');
  });
});

describe('usage store', () => {
  it('records per-session totals', () => {
    useUsageStore.getState().applyServerMsg({
      type: 'session_usage',
      sessionId: 's1',
      usage: usage(),
    });
    expect(useUsageStore.getState().bySession.s1!.turns).toBe(3);
  });

  it('replaces the whole window set on each update', () => {
    useUsageStore.setState({ windows: windowMap(win({ limitType: 'old_window' })) });
    useUsageStore.getState().applyServerMsg({ type: 'rate_limits', windows: [win()] });
    expect(Object.keys(useUsageStore.getState().windows)).toEqual([
      windowKey(win()),
    ]);
  });

  it('seeds totals from the board snapshot', () => {
    useUsageStore.getState().applyServerMsg({
      type: 'all_sessions',
      sessions: [{ sessionId: 's9', usage: usage({ turns: 7 }) } as never],
    });
    expect(useUsageStore.getState().bySession.s9!.turns).toBe(7);
  });

  it('drops totals for a deleted session', () => {
    useUsageStore.setState({ bySession: { s1: usage() } });
    useUsageStore.getState().applyServerMsg({ type: 'session_deleted', sessionId: 's1' });
    expect(useUsageStore.getState().bySession.s1).toBeUndefined();
  });
});

describe('UsageIndicator', () => {
  it('renders nothing before any window is observed', () => {
    const { container } = render(<UsageIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the worst window as a percentage', () => {
    useUsageStore.setState({
      windows: windowMap(win({ limitType: 'five_hour', utilization: 0.1 }), win({ utilization: 0.78 })),
    });
    render(<UsageIndicator />);
    expect(screen.getByTestId('usage-indicator').getAttribute('aria-label')).toBe(
      'Plan usage 78% on default',
    );
    expect(screen.getByText('78')).toBeTruthy();
    // One account needs no caption — the number can only be its own.
    expect(screen.queryByTestId('usage-account')).toBeNull();
  });

  it('opens a popover listing every window', () => {
    useUsageStore.setState({
      windows: windowMap(win({ limitType: 'five_hour', utilization: 0.1 }), win({ utilization: 0.78 })),
    });
    render(<UsageIndicator />);
    fireEvent.click(screen.getByTestId('usage-indicator'));
    const popover = screen.getByTestId('usage-popover');
    expect(popover.textContent).toContain('5-hour');
    expect(popover.textContent).toContain('7-day');
    expect(popover.textContent).toContain('78%');
  });

  it('names the account each figure belongs to when more than one is in play', () => {
    useUsageStore.setState({
      windows: windowMap(
        win({ limitType: 'five_hour', utilization: 0.12, account: acct('default') }),
        win({ limitType: 'five_hour', utilization: 0.91, account: acct('claude1') }),
      ),
    });
    render(<UsageIndicator />);
    // The ring is the account closest to its limit, and says so.
    expect(screen.getByTestId('usage-account').textContent).toBe('claude1');
    expect(screen.getByTestId('usage-indicator').getAttribute('aria-label')).toBe(
      'Plan usage 91% on claude1',
    );

    fireEvent.click(screen.getByTestId('usage-indicator'));
    const popover = screen.getByTestId('usage-popover');
    expect(popover.textContent).toContain('claude1');
    expect(popover.textContent).toContain('default');
    expect(popover.textContent).toContain('91%');
    expect(popover.textContent).toContain('12%');
  });

  it('shows a healthy window that reported no number', () => {
    // The common case on an account well inside its limits: the ring has no
    // percentage to draw, but hiding it entirely reads as "usage unavailable".
    useUsageStore.setState({
      windows: windowMap(
        win({
          limitType: 'five_hour',
          utilization: null,
          status: 'allowed',
          resetsAt: null,
        }),
      ),
    });
    render(<UsageIndicator />);
    expect(screen.getByTestId('usage-indicator').getAttribute('aria-label')).toBe(
      'Plan usage below warning threshold on default',
    );
    fireEvent.click(screen.getByTestId('usage-indicator'));
    const popover = screen.getByTestId('usage-popover');
    expect(popover.textContent).toContain('5-hour');
    expect(popover.textContent).toContain('OK');
    expect(popover.textContent).not.toContain('0%');
  });

  it('flags overage', () => {
    useUsageStore.setState({ windows: windowMap(win({ isUsingOverage: true })) });
    render(<UsageIndicator />);
    fireEvent.click(screen.getByTestId('usage-indicator'));
    expect(screen.getByText('using overage')).toBeTruthy();
  });
});

describe('SessionUsageBadge', () => {
  it('renders nothing until a turn completes', () => {
    useUsageStore.setState({ bySession: { s1: usage({ turns: 0 }) } });
    const { container } = render(<SessionUsageBadge sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it('leads with the context level and cost, not lifetime spend', () => {
    useUsageStore.setState({ bySession: { s1: usage() } });
    render(<SessionUsageBadge sessionId="s1" />);
    const badge = screen.getByTestId('session-usage-badge');
    expect(badge.textContent).toContain('1.2k ctx');
    expect(badge.textContent).toContain('$0.12');
    // Lifetime total (1.3k) belongs in the breakdown, not on the badge.
    expect(badge.textContent).not.toContain('1.3k');
  });

  it('shows context falling after a compaction while the total keeps climbing', () => {
    useUsageStore.setState({ bySession: { s1: usage() } });
    const { rerender } = render(<SessionUsageBadge sessionId="s1" />);
    expect(screen.getByTestId('session-usage-badge').textContent).toContain('1.2k ctx');

    // Next turn compacts: context drops, cumulative input keeps growing.
    useUsageStore.setState({
      bySession: { s1: usage({ inputTokens: 150, contextTokens: 300 }) },
    });
    rerender(<SessionUsageBadge sessionId="s1" />);
    expect(screen.getByTestId('session-usage-badge').textContent).toContain('300 ctx');
  });

  it('shows both context and lifetime total in the breakdown', () => {
    useUsageStore.setState({ bySession: { s1: usage() } });
    render(<SessionUsageBadge sessionId="s1" />);
    fireEvent.click(screen.getByTestId('session-usage-badge'));
    const detail = screen.getByTestId('session-usage-breakdown');
    expect(detail.textContent).toContain('Context now');
    expect(detail.textContent).toContain('Total used');
    expect(detail.textContent).toContain('1.3k');
  });

  it('falls back to zero context against a bridge that does not report it', () => {
    const { contextTokens: _drop, ...legacy } = usage();
    useUsageStore.setState({ bySession: { s1: legacy as SessionUsage } });
    render(<SessionUsageBadge sessionId="s1" />);
    expect(screen.getByTestId('session-usage-badge').textContent).toContain('0 ctx');
  });

  it('breaks the totals down on click', () => {
    useUsageStore.setState({ bySession: { s1: usage() } });
    render(<SessionUsageBadge sessionId="s1" />);
    fireEvent.click(screen.getByTestId('session-usage-badge'));
    const detail = screen.getByTestId('session-usage-breakdown');
    expect(detail.textContent).toContain('Cache read');
    expect(detail.textContent).toContain('$0.1234');
  });

  it('renders nothing for a session with no recorded usage', () => {
    const { container } = render(<SessionUsageBadge sessionId="unknown" />);
    expect(container.firstChild).toBeNull();
  });
});
