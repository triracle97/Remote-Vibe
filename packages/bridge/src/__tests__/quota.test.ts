import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistry } from '../session-registry.js';
import { SessionManager, type AgentDriver, type QuotaReader } from '../session.js';
import {
  QuotaPoller,
  claudeKeychainService,
  codexLimitType,
  parseClaudeUsage,
  parseCodexUsage,
  readClaudeAccessToken,
  readCodexAuth,
  type QuotaSource,
} from '../quota.js';
import type { AgentEvent, RateLimitWindow, ServerMsg } from '../types.js';

/**
 * Captured from `GET api.anthropic.com/api/oauth/usage` on a Max account.
 * Trimmed to the keys we read plus a couple we must ignore.
 */
const CLAUDE_PAYLOAD = {
  five_hour: { utilization: 17.0, resets_at: '2026-08-18T07:09:59.898128+00:00' },
  seven_day: { utilization: 19.0, resets_at: '2026-08-23T06:59:59.898154+00:00' },
  seven_day_opus: null,
  // Internal codenames the endpoint also returns; not ours to render.
  nimbus_quill: { utilization: 0.0, resets_at: null },
  extra_usage: { is_enabled: false, utilization: null },
  limits: [
    { kind: 'session', group: 'session', percent: 17, severity: 'normal' },
    { kind: 'weekly_all', group: 'weekly', percent: 19, severity: 'normal' },
    { kind: 'weekly_scoped', group: 'weekly', percent: 24, severity: 'normal' },
  ],
};

/** Captured from `GET chatgpt.com/backend-api/wham/usage`, identifiers removed. */
const CODEX_PAYLOAD = {
  plan_type: 'prolite',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 38,
      limit_window_seconds: 604800,
      reset_after_seconds: 213798,
      reset_at: 1787243021,
    },
    secondary_window: null,
  },
};

describe('parseClaudeUsage', () => {
  it('reads both windows off the real payload', () => {
    const out = parseClaudeUsage(CLAUDE_PAYLOAD, 5000);
    expect(out.map((w) => w.limitType)).toEqual(['five_hour', 'seven_day']);
    // The endpoint speaks percentages, our windows speak fractions. Mixing
    // them renders 17% as 1700%.
    expect(out[0]!.utilization).toBeCloseTo(0.17, 6);
    expect(out[1]!.utilization).toBeCloseTo(0.19, 6);
    expect(out[0]!.source).toBe('poll');
    expect(out[0]!.observedAt).toBe(5000);
  });

  it('converts the ISO reset time to unix seconds', () => {
    const [five] = parseClaudeUsage(CLAUDE_PAYLOAD, 0);
    expect(five!.resetsAt).toBe(Math.round(Date.parse('2026-08-18T07:09:59.898128+00:00') / 1000));
  });

  it('takes the severity from the matching limits entry', () => {
    const [five, seven] = parseClaudeUsage(
      {
        ...CLAUDE_PAYLOAD,
        limits: [
          { kind: 'session', severity: 'normal' },
          { kind: 'weekly_all', severity: 'warning' },
        ],
      },
      0,
    );
    expect(five!.status).toBe('allowed');
    expect(seven!.status).toBe('allowed_warning');
  });

  it('drops windows the plan does not have, and codenames it does', () => {
    const types = parseClaudeUsage(CLAUDE_PAYLOAD, 0).map((w) => w.limitType);
    expect(types).not.toContain('seven_day_opus');
    expect(types).not.toContain('nimbus_quill');
  });

  it('flags overage only when some of it has been spent', () => {
    const off = parseClaudeUsage(CLAUDE_PAYLOAD, 0);
    expect(off[0]!.isUsingOverage).toBe(false);
    const on = parseClaudeUsage(
      { ...CLAUDE_PAYLOAD, extra_usage: { is_enabled: true, utilization: 12 } },
      0,
    );
    expect(on[0]!.isUsingOverage).toBe(true);
    // Enabled but untouched is not "using overage".
    const armed = parseClaudeUsage(
      { ...CLAUDE_PAYLOAD, extra_usage: { is_enabled: true, utilization: 0 } },
      0,
    );
    expect(armed[0]!.isUsingOverage).toBe(false);
  });

  it('returns nothing for a payload it cannot read', () => {
    expect(parseClaudeUsage(null, 0)).toEqual([]);
    expect(parseClaudeUsage({}, 0)).toEqual([]);
    expect(parseClaudeUsage({ five_hour: { utilization: 'lots' } }, 0)).toEqual([]);
  });
});

describe('codexLimitType', () => {
  it('names a weekly window weekly and a short one five_hour', () => {
    expect(codexLimitType(604800)).toBe('seven_day');
    expect(codexLimitType(18000)).toBe('five_hour');
  });

  it('keeps an unfamiliar window rather than mislabelling it', () => {
    expect(codexLimitType(86400)).toBe('window_24h');
  });
});

describe('parseCodexUsage', () => {
  it('reads the weekly window off the real payload', () => {
    const out = parseCodexUsage(CODEX_PAYLOAD, 7000);
    expect(out).toHaveLength(1);
    expect(out[0]!.limitType).toBe('seven_day');
    expect(out[0]!.utilization).toBeCloseTo(0.38, 6);
    expect(out[0]!.resetsAt).toBe(1787243021);
    expect(out[0]!.status).toBe('allowed');
  });

  it('reports no 5-hour window, because a ChatGPT plan has none', () => {
    expect(parseCodexUsage(CODEX_PAYLOAD, 0).map((w) => w.limitType)).not.toContain('five_hour');
  });

  it('marks a spent plan rejected', () => {
    const out = parseCodexUsage(
      { rate_limit: { ...CODEX_PAYLOAD.rate_limit, limit_reached: true } },
      0,
    );
    expect(out[0]!.status).toBe('rejected');
  });

  it('returns nothing for a payload it cannot read', () => {
    expect(parseCodexUsage(null, 0)).toEqual([]);
    expect(parseCodexUsage({ rate_limit: {} }, 0)).toEqual([]);
  });
});

describe('claudeKeychainService', () => {
  it('uses the plain slot when no config dir is exported', () => {
    // Claude Code derives the item from CLAUDE_CONFIG_DIR, so a session that
    // inherits the environment must NOT be looked up under a hashed name.
    expect(claudeKeychainService(null)).toBe('Claude Code-credentials');
  });

  it('uses a per-directory slot when one is', () => {
    const a = claudeKeychainService('/Users/me/.claude');
    const b = claudeKeychainService('/Users/me/.claude1');
    expect(a).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(b).not.toBe(a);
    // Stable: it is a hash of the path, not of anything session-scoped.
    expect(claudeKeychainService('/Users/me/.claude1')).toBe(b);
  });
});

const claudeSrc = (configDir: string | null): QuotaSource => ({
  account: { key: 'claude:default', label: 'default', agent: 'claude', configDir },
  claudeConfigDir: configDir,
  codexHome: null,
});

const codexSrc = (codexHome: string | null): QuotaSource => ({
  account: { key: 'codex:default', label: 'default', agent: 'codex', configDir: null },
  claudeConfigDir: null,
  codexHome,
});

describe('credential reading', () => {
  it('prefers the on-disk credentials file when the profile has one', async () => {
    const token = await readClaudeAccessToken(claudeSrc('/cfg'), {
      readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'from-file' } }),
      readKeychain: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'from-chain' } }),
    });
    expect(token).toBe('from-file');
  });

  it('falls back to the keychain slot the config dir implies', async () => {
    const asked: string[] = [];
    const token = await readClaudeAccessToken(claudeSrc('/cfg'), {
      readFile: async () => {
        throw new Error('ENOENT');
      },
      readKeychain: async (service) => {
        asked.push(service);
        return JSON.stringify({ claudeAiOauth: { accessToken: 'from-chain' } });
      },
    });
    expect(token).toBe('from-chain');
    expect(asked).toEqual([claudeKeychainService('/cfg')]);
  });

  it('returns null rather than throwing when there is no credential', async () => {
    expect(
      await readClaudeAccessToken(claudeSrc(null), {
        readKeychain: async () => null,
      }),
    ).toBeNull();
    expect(
      await readClaudeAccessToken(claudeSrc(null), {
        readKeychain: async () => 'not json',
      }),
    ).toBeNull();
  });

  it('reads the Codex token and account id from auth.json', async () => {
    const auth = await readCodexAuth(codexSrc('/codex'), {
      readFile: async (p) => {
        expect(p).toBe(join('/codex', 'auth.json'));
        return JSON.stringify({ tokens: { access_token: 'tok', account_id: 'acct' } });
      },
    });
    expect(auth).toEqual({ accessToken: 'tok', accountId: 'acct' });
  });
});

describe('QuotaPoller', () => {
  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body }) as Response;

  it('fetches a Claude account and returns its windows', async () => {
    let seenUrl = '';
    let seenAuth = '';
    const poller = new QuotaPoller({
      readKeychain: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }),
      fetch: (async (url: string, init: RequestInit) => {
        seenUrl = url;
        seenAuth = (init.headers as Record<string, string>).authorization!;
        return okResponse(CLAUDE_PAYLOAD);
      }) as unknown as typeof globalThis.fetch,
      now: () => 1000,
    });
    const out = await poller.windows(claudeSrc(null));
    expect(seenUrl).toContain('/api/oauth/usage');
    expect(seenAuth).toBe('Bearer tok');
    expect(out.map((w) => w.limitType)).toEqual(['five_hour', 'seven_day']);
  });

  it('serves the cache inside the TTL and refetches after it', async () => {
    let calls = 0;
    let now = 0;
    const poller = new QuotaPoller({
      readKeychain: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }),
      fetch: (async () => {
        calls += 1;
        return okResponse(CLAUDE_PAYLOAD);
      }) as unknown as typeof globalThis.fetch,
      now: () => now,
      ttlMs: 1000,
    });
    await poller.windows(claudeSrc(null));
    now = 500;
    await poller.windows(claudeSrc(null));
    expect(calls).toBe(1);
    now = 1600;
    await poller.windows(claudeSrc(null));
    expect(calls).toBe(2);
  });

  it('shares one request between concurrent callers', async () => {
    let calls = 0;
    const poller = new QuotaPoller({
      readKeychain: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }),
      fetch: (async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return okResponse(CLAUDE_PAYLOAD);
      }) as unknown as typeof globalThis.fetch,
    });
    const src = claudeSrc(null);
    await Promise.all([poller.windows(src), poller.windows(src), poller.windows(src)]);
    expect(calls).toBe(1);
  });

  it('yields nothing, not an error, when the account is logged out', async () => {
    const poller = new QuotaPoller({
      readKeychain: async () => null,
      fetch: (() => {
        throw new Error('should not be called');
      }) as unknown as typeof globalThis.fetch,
    });
    expect(await poller.windows(claudeSrc(null))).toEqual([]);
  });

  it('swallows an HTTP failure so a turn never rides on quota', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poller = new QuotaPoller({
      readKeychain: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'stale' } }),
      fetch: (async () => ({ ok: false, status: 401 }) as Response) as unknown as typeof globalThis.fetch,
    });
    expect(await poller.windows(claudeSrc(null))).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('sends the Codex account header', async () => {
    let headers: Record<string, string> = {};
    const poller = new QuotaPoller({
      readFile: async () =>
        JSON.stringify({ tokens: { access_token: 'tok', account_id: 'acct' } }),
      fetch: (async (_url: string, init: RequestInit) => {
        headers = init.headers as Record<string, string>;
        return okResponse(CODEX_PAYLOAD);
      }) as unknown as typeof globalThis.fetch,
    });
    const out = await poller.windows(codexSrc('/codex'));
    expect(headers['chatgpt-account-id']).toBe('acct');
    expect(out.map((w) => w.limitType)).toEqual(['seven_day']);
  });
});

class FakeDriver extends EventEmitter implements AgentDriver {
  sendUserText(): void {}
  kill(): void {
    this.emit('exit', 0);
  }
}

const flush = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

function polled(over: Partial<RateLimitWindow> = {}): RateLimitWindow {
  return {
    limitType: 'five_hour',
    utilization: 0.17,
    resetsAt: 1000,
    status: 'allowed',
    isUsingOverage: false,
    observedAt: 1,
    source: 'poll',
    ...over,
  };
}

describe('SessionManager quota merge', () => {
  let dir: string;
  let registry: SessionRegistry;
  let driver: FakeDriver;
  let broadcasts: ServerMsg[];

  const build = (quota?: QuotaReader): SessionManager => {
    const mgr = new SessionManager({
      allowedDirs: [dir],
      bufferCap: 100,
      registry,
      realpath: async (p) => p,
      driverFactory: () => driver,
      ...(quota ? { quota } : {}),
    });
    const sink: ServerMsg[] = [];
    broadcasts = sink;
    mgr.on('broadcast', (m: ServerMsg) => sink.push(m));
    return mgr;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mrt-quota-'));
    registry = new SessionRegistry(join(dir, 'sessions.json'));
    await registry.load();
    driver = new FakeDriver();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const lastWindows = (): ReturnType<SessionManager['rateLimitWindows']> => {
    const msg = [...broadcasts].reverse().find((m) => m.type === 'rate_limits');
    return msg && msg.type === 'rate_limits' ? msg.windows : [];
  };

  it('polls the session account when a turn ends', async () => {
    const seen: QuotaSource[] = [];
    const mgr = build({
      windows: async (src) => {
        seen.push(src);
        return [polled(), polled({ limitType: 'seven_day', utilization: 0.19 })];
      },
    });
    await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    driver.emit('event', { kind: 'result' } satisfies AgentEvent);
    await flush();

    expect(seen[0]!.account.key).toBe('claude:default');
    expect(lastWindows().map((w) => w.limitType)).toEqual(['five_hour', 'seven_day']);
    expect(lastWindows()[0]!.utilization).toBeCloseTo(0.17, 6);
  });

  it('keeps a polled figure when a later event names none', async () => {
    const mgr = build({ windows: async () => [polled()] });
    await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    driver.emit('event', { kind: 'result' } satisfies AgentEvent);
    await flush();
    expect(lastWindows()[0]!.utilization).toBeCloseTo(0.17, 6);

    // The CLI withholds `utilization` below the warning threshold. Taking the
    // newer report wholesale blanked the real number back to "no figure".
    driver.emit('event', {
      kind: 'rate_limit',
      window: {
        limitType: 'five_hour',
        utilization: null,
        resetsAt: 2000,
        status: 'allowed',
        isUsingOverage: false,
        observedAt: 10,
      },
    } satisfies AgentEvent);
    await flush();
    const five = lastWindows().find((w) => w.limitType === 'five_hour')!;
    expect(five.utilization).toBeCloseTo(0.17, 6);
    // The parts the event *did* report still land.
    expect(five.resetsAt).toBe(2000);
  });

  it('lets an event that names a figure overwrite the polled one', async () => {
    const mgr = build({ windows: async () => [polled()] });
    await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    driver.emit('event', { kind: 'result' } satisfies AgentEvent);
    await flush();
    driver.emit('event', {
      kind: 'rate_limit',
      window: {
        limitType: 'five_hour',
        utilization: 0.91,
        resetsAt: 1000,
        status: 'allowed_warning',
        isUsingOverage: false,
        observedAt: 20,
      },
    } satisfies AgentEvent);
    await flush();
    expect(lastWindows()[0]!.utilization).toBeCloseTo(0.91, 6);
  });

  it('does not re-broadcast an unchanged poll', async () => {
    const mgr = build({ windows: async () => [polled({ observedAt: Date.now() })] });
    await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    driver.emit('event', { kind: 'result' } satisfies AgentEvent);
    await flush();
    const first = broadcasts.filter((m) => m.type === 'rate_limits').length;
    driver.emit('event', { kind: 'result' } satisfies AgentEvent);
    await flush();
    expect(broadcasts.filter((m) => m.type === 'rate_limits').length).toBe(first);
  });

  it('stamps the session account on session_created', async () => {
    const mgr = build();
    await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    const created = broadcasts.find(
      (m) => m.type === 'system' && m.event === 'session_created',
    );
    expect(created && 'accountKey' in created ? created.accountKey : null).toBe('claude:default');
    expect(mgr.listSessions()[0]!.accountKey).toBe('claude:default');
  });
});
