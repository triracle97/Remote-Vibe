import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RateLimitAccount, RateLimitWindow } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Live plan quota, read from the same endpoints the two CLIs read themselves.
 *
 * The bridge already learns *something* about quota from Claude's mid-stream
 * `rate_limit_event`, but not enough to answer the only two questions worth
 * asking — how much of the 5-hour window is gone, and how much of the week:
 *
 *  - it names one window per turn (in practice `five_hour`), so the weekly
 *    figure simply never arrives until the week is nearly spent;
 *  - it withholds `utilization` entirely until a window crosses its own
 *    warning threshold, which is why a healthy account rendered as "OK" with
 *    no number rather than as "17%";
 *  - Codex's `exec --json` stream carries no quota at all.
 *
 * So each account is polled instead. Claude's `/usage` view and Codex's footer
 * both come from an HTTP endpoint reachable with the credential the CLI has
 * already stored on this machine, and both return every window at once with a
 * real percentage on each. `rate_limit_event` stays wired up as a free
 * mid-turn nudge; polling is what puts numbers on the screen.
 *
 * Nothing here ever writes or refreshes a credential. An expired token yields
 * no windows and a warning, and the next CLI turn refreshes it in the normal
 * way — rotating a refresh token behind the CLI's back would log the user out
 * of the very session that noticed.
 */

/** Anthropic's subscription usage endpoint, as used by `/usage`. */
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** ChatGPT's Codex usage endpoint, as used by the Codex footer. */
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
/** OAuth beta header Claude Code sends on subscription-scoped calls. */
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';

const FETCH_TIMEOUT_MS = 8000;
/** One poll per account per minute is plenty: windows move in percent-points. */
const DEFAULT_TTL_MS = 60_000;

/** Where one account's credential lives, alongside the identity the UI shows. */
export interface QuotaSource {
  account: RateLimitAccount;
  /**
   * The `CLAUDE_CONFIG_DIR` this account's sessions run with, or null when
   * they inherit the environment.
   *
   * Null is not the same as `~/.claude`: Claude Code derives its keychain item
   * from the variable, so an inherited environment reads the plain
   * `Claude Code-credentials` slot while an exported `~/.claude` reads the
   * hashed one. Passing the path here for a session that does not export it
   * would read a different account's quota, or none.
   */
  claudeConfigDir: string | null;
  /** `CODEX_HOME` for a Codex account. Null for Claude. */
  codexHome: string | null;
}

export interface QuotaDeps {
  fetch?: typeof globalThis.fetch;
  readFile?: (path: string) => Promise<string>;
  /** Reads one macOS keychain generic password. Null when there is no item. */
  readKeychain?: (service: string) => Promise<string | null>;
  now?: () => number;
  /** How long a fetched result stays fresh. */
  ttlMs?: number;
}

/**
 * The keychain item Claude Code stores this profile's credential under.
 *
 * `Claude Code-credentials` when no `CLAUDE_CONFIG_DIR` is exported, and
 * `Claude Code-credentials-<sha256(dir)[0..8]>` when one is. Mirrors the CLI —
 * get this wrong and the lookup silently returns another profile's token.
 */
export function claudeKeychainService(configDir: string | null): string {
  if (configDir === null) return 'Claude Code-credentials';
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

async function readKeychainViaSecurity(service: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      service,
      '-w',
    ]);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // No such item, or no keychain at all (Linux). Both mean "not here".
    return null;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * The OAuth access token for one Claude profile.
 *
 * Linux keeps it in `<configDir>/.credentials.json`; macOS keeps it in the
 * keychain. Try the file first — when it exists it is unambiguous — then the
 * keychain slot the config dir implies.
 */
export async function readClaudeAccessToken(
  src: QuotaSource,
  deps: QuotaDeps = {},
): Promise<string | null> {
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
  const readKeychain = deps.readKeychain ?? readKeychainViaSecurity;

  const fromFile =
    src.claudeConfigDir === null
      ? null
      : await readFile(join(src.claudeConfigDir, '.credentials.json')).catch(() => null);
  const raw = fromFile ?? (await readKeychain(claudeKeychainService(src.claudeConfigDir)));
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth = asRecord(asRecord(parsed)?.claudeAiOauth);
  const token = oauth?.accessToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/** The ChatGPT access token and account id for one Codex home. */
export async function readCodexAuth(
  src: QuotaSource,
  deps: QuotaDeps = {},
): Promise<{ accessToken: string; accountId: string | null } | null> {
  if (src.codexHome === null) return null;
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
  const raw = await readFile(join(src.codexHome, 'auth.json')).catch(() => null);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const tokens = asRecord(asRecord(parsed)?.tokens);
  const accessToken = tokens?.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
  const accountId = tokens?.account_id;
  return { accessToken, accountId: typeof accountId === 'string' ? accountId : null };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** ISO-8601 or unix seconds to unix seconds, since the two APIs differ. */
function toUnixSeconds(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return Math.round(n);
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : Math.round(ms / 1000);
}

/**
 * Windows the UI knows how to name, in the order it should read them.
 *
 * The payload also carries a handful of internal codenames; listing the ones
 * we understand keeps those out rather than rendering rows nobody can read.
 */
const CLAUDE_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus'] as const;

/** `limits[].kind` to our window names, for the severity each one reports. */
const CLAUDE_SEVERITY_KIND: Record<string, string> = {
  session: 'five_hour',
  weekly_all: 'seven_day',
};

function claudeStatus(severity: unknown): string | null {
  if (severity === 'normal') return 'allowed';
  if (severity === 'warning') return 'allowed_warning';
  return typeof severity === 'string' ? severity : null;
}

/**
 * Anthropic's usage payload to our window shape.
 *
 * `utilization` there is a percentage (17.0 == 17%); ours is a fraction, the
 * same units `rate_limit_event` uses. Mixing the two would render 17% as
 * 1700%.
 */
export function parseClaudeUsage(raw: unknown, observedAt: number): RateLimitWindow[] {
  const root = asRecord(raw);
  if (root === null) return [];

  const severities = new Map<string, unknown>();
  if (Array.isArray(root.limits)) {
    for (const entry of root.limits) {
      const rec = asRecord(entry);
      const kind = typeof rec?.kind === 'string' ? CLAUDE_SEVERITY_KIND[rec.kind] : undefined;
      if (kind !== undefined && !severities.has(kind)) severities.set(kind, rec?.severity);
    }
  }

  const extra = asRecord(root.extra_usage);
  const isUsingOverage = extra?.is_enabled === true && (num(extra.utilization) ?? 0) > 0;

  const out: RateLimitWindow[] = [];
  for (const name of CLAUDE_WINDOWS) {
    const win = asRecord(root[name]);
    if (win === null) continue;
    const utilization = num(win.utilization);
    if (utilization === null) continue;
    out.push({
      limitType: name,
      utilization: utilization / 100,
      resetsAt: toUnixSeconds(win.resets_at),
      status: claudeStatus(severities.get(name)),
      isUsingOverage,
      observedAt,
      source: 'poll',
    });
  }
  return out;
}

/**
 * A Codex window length to the limit name the UI already knows.
 *
 * Derived from the reported window rather than hard-coded per plan: today a
 * ChatGPT plan reports one weekly window and no 5-hour one, which is exactly
 * why a Codex session must not show a 5-hour row — but that is the payload's
 * business to state, not ours to assume in both directions.
 */
export function codexLimitType(windowSeconds: number): string {
  if (windowSeconds <= 6 * 3600) return 'five_hour';
  if (windowSeconds >= 6 * 24 * 3600) return 'seven_day';
  return `window_${Math.round(windowSeconds / 3600)}h`;
}

/** ChatGPT's usage payload to our window shape. */
export function parseCodexUsage(raw: unknown, observedAt: number): RateLimitWindow[] {
  const limit = asRecord(asRecord(raw)?.rate_limit);
  if (limit === null) return [];
  const status = limit.limit_reached === true ? 'rejected' : 'allowed';

  const out: RateLimitWindow[] = [];
  for (const key of ['primary_window', 'secondary_window'] as const) {
    const win = asRecord(limit[key]);
    if (win === null) continue;
    const used = num(win.used_percent);
    const seconds = num(win.limit_window_seconds);
    if (used === null || seconds === null) continue;
    out.push({
      limitType: codexLimitType(seconds),
      utilization: used / 100,
      resetsAt: toUnixSeconds(win.reset_at),
      status,
      isUsingOverage: false,
      observedAt,
      source: 'poll',
    });
  }
  return out;
}

interface CacheEntry {
  at: number;
  windows: RateLimitWindow[];
}

/**
 * Per-account quota, fetched on demand and cached briefly.
 *
 * Callers poll freely — on a spawn, at the end of a turn, whenever a client
 * asks — and the TTL is what keeps that from turning into an HTTP request per
 * event. Concurrent calls for the same account share one request.
 */
export class QuotaPoller {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<RateLimitWindow[]>>();
  /** Last warning per account, so a logged-out profile warns once a minute. */
  private readonly warnedAt = new Map<string, number>();
  private readonly deps: QuotaDeps;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(deps: QuotaDeps = {}) {
    this.deps = deps;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.now = deps.now ?? Date.now;
  }

  /**
   * This account's windows, from cache when fresh.
   *
   * Returns `[]` rather than throwing when the credential is missing, expired
   * or the network is down: quota is decoration on top of the session, and a
   * failed poll must never take a turn with it.
   */
  async windows(src: QuotaSource, opts: { force?: boolean } = {}): Promise<RateLimitWindow[]> {
    const key = src.account.key;
    const cached = this.cache.get(key);
    if (!opts.force && cached && this.now() - cached.at < this.ttlMs) return cached.windows;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const run = this.fetchFor(src)
      .then((windows) => {
        this.cache.set(key, { at: this.now(), windows });
        return windows;
      })
      .catch((err: unknown) => {
        this.warn(key, `[quota] ${key}: ${(err as Error).message}`);
        // Cache the failure too, so an offline bridge does not retry per event.
        this.cache.set(key, { at: this.now(), windows: [] });
        return [];
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, run);
    return run;
  }

  private warn(key: string, message: string): void {
    const last = this.warnedAt.get(key) ?? 0;
    if (this.now() - last < this.ttlMs) return;
    this.warnedAt.set(key, this.now());
    console.warn(message);
  }

  private async fetchFor(src: QuotaSource): Promise<RateLimitWindow[]> {
    const doFetch = this.deps.fetch ?? globalThis.fetch;
    const observedAt = this.now();

    if (src.account.agent === 'claude') {
      const token = await readClaudeAccessToken(src, this.deps);
      if (token === null) return [];
      const res = await doFetch(CLAUDE_USAGE_URL, {
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': CLAUDE_OAUTH_BETA,
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`usage endpoint returned HTTP ${res.status}`);
      return parseClaudeUsage(await res.json(), observedAt);
    }

    const auth = await readCodexAuth(src, this.deps);
    if (auth === null) return [];
    const res = await doFetch(CODEX_USAGE_URL, {
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        'content-type': 'application/json',
        ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`usage endpoint returned HTTP ${res.status}`);
    return parseCodexUsage(await res.json(), observedAt);
  }
}
