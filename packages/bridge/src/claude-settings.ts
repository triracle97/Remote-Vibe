import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Per-session `--settings` files for Claude.
 *
 * The only supported way to turn ultracode on for a non-interactive session:
 * the CLI describes the key as "Session-scoped — typically provided via
 * `--settings` or the `apply_flag_settings` control request; interactive
 * toggles never persist it". There is no flag, and writing it into the user's
 * own `settings.json` would leak a per-session choice into every session that
 * profile ever runs — including the ones started from a terminal.
 *
 * A file rather than the inline-JSON form `--settings` also accepts, for the
 * same reason `--mcp-config` gets one: everything interpolated into the
 * `zsh -lic` spawn line goes through `assertResumeArgSafe`, which rejects
 * braces and quotes. A path of `[A-Za-z0-9_./-]` passes; `{"ultracode":true}`
 * never would.
 *
 * These live under the bridge's data dir and are rewritten on every spawn, so
 * a session that changes mode picks the new value up on its next resume.
 */

/**
 * Advisory ceiling on the agent fleet a dynamic workflow may write.
 *
 * The CLI's own wording: "small" aims for fewer than 5 agents, "medium" (the
 * default) fewer than 15, "large" fewer than 50, and "unrestricted" sends no
 * guideline at all. It is a guideline in the prompt, not an enforced cap — but
 * it is the only lever between "a workflow" and "fifty agents", which makes it
 * the one knob worth surfacing next to the mode itself.
 */
export type WorkflowSize = 'unrestricted' | 'small' | 'medium' | 'large';

const WORKFLOW_SIZES: ReadonlySet<string> = new Set([
  'unrestricted',
  'small',
  'medium',
  'large',
]);

export function isWorkflowSize(v: unknown): v is WorkflowSize {
  return typeof v === 'string' && WORKFLOW_SIZES.has(v);
}

/** Parse to a valid size, or null when absent or unknown. */
export function parseWorkflowSize(v: unknown): WorkflowSize | null {
  return isWorkflowSize(v) ? v : null;
}

export interface ClaudeSessionSettings {
  /** xhigh effort plus standing dynamic-workflow orchestration. */
  ultracode?: boolean;
  /** Ultracode refuses to start without this. */
  enableWorkflows?: boolean;
  workflowSizeGuideline?: WorkflowSize;
  /**
   * Whether typing `ultracode` in a prompt opts that one turn into
   * orchestration. Independent of the mode: someone who leaves the mode off
   * may still want the keyword, and someone running the mode may want the
   * keyword off so it cannot be triggered by quoted text.
   */
  workflowKeywordTriggerEnabled?: boolean;
}

/** Nothing to write when every field is absent. */
export function hasSettings(s: ClaudeSessionSettings): boolean {
  return Object.values(s).some((v) => v !== undefined);
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export class ClaudeSettingsWriter {
  private readonly dir: string;
  private ensured = false;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'claude-settings');
  }

  /**
   * Write one session's settings and return the absolute path.
   *
   * Returns null when there is nothing to say, and also when the write fails:
   * a session that starts without its settings file is a working session on
   * the CLI's defaults, which beats refusing to start at all. The caller logs
   * the downgrade — silently dropping the mode the user picked would be the
   * same bug as a card claiming a model the CLI never got.
   */
  async write(webSessionId: string, settings: ClaudeSessionSettings): Promise<string | null> {
    if (!hasSettings(settings)) return null;
    try {
      if (!this.ensured) {
        await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
        this.ensured = true;
      }
      const path = join(this.dir, `${webSessionId}.json`);
      await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: FILE_MODE });
      return path;
    } catch (err) {
      console.warn('[claude-settings] could not write session settings:', err);
      return null;
    }
  }
}
