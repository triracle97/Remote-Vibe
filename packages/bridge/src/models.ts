/**
 * Model and reasoning-effort catalogue.
 *
 * Both levers are verified against the installed CLIs rather than inferred:
 *
 *   claude --model <alias|full-id>   aliases: opus | sonnet | haiku | fable
 *   claude --effort <level>          low | medium | high | xhigh | max
 *   codex  --model <id>
 *   codex  -c model_reasoning_effort=<level>
 *
 * Shape follows nimbalyst's `packages/runtime/src/ai/server/effortLevels.ts`.
 * Only aliases are offered for Claude: an alias always resolves to the latest
 * model on its line, so the list never goes stale as new versions ship.
 */

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode';

/** What may actually go on `claude --effort` / `codex -c model_reasoning_effort`. */
export type CliEffortLevel = Exclude<EffortLevel, 'ultracode'>;

export const EFFORT_LEVELS: ReadonlyArray<{
  value: EffortLevel;
  label: string;
  /** Claude only, and only on a model that can do xhigh. */
  claudeOnly?: boolean;
}> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'xHigh' },
  { value: 'max', label: 'Max' },
  { value: 'ultracode', label: 'Ultracode', claudeOnly: true },
] as const;

/**
 * Ultracode is a *mode*, not a level, and sits in this list because that is
 * where Claude Code itself puts it — `/config` offers it as one more choice in
 * the effort row.
 *
 * What the CLI actually wants is two things at once: `--effort xhigh` and a
 * session settings file carrying `{"ultracode": true}`. The CLI describes the
 * key as "xhigh effort plus standing dynamic-workflow orchestration", and it
 * refuses the mode without workflows enabled and an xhigh-capable model.
 *
 * `--effort ultracode` is accepted as an alias for `xhigh` and does *not* turn
 * the mode on, so passing the user's pick straight through would silently give
 * them an expensive session with none of the behaviour they asked for.
 */
export function isUltracode(effort: EffortLevel | null | undefined): boolean {
  return effort === 'ultracode';
}

/** The value for the CLI flag. Ultracode runs at xhigh; everything else is itself. */
export function cliEffortLevel(effort: EffortLevel): CliEffortLevel {
  return effort === 'ultracode' ? 'xhigh' : effort;
}

/**
 * Whether a model can run ultracode at all.
 *
 * The CLI names Fable 5, Opus 4.7+ and Sonnet 5 as xhigh-capable. Of the
 * aliases this app offers only Haiku is out, and an alias always resolves to
 * the newest model on its line — so the check is "not Haiku" rather than a
 * version table that would go stale on the next release. A null model means
 * the CLI's own default, which is on a capable line; if that ever changes the
 * CLI rejects the mode itself and says which models qualify.
 */
export function supportsUltracode(model: string | null | undefined): boolean {
  if (!model) return true;
  return !/haiku/i.test(model);
}

/** The CLI's own default. Only used to label the UI, never sent as a flag. */
export const DEFAULT_EFFORT_LEVEL: EffortLevel = 'high';

const VALID_EFFORT = new Set<string>(EFFORT_LEVELS.map((e) => e.value));

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && VALID_EFFORT.has(v);
}

/** Parse to a valid level, or null when the value is absent or unknown. */
export function parseEffortLevel(v: unknown): EffortLevel | null {
  return isEffortLevel(v) ? v : null;
}

export const CLAUDE_MODELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'fable', label: 'Fable' },
] as const;

export const CODEX_MODELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { value: 'gpt-5', label: 'GPT-5' },
] as const;

export function modelsFor(agent: 'claude' | 'codex'): ReadonlyArray<{
  value: string;
  label: string;
}> {
  return agent === 'claude' ? CLAUDE_MODELS : CODEX_MODELS;
}

/**
 * Model ids reach a shell command line (Claude) and an argv slot (Codex), so
 * they get the same treatment as every other interpolated value: a strict
 * allowlist rather than an escape pass. `[1m]` is permitted because that is
 * how the CLI spells an extended-context variant (`opus[1m]`).
 */
const MODEL_RE = /^[A-Za-z0-9_.[\]-]{1,64}$/;

export function isValidModelId(v: unknown): v is string {
  return typeof v === 'string' && MODEL_RE.test(v);
}

/** Parse to a shell-safe model id, or null when absent or malformed. */
export function parseModelId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  return isValidModelId(trimmed) ? trimmed : null;
}

/**
 * Resolve the value a session should actually run with.
 *
 * An explicit per-session pick wins; otherwise the app-wide default applies.
 * Returns null when neither is set, which means "omit the flag and leave the
 * CLI on its own default" — never a guessed value.
 *
 * Callers must persist what this returns, not the raw per-session field.
 * Nimbalyst shipped that bug (their #546): the selector displayed the app
 * default while the session silently ran on the CLI's built-in one, because
 * the default was never written into session metadata.
 */
export function resolveSetting<T>(sessionValue: T | null | undefined, appDefault: T | null | undefined): T | null {
  if (sessionValue !== null && sessionValue !== undefined) return sessionValue;
  return appDefault ?? null;
}

/** Human label for a model id, falling back to the id itself. */
export function modelLabel(agent: 'claude' | 'codex', value: string): string {
  return modelsFor(agent).find((m) => m.value === value)?.label ?? value;
}
