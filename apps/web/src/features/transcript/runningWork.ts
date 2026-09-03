import type { ToolCallMessage, ViewMessage } from './projection';

/**
 * Background work the session still has open — shells, monitors, subagents.
 *
 * Inferred from the transcript, because that is all the bridge gets: the CLI
 * reports tool calls, not a live inventory of its own children. Two rules,
 * because two shapes:
 *
 * - **A call that stays open for the life of the work.** `Monitor` blocks while
 *   it watches; a foreground subagent *is* its `Task` call. The projection
 *   already knows these are `running`, so counting them is enough — and the
 *   projection closes anything left open by a `result` or a `session_ended`,
 *   so a turn that was interrupted does not leave phantoms behind. An async
 *   agent's call returns at once, so for agents the projection's
 *   `subagentRunning` is read instead: it follows the agent, not the call.
 * - **A call that returns immediately and leaves something behind.** A
 *   background `Bash` hands back a shell id and reads `ok` within a second, so
 *   counting `running` calls would always report zero. Its shell is opened by
 *   the `Bash` and closed only when something later says so: a `KillShell`
 *   aimed at it, or a `BashOutput` reporting it finished.
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
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent', '(subagent)']);

/**
 * Whether a delegating call still has an agent working under it.
 *
 * The call's own status is enough for a foreground agent. An async agent's
 * `Task` returns "launched" immediately and reads `ok` for the whole time the
 * agent works, so the projection's per-agent flag is what actually answers.
 */
function agentLive(call: ToolCallMessage): boolean {
  return call.status === 'running' || call.subagentRunning === true;
}

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

/**
 * A shell id quoted inside prose.
 *
 * `Bash(run_in_background)` hands its id back as human-readable text, not as a
 * field, so the structured lookup finds nothing and the shell gets keyed by its
 * tool-use id instead. The `BashOutput` that later reports it finished refers
 * to the *real* id, matches nothing, and the shell is counted forever — the
 * single biggest source of a background count that only ever goes up.
 */
// The separator between the label and the value is spelled as "anything an id
// cannot contain": a greedy `\D` run would eat the `bash_` off the front of
// `bash_7` and capture `sh_7`.
const SHELL_ID_IN_TEXT = /(?:shell|bash)[ _]?id[^A-Za-z0-9_-]{0,4}([A-Za-z0-9_-]+)|\b(bash_\d+)\b/i;

/** Structured field first, then the same id quoted in prose. */
function shellIdOf(source: unknown): string | null {
  const structured = pickString(source, SHELL_ID_KEYS);
  if (structured !== null) return structured;
  const rec = asRecord(source);
  const text =
    typeof source === 'string' ? source : rec && typeof rec.output === 'string' ? rec.output : null;
  if (text === null) return null;
  const m = SHELL_ID_IN_TEXT.exec(text);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function isBackgroundBash(call: ToolCallMessage): boolean {
  if (call.toolName !== 'Bash') return false;
  const input = asRecord(call.input);
  return input?.run_in_background === true || input?.runInBackground === true;
}

/**
 * Every tool call in the transcript, subagents included, in the order they ran.
 *
 * Nesting subagent output under the call that started it took their work out of
 * the flat list this used to walk, so a shell or a monitor opened by a
 * delegated agent stopped being counted at all. Background work is background
 * work whoever started it — and shell ids are session-wide, so a subagent's
 * `BashOutput` has to be able to close a shell the main agent opened.
 *
 * Depth-first with the parent before its children, which is the order they
 * happened: a subagent runs entirely inside the call that started it.
 */
function* everyCall(messages: readonly ViewMessage[]): Generator<ToolCallMessage> {
  for (const m of messages) {
    if (m.kind !== 'tool_call') continue;
    yield m;
    if (m.subagent !== undefined) yield* everyCall(m.subagent);
  }
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

  for (const call of everyCall(messages)) {
    if (call.toolName === 'Monitor') {
      if (call.status === 'running') monitors += 1;
      continue;
    }

    if (SUBAGENT_TOOLS.has(call.toolName)) {
      if (agentLive(call)) subagents += 1;
      continue;
    }

    if (call.toolName === 'Workflow') {
      if (agentLive(call)) workflows += 1;
      continue;
    }

    if (isBackgroundBash(call)) {
      // The shell id comes back in the result; until it does, key off the tool
      // use id so a shell that has only just started is still counted.
      const id = shellIdOf(call.output) ?? call.toolUseId;
      // A background Bash that errored never produced a shell.
      if (call.status !== 'error') openShells.add(id);
      continue;
    }

    if (call.toolName === 'KillShell') {
      const id = shellIdOf(call.input);
      if (id) openShells.delete(id);
      continue;
    }

    if (call.toolName === 'BashOutput') {
      const id = shellIdOf(call.input);
      if (id && reportsCompletion(call.output)) openShells.delete(id);
      continue;
    }
  }

  return { shells: openShells.size, monitors, subagents, workflows };
}
