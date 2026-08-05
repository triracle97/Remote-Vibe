import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';

/**
 * Names a session by asking an agent to title it.
 *
 * The alternative — slicing the user's first prompt — produces cards like
 * "Read /tmp/handoff-lazy-background-digest-seeding.md and cont". A one-shot
 * call after the first turn sees both the ask *and* what the agent actually
 * did, so it can say "seed background digests lazily" instead.
 *
 * Deliberately a separate process from the session:
 *  - it cannot pollute the session's conversation or transcript,
 *  - it works the same for Codex sessions, whose driver spawns per turn,
 *  - a failure loses the title, not the session.
 *
 * Runs on Haiku, which is a $1/MTok model — one call is roughly 500 input and
 * 15 output tokens, so a session costs well under a tenth of a cent to name.
 */

const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_TIMEOUT_MS = 30_000;
/** Enough for the agent to show what it did; not enough to matter for cost. */
const REPLY_BUDGET_CHARS = 600;
const PROMPT_BUDGET_CHARS = 600;
const MAX_TITLE_LEN = 60;

export type TitlerSpawn = (
  cmd: string,
  args: string[],
  options: SpawnOptions,
) => import('node:child_process').ChildProcess;

export interface TitlerOpts {
  enabled: boolean;
  model: string;
  /** Injectable for tests. */
  spawn?: TitlerSpawn;
  timeoutMs?: number;
}

export interface TitleRequest {
  firstPrompt: string;
  /** Agent's reply to that prompt. May be empty if the turn produced no text. */
  firstReply: string;
  /** cwd for the titler process; keeps any project-local config applicable. */
  projectPath: string;
  /** CLAUDE_CONFIG_DIR to run under, so auth matches the session's. */
  claudeConfigDir?: string | undefined;
}

function buildPrompt(req: TitleRequest): string {
  return [
    'Title this coding session in 3 to 6 words.',
    'Reply with the title only: no quotes, no punctuation at the end, no preamble.',
    'Describe the work, not the conversation ("fix auth token expiry", not "user asked about auth").',
    '',
    `Request: ${clamp(req.firstPrompt, PROMPT_BUDGET_CHARS)}`,
    '',
    `Agent reply: ${clamp(req.firstReply, REPLY_BUDGET_CHARS)}`,
  ].join('\n');
}

function clamp(s: string, n: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length > n ? `${collapsed.slice(0, n)}…` : collapsed;
}

/**
 * Clean up whatever the model returned.
 *
 * Models sometimes wrap a title in quotes, prefix it with "Title:", or emit a
 * short explanation on a second line. Take the first non-empty line and strip
 * the usual decoration rather than rejecting an otherwise-good answer.
 */
export function sanitizeTitle(raw: string): string | null {
  const firstLine = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (firstLine === undefined) return null;

  const cleaned = firstLine
    .replace(/^(?:title|session)\s*[:\-—]\s*/i, '')
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .replace(/[.。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length === 0) return null;
  // A paragraph means the model ignored the instruction; a raw-prompt slice
  // beats a wall of text on a card.
  if (cleaned.length > 200) return null;
  if (/[\x00-\x1f]/.test(cleaned)) return null;
  return cleaned.slice(0, MAX_TITLE_LEN).trim();
}

export class SessionTitler {
  readonly enabled: boolean;
  private readonly model: string;
  private readonly spawnFn: TitlerSpawn;
  private readonly timeoutMs: number;

  constructor(opts: TitlerOpts) {
    this.enabled = opts.enabled;
    this.model = opts.model;
    this.spawnFn = opts.spawn ?? (nodeSpawn as TitlerSpawn);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Returns a title, or null if titling failed for any reason.
   *
   * Never throws and never rejects: a session keeps its prompt-derived name
   * when this doesn't work out.
   */
  async title(req: TitleRequest): Promise<string | null> {
    if (!this.enabled) return null;
    if (req.firstPrompt.trim().length === 0) return null;

    const prompt = buildPrompt(req);
    return new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      let child: import('node:child_process').ChildProcess;
      try {
        // `-p` with no --output-format gives plain text on stdout, which is
        // all a title needs. Spawned through a login shell for the same
        // PATH reasons as the session driver.
        child = this.spawnFn(
          'zsh',
          ['-lc', `exec claude -p --model ${this.model}`],
          {
            cwd: req.projectPath,
            env: {
              ...process.env,
              ...(req.claudeConfigDir !== undefined
                ? { CLAUDE_CONFIG_DIR: req.claudeConfigDir }
                : {}),
            },
            stdio: ['pipe', 'pipe', 'ignore'],
            detached: true,
          },
        );
      } catch (err) {
        console.warn('[titler] spawn failed:', (err as Error).message);
        return finish(null);
      }

      const timer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        console.warn('[titler] timed out');
        finish(null);
      }, this.timeoutMs);
      timer.unref?.();

      let out = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        // Bound the buffer: a runaway reply must not grow without limit.
        if (out.length < 4096) out += chunk;
      });
      child.on('error', (err: Error) => {
        console.warn('[titler] failed:', err.message);
        finish(null);
      });
      child.on('exit', (code) => {
        if (code !== 0) {
          console.warn(`[titler] exited with code ${code ?? '?'}`);
          return finish(null);
        }
        finish(sanitizeTitle(out));
      });

      child.stdin?.on('error', () => {});
      child.stdin?.end(prompt);
    });
  }
}

export function titlerConfigFromEnv(env: Record<string, string | undefined>): {
  enabled: boolean;
  model: string;
} {
  const raw = env.BRIDGE_TITLER_ENABLED;
  const enabled = raw === undefined ? true : /^(1|true|yes|on)$/i.test(raw.trim());
  const model = env.BRIDGE_TITLER_MODEL?.trim() || DEFAULT_MODEL;
  if (!/^[A-Za-z0-9_.-]+$/.test(model)) {
    throw new Error('BRIDGE_TITLER_MODEL contains unsupported characters');
  }
  return { enabled, model };
}
