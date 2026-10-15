/**
 * Live Codex model list.
 *
 * `codex debug models` prints the catalog the CLI itself offers, as one JSON
 * object. New models show up there as soon as the binary knows about them, so
 * the picker does not carry a hardcoded generation (`gpt-5-codex`, `gpt-5`).
 *
 * The payload is large — each entry embeds instruction text — and the refresh
 * can touch the network. Callers get a few fields, cached for a few minutes.
 * A missing binary or unreadable JSON falls back to `CODEX_MODELS`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CODEX_MODELS, EFFORT_LEVELS, isValidModelId, type CliEffortLevel } from './models.js';

const execFileAsync = promisify(execFile);

/** How long a successful read is reused. The picker must not spawn the CLI on every open. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** The catalog embeds full instruction text. 8 MB was not enough on a current CLI. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/** Efforts the static list offers. `ultra` is added only when the catalog names it. */
const FALLBACK_EFFORTS: readonly CliEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const KNOWN_EFFORTS = new Set<string>(
  EFFORT_LEVELS.map((e) => e.value).filter((v) => v !== 'ultracode'),
);

export interface CodexCatalogModel {
  value: string;
  label: string;
  /** Reasoning levels this model accepts, in the CLI's order. Never includes `ultracode`. */
  efforts: CliEffortLevel[];
  /** The catalog's `default_reasoning_level`, when it is one of `efforts`. */
  defaultEffort: CliEffortLevel | null;
}

export interface CodexCatalog {
  models: CodexCatalogModel[];
  /** `cli` was parsed from `codex debug models`. `fallback` is `CODEX_MODELS`. */
  source: 'cli' | 'fallback';
}

export type CodexCatalogExec = (
  file: string,
  args: readonly string[],
  opts: { timeout: number; maxBuffer: number; encoding: 'utf8' },
) => Promise<{ stdout: string }>;

async function defaultExec(
  file: string,
  args: readonly string[],
  opts: { timeout: number; maxBuffer: number; encoding: 'utf8' },
): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(file, [...args], opts);
  return { stdout };
}

let execImpl: CodexCatalogExec = defaultExec;
let cache: { at: number; models: CodexCatalogModel[] } | null = null;
let inflight: Promise<CodexCatalogModel[]> | null = null;

/** Tests inject a fake CLI. Passing null restores the real `codex` binary and drops the cache. */
export function setCodexCatalogExecForTests(next: CodexCatalogExec | null): void {
  execImpl = next ?? defaultExec;
  cache = null;
  inflight = null;
}

function fallbackModels(): CodexCatalogModel[] {
  return CODEX_MODELS.map((m) => ({
    value: m.value,
    label: m.label,
    efforts: [...FALLBACK_EFFORTS],
    defaultEffort: null,
  }));
}

function readEffortName(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && typeof (entry as { effort?: unknown }).effort === 'string') {
    return (entry as { effort: string }).effort;
  }
  return null;
}

function readEfforts(raw: unknown): CliEffortLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: CliEffortLevel[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const name = readEffortName(entry);
    if (!name || !KNOWN_EFFORTS.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name as CliEffortLevel);
  }
  return out;
}

/**
 * Turn `codex debug models` stdout into the rows the picker shows.
 *
 * Only `visibility: "list"` is offered. `hide` entries (reserve models, the
 * auto-review model) exist in the catalog and are not choices. A slug that
 * would not survive `isValidModelId` is dropped rather than forwarded to a
 * later spawn.
 */
export function parseCodexCatalog(raw: string): CodexCatalogModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('codex debug models did not return JSON');
  }
  const models = parsed && typeof parsed === 'object' ? (parsed as { models?: unknown }).models : null;
  if (!Array.isArray(models)) throw new Error('codex debug models JSON has no models array');

  const rows: Array<CodexCatalogModel & { priority: number }> = [];
  for (const entry of models) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as {
      slug?: unknown;
      display_name?: unknown;
      visibility?: unknown;
      priority?: unknown;
      default_reasoning_level?: unknown;
      supported_reasoning_levels?: unknown;
    };
    if (row.visibility !== 'list') continue;
    if (typeof row.slug !== 'string' || !isValidModelId(row.slug)) continue;
    const label =
      typeof row.display_name === 'string' && row.display_name.trim().length > 0
        ? row.display_name.trim()
        : row.slug;
    const efforts = readEfforts(row.supported_reasoning_levels);
    const usable = efforts.length > 0 ? efforts : [...FALLBACK_EFFORTS];
    const defaultEffort =
      typeof row.default_reasoning_level === 'string' &&
      usable.includes(row.default_reasoning_level as CliEffortLevel)
        ? (row.default_reasoning_level as CliEffortLevel)
        : null;
    rows.push({
      value: row.slug,
      label,
      efforts: usable,
      defaultEffort,
      priority: typeof row.priority === 'number' && Number.isFinite(row.priority) ? row.priority : Number.POSITIVE_INFINITY,
    });
  }

  rows.sort((a, b) => a.priority - b.priority || a.value.localeCompare(b.value));
  const seen = new Set<string>();
  const out: CodexCatalogModel[] = [];
  for (const row of rows) {
    if (seen.has(row.value)) continue;
    seen.add(row.value);
    out.push({
      value: row.value,
      label: row.label,
      efforts: row.efforts,
      defaultEffort: row.defaultEffort,
    });
  }
  return out;
}

async function loadFromCli(): Promise<CodexCatalogModel[]> {
  const { stdout } = await execImpl('codex', ['debug', 'models'], {
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    encoding: 'utf8',
  });
  return parseCodexCatalog(stdout);
}

/**
 * Visible Codex models, highest priority first.
 *
 * One in-flight read is shared. A successful read is reused for `CACHE_TTL_MS`.
 * A failure is not cached, so the next request tries the CLI again, and the
 * caller still gets the built-in list immediately.
 */
export async function listCodexModels(): Promise<CodexCatalog> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return cache.models.length > 0
      ? { models: cache.models, source: 'cli' }
      : { models: fallbackModels(), source: 'fallback' };
  }
  if (!inflight) {
    inflight = loadFromCli()
      .then((models) => {
        cache = { at: Date.now(), models };
        return models;
      })
      .finally(() => {
        inflight = null;
      });
  }
  try {
    const models = await inflight;
    if (models.length === 0) return { models: fallbackModels(), source: 'fallback' };
    return { models, source: 'cli' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[codex-catalog] codex debug models failed; using the built-in list: ${message}`);
    return { models: fallbackModels(), source: 'fallback' };
  }
}
