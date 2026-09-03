import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SessionQuotaBadge } from './SessionQuotaBadge';
import { shortLimitType, useUsageStore, windowKey, windowsForAccount } from '../../store/usage';
import type { AccountRateLimitWindow, ClientMsg, RateLimitAccount } from '../../types/protocol';

afterEach(cleanup);

const sent: ClientMsg[] = [];
vi.mock('../../services/bridge-client-singleton', () => ({
  hasBridgeClient: () => true,
  getBridgeClient: () => ({ send: (m: ClientMsg) => sent.push(m) }),
}));

function acct(label = 'default', agent: 'claude' | 'codex' = 'claude'): RateLimitAccount {
  return {
    key: `${agent}:${label}`,
    label,
    agent,
    configDir: agent === 'claude' ? `/home/me/.${label}` : null,
  };
}

function win(over: Partial<AccountRateLimitWindow> = {}): AccountRateLimitWindow {
  return {
    limitType: 'five_hour',
    utilization: 0.17,
    resetsAt: null,
    status: 'allowed',
    isUsingOverage: false,
    observedAt: 1000,
    source: 'poll',
    account: acct(),
    ...over,
  };
}

function windowMap(...ws: AccountRateLimitWindow[]): Record<string, AccountRateLimitWindow> {
  return Object.fromEntries(ws.map((w) => [windowKey(w), w]));
}

beforeEach(() => {
  sent.length = 0;
  useUsageStore.setState({ bySession: {}, windows: {} });
});

describe('windowsForAccount', () => {
  it('returns only the windows belonging to that credential', () => {
    const other = acct('claude1');
    const map = windowMap(
      win(),
      win({ limitType: 'seven_day', utilization: 0.19 }),
      win({ account: other, utilization: 0.9 }),
    );
    const mine = windowsForAccount(map, 'claude:default');
    expect(mine.map((w) => w.limitType)).toEqual(['five_hour', 'seven_day']);
    // The other profile's 90% belongs to the other profile.
    expect(mine.every((w) => w.account.key === 'claude:default')).toBe(true);
  });

  it('reads short window first, then the week', () => {
    const map = windowMap(win({ limitType: 'seven_day' }), win({ limitType: 'five_hour' }));
    expect(windowsForAccount(map, 'claude:default').map((w) => w.limitType)).toEqual([
      'five_hour',
      'seven_day',
    ]);
  });

  it('keeps a window it has no name for rather than dropping it', () => {
    const map = windowMap(win({ limitType: 'window_24h' }), win({ limitType: 'five_hour' }));
    expect(windowsForAccount(map, 'claude:default').map((w) => w.limitType)).toEqual([
      'five_hour',
      'window_24h',
    ]);
  });

  it('is empty when the session has no account key yet', () => {
    expect(windowsForAccount(windowMap(win()), null)).toEqual([]);
    expect(windowsForAccount(windowMap(win()), undefined)).toEqual([]);
  });
});

describe('shortLimitType', () => {
  it('abbreviates the windows the header shows', () => {
    expect(shortLimitType('five_hour')).toBe('5h');
    expect(shortLimitType('seven_day')).toBe('7d');
  });
});

describe('SessionQuotaBadge', () => {
  it('shows both windows for the session account', () => {
    useUsageStore.setState({
      windows: windowMap(win(), win({ limitType: 'seven_day', utilization: 0.19 })),
    });
    render(<SessionQuotaBadge accountKey="claude:default" />);
    const badge = screen.getByTestId('session-quota-badge');
    expect(badge.textContent).toContain('5h');
    expect(badge.textContent).toContain('17%');
    expect(badge.textContent).toContain('7d');
    expect(badge.textContent).toContain('19%');
  });

  it('shows this session account, not the account closest to its limit', () => {
    useUsageStore.setState({
      windows: windowMap(
        win({ account: acct('claude1'), utilization: 0.12 }),
        win({ utilization: 0.95 }),
      ),
    });
    render(<SessionQuotaBadge accountKey="claude:claude1" />);
    const badge = screen.getByTestId('session-quota-badge');
    expect(badge.textContent).toContain('12%');
    expect(badge.textContent).not.toContain('95%');
  });

  it('shows a Codex session only the window its plan has', () => {
    // A ChatGPT plan reports a weekly window and no 5-hour one, so there is no
    // 5-hour row to render — showing an empty one would invent a limit.
    useUsageStore.setState({
      windows: windowMap(
        win({ limitType: 'seven_day', utilization: 0.38, account: acct('default', 'codex') }),
      ),
    });
    render(<SessionQuotaBadge accountKey="codex:default" />);
    const badge = screen.getByTestId('session-quota-badge');
    expect(badge.textContent).toContain('7d');
    expect(badge.textContent).toContain('38%');
    expect(badge.textContent).not.toContain('5h');
  });

  it('renders nothing before anything has been observed', () => {
    render(<SessionQuotaBadge accountKey="claude:default" />);
    expect(screen.queryByTestId('session-quota-badge')).toBeNull();
  });

  it('renders OK, never 0%, for a window with no figure', () => {
    useUsageStore.setState({ windows: windowMap(win({ utilization: null })) });
    render(<SessionQuotaBadge accountKey="claude:default" />);
    expect(screen.getByTestId('session-quota-badge').textContent).toContain('OK');
    expect(screen.getByTestId('session-quota-badge').textContent).not.toContain('0%');
  });

  it('opens a breakdown naming the account', () => {
    useUsageStore.setState({
      windows: windowMap(win({ account: acct('claude1'), resetsAt: null })),
    });
    render(<SessionQuotaBadge accountKey="claude:claude1" />);
    fireEvent.click(screen.getByTestId('session-quota-badge'));
    const popover = screen.getByTestId('session-quota-popover');
    expect(popover.textContent).toContain('claude1');
    expect(popover.textContent).toContain('5-hour');
  });
});

describe('SessionQuotaBadge reset time', () => {
  const clockOf = (resetsAt: number): string =>
    new Date(resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  it('shows when the 5-hour window resets in the chip itself', () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 150 * 60;
    useUsageStore.setState({ windows: windowMap(win({ resetsAt })) });
    render(<SessionQuotaBadge accountKey="claude:default" />);
    expect(screen.getByTestId('session-quota-reset').textContent).toContain(clockOf(resetsAt));
    // Assistive tech gets the countdown as well as the clock.
    const label = screen.getByTestId('session-quota-badge').getAttribute('aria-label') ?? '';
    expect(label).toMatch(/resets in 2h (29|30)m/);
  });

  it('keeps the weekly reset to the popover', () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;
    useUsageStore.setState({
      windows: windowMap(win({ limitType: 'seven_day', utilization: 0.4, resetsAt })),
    });
    render(<SessionQuotaBadge accountKey="claude:default" />);
    expect(screen.queryByTestId('session-quota-reset')).toBeNull();
    fireEvent.click(screen.getByTestId('session-quota-badge'));
    const text = screen.getByTestId('session-quota-popover-reset').textContent ?? '';
    expect(text).toMatch(/resets in 2d 23h/);
    expect(text).toContain(clockOf(resetsAt));
  });

  it('shows nothing for a window that did not report a reset', () => {
    useUsageStore.setState({ windows: windowMap(win({ resetsAt: null })) });
    render(<SessionQuotaBadge accountKey="claude:default" />);
    expect(screen.queryByTestId('session-quota-reset')).toBeNull();
  });
});

describe('rate limit refresh', () => {
  it('does not ask for quota when the socket opens', () => {
    useUsageStore.getState().applyServerMsg({ type: 'system', event: 'init' });
    expect(sent).toEqual([]);
  });
});
