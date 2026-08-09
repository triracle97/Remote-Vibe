import type { ToolCallMessage, ViewMessage } from './projection';

/**
 * Background shells and monitors the agent still has open.
 *
 * Inferred from the transcript, because that is all the bridge gets — the CLI
 * reports tool calls, not a live inventory of its own child processes. The two
 * cases need different rules:
 *
 * - **Monitor** blocks for as long as it is watching, so its tool call is still
 *   `running` and the projection already knows.
 * - **A background Bash returns immediately**, handing back a shell id while the
 *   shell keeps going. Its tool call reads `ok` within a second, so counting
 *   `running` calls would always report zero. Instead a shell is opened by the
 *   `Bash` call and closed only when something later says so: a `KillShell`
 *   aimed at it, or a `BashOutput` that reports it finished.
 *
 * The consequence worth knowing: a shell that exits on its own and is never
 * polled again stays counted. The alternative — not showing background work at
 * all — is worse, and a stale count corrects itself the moment the agent checks
 * on the shell.
 */

export interface RunningWork {
  shells: number;
  monitors: number;
  /**
   * Subagents still working — `Task` calls that have not returned.
   *
   * Unlike a background shell these are read straight off the call's status,
   * because a subagent *is* the tool call: it holds it open for as long as it
   * runs. Worth its own count because it is the one kind of background work
   * that can be spending money in five places at once.
   */
  subagents: number;
  /** Workflow orchestrations in flight — each may be running many agents. */
  workflows: number;
}

export const NO_RUNNING_WORK: RunningWork = {
  shells: 0,
  monitors: 0,
  subagents: 0,
  workflows: 0,
};

/** Tools whose call stays open for the whole life of the agent it started. */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/** Pull the first string-valued key present, across the spellings seen in the wild. */
function pickString(source: unknown, keys: readonly string[]): string | null {
  const rec = asRecord(source);
  if (!rec) return null;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

const SHELL_ID_KEYS = ['shell_id', 'shellId', 'bash_id', 'bashId', 'id'] as const;

function isBackgroundBash(call: ToolCallMessage): boolean {
  if (call.toolName !== 'Bash') return false;
  const input = asRecord(call.input);
  return input?.run_in_background === true || input?.runInBackground === true;
}

/**
 * Whether a `BashOutput` result says the shell is finished.
 *
 * Tolerant on purpose: the payload shape is the CLI's, not ours, and a missed
 * "completed" only leaves the count one too high.
 */
function reportsCompletion(output: unknown): boolean {
  const rec = asRecord(output);
  if (rec) {
    const status = rec.status;
    if (typeof status === 'string' && /^(completed|failed|killed|exited)$/i.test(status)) {
      return true;
    }
    if (typeof rec.exitCode === 'number' || typeof rec.exit_code === 'number') return true;
  }
  const text =
    typeof output === 'string' ? output : rec && typeof rec.output === 'string' ? rec.output : null;
  if (text) return /<status>\s*(completed|failed|killed)\s*<\/status>/i.test(text);
  return false;
}

/** Count what is still open, walking the transcript in order. */
export function runningWork(messages: readonly ViewMessage[]): RunningWork {
  const openShells = new Set<string>();
  let monitors = 0;
  let subagents = 0;
  let workflows = 0;

  for (const m of messages) {
    if (m.kind !== 'tool_call') continue;
    const call = m;

    if (call.toolName === 'Monitor') {
      if (call.status === 'running') monitors += 1;
      continue;
    }

    if (SUBAGENT_TOOLS.has(call.toolName)) {
      if (call.status === 'running') subagents += 1;
      continue;
    }

    if (call.toolName === 'Workflow') {
      if (call.status === 'running') workflows += 1;
      continue;
    }

    if (isBackgroundBash(call)) {
      // The shell id comes back in the result; until it does, key off the tool
      // use id so a shell that has only just started is still counted.
      const id = pickString(call.output, SHELL_ID_KEYS) ?? call.toolUseId;
      // A background Bash that errored never produced a shell.
      if (call.status !== 'error') openShells.add(id);
      continue;
    }

    if (call.toolName === 'KillShell') {
      const id = pickString(call.input, SHELL_ID_KEYS);
      if (id) openShells.delete(id);
      continue;
    }

    if (call.toolName === 'BashOutput') {
      const id = pickString(call.input, SHELL_ID_KEYS);
      if (id && reportsCompletion(call.output)) openShells.delete(id);
      continue;
    }
  }

  return { shells: openShells.size, monitors, subagents, workflows };
}
