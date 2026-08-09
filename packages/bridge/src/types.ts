import type { EffortLevel } from './models.js';
import type { WorkflowSize } from './claude-settings.js';

export type { EffortLevel, WorkflowSize };

export type AgentKind = 'claude' | 'codex';

/**
 * Where a session sits in the work it is doing. Columns on the board, in order.
 * Automatic inference only ever moves a session *forward* through this list;
 * moving backwards requires a manual drag (which also pins the phase) or an
 * explicit agent directive.
 *
 * `investigating` precedes `planning` because that is the real order: you find
 * out what is going on, then decide what to do about it. Research-only work
 * runs `backlog -> investigating -> done` and never claims a build phase it
 * never entered.
 */
export type SessionPhase =
  | 'backlog'
  | 'investigating'
  | 'planning'
  | 'implementing'
  | 'verifying'
  | 'done';

export const SESSION_PHASES: readonly SessionPhase[] = [
  'backlog',
  'investigating',
  'planning',
  'implementing',
  'verifying',
  'done',
] as const;

/** Freshly spawned sessions start here — they have work but no plan yet. */
export const DEFAULT_SESSION_PHASE: SessionPhase = 'planning';

export function phaseRank(phase: SessionPhase): number {
  return SESSION_PHASES.indexOf(phase);
}

export function isSessionPhase(v: unknown): v is SessionPhase {
  return typeof v === 'string' && (SESSION_PHASES as readonly string[]).includes(v);
}

/**
 * `live` — a driver process is attached right now.
 * `ended` — the process exited; the transcript is still readable and the
 *           session may be resumable via its CLI session id.
 */
export type SessionLifecycleStatus = 'live' | 'ended';

export interface ClientStartMsg {
  type: 'start';
  agent: AgentKind;
  /** Phase 1-5: single working dir. Still supported for backward compat. */
  projectPath?: string;
  /** Phase 6: multiple working dirs (first = primary cwd). If both `dirs` and `projectPath` present, `dirs` wins. */
  dirs?: string[];
  account?: string;
  /** Phase 8: named CLAUDE_CONFIG_DIR profile (claude only). */
  claudeConfig?: string;
  /** Model alias or id. Omitted leaves the CLI's own default. */
  model?: string;
  /** Reasoning effort. Omitted leaves the CLI's own default. */
  effort?: EffortLevel;
  /**
   * Workflow settings for a Claude session. Only reach the CLI when something
   * turns workflows on — `effort: 'ultracode'`, or one of these being set.
   */
  workflowSize?: WorkflowSize;
  workflowKeywordTrigger?: boolean;
  sessionId?: string;
  resume?: boolean;
  correlationId?: string;
}

export interface ClientInputMsg {
  type: 'input';
  sessionId: string;
  text: string;
  images?: Array<{ mime: string; base64: string }>;
  correlationId?: string;
}

export interface ClientStopMsg {
  type: 'stop_session';
  sessionId: string;
  correlationId?: string;
}

/**
 * Stop the turn in flight but keep the session. `stop_session` ends it; this is
 * the Esc key, not the power switch.
 */
export interface ClientInterruptMsg {
  type: 'interrupt_session';
  sessionId: string;
  correlationId?: string;
}

export interface ClientListSessionsMsg {
  type: 'list_sessions';
  correlationId?: string;
}

export interface ClientGetHistoryMsg {
  type: 'get_history';
  sessionId: string;
  since?: number;
  correlationId?: string;
}

export interface ClientListAccountsMsg {
  type: 'list_accounts';
  correlationId?: string;
}

/** Add or repoint a named CLAUDE_CONFIG_DIR profile. */
export interface ClientSaveClaudeConfigMsg {
  type: 'save_claude_config';
  name: string;
  /** Absolute path; a leading `~` is expanded by the bridge. */
  configDir: string;
  correlationId?: string;
}

export interface ClientDeleteClaudeConfigMsg {
  type: 'delete_claude_config';
  name: string;
  correlationId?: string;
}

export interface ClientListPromptsMsg {
  type: 'list_prompts';
  query?: string;
  limit?: number;
  correlationId?: string;
}

export interface ClientListDirsMsg {
  type: 'list_dirs';
  path: string;
  correlationId?: string;
}

export interface ClientReadFileMsg {
  type: 'read_file';
  path: string;
  correlationId?: string;
}

export interface ClientWriteFileMsg {
  type: 'write_file';
  path: string;
  content: string;
  /**
   * Hash the client got from `file_result`. Present = optimistic-concurrency
   * check; the write is refused with `file_conflict` if the file changed since.
   * Absent = force overwrite (used after the user confirms a conflict).
   */
  baseHash?: string;
  correlationId?: string;
}

export type ClientMsg =
  | ClientStartMsg
  | ClientInputMsg
  | ClientStopMsg
  | ClientInterruptMsg
  | ClientListSessionsMsg
  | ClientGetHistoryMsg
  | ClientListAccountsMsg
  | ClientSaveClaudeConfigMsg
  | ClientDeleteClaudeConfigMsg
  | ClientListPromptsMsg
  | ClientListDirsMsg
  | ClientReadFileMsg
  | ClientWriteFileMsg
  | ClientListHistoryMsg
  | ClientResumeSessionMsg
  | ClientListProfilesMsg
  | ClientSaveProfileMsg
  | ClientDeleteProfileMsg
  | ClientSetDefaultProfileMsg
  | ClientListSlashCommandsMsg
  | ClientSearchFilesMsg
  | ClientGetClipboardPathsMsg
  | ClientRenameSessionMsg
  | ClientTermStartMsg
  | ClientTermInputMsg
  | ClientTermResizeMsg
  | ClientTermKillMsg
  | ClientListAllSessionsMsg
  | ClientSetSessionModelMsg
  | ClientSetSessionPhaseMsg
  | ClientSetSessionTagsMsg
  | ClientArchiveSessionMsg
  | ClientDeleteSessionMsg
  | ClientListJobsMsg
  | ClientCreateJobMsg
  | ClientUpdateJobMsg
  | ClientDeleteJobMsg
  | ClientStartJobMsg
  | ClientGetRateLimitsMsg;

/** Token accounting for one turn, straight off the CLI's `result` line. */
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** Running totals for one session. Persisted, so they survive a restart. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** USD, as reported by the CLI. */
  costUsd: number;
  /** Completed turns — the divisor for any per-turn average. */
  turns: number;
  /**
   * How full the context window is right now, in tokens.
   *
   * This is a *level*, not a total: the input side of the most recent turn
   * (fresh input + cache reads + cache writes), which is exactly what the model
   * had to read. Every other field here accumulates across the session, so
   * `inputTokens` answers "what did this conversation cost" while this answers
   * "how much room is left before it compacts" — different questions with very
   * different numbers.
   *
   * Zero until the first turn reports usage.
   */
  contextTokens: number;
}

export const EMPTY_SESSION_USAGE: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  turns: 0,
  contextTokens: 0,
};

/** The input side of one turn — what the model actually had to read. */
export function turnContextTokens(usage: TurnUsage | undefined): number {
  if (!usage) return 0;
  return (
    (usage.inputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheCreationTokens ?? 0)
  );
}

/**
 * A quota window reported by the CLI's `rate_limit_event`.
 *
 * This is the same data nimbalyst polls from `api.anthropic.com/api/oauth/usage`,
 * except the CLI hands it to us mid-stream — no credential read, no extra
 * request, and it is already scoped to whichever account the session runs as.
 */
export interface RateLimitWindow {
  /** e.g. `five_hour`, `seven_day`, `seven_day_opus`. */
  limitType: string;
  /**
   * Fraction 0..1, NOT a percentage — and null when the CLI did not say.
   *
   * The number only appears once the window crosses its warning threshold; a
   * healthy window reports `status: allowed` and no figure at all. Null
   * therefore means "known to be below the warning threshold", which is not
   * the same as zero and must not be rendered as one.
   */
  utilization: number | null;
  /** Unix seconds when the window resets, or null if not reported. */
  resetsAt: number | null;
  /** e.g. `allowed`, `allowed_warning`, `rejected`. */
  status: string | null;
  isUsingOverage: boolean;
  /** ms since epoch when this bridge observed it. */
  observedAt: number;
}

/**
 * Whose quota a window describes.
 *
 * Quota is per credential, and one bridge routinely drives several: a session
 * on `~/.claude` and one on `~/.claude1` are two different plans with two
 * different 5-hour windows. Keying the windows by `limitType` alone let the
 * newest turn overwrite the other account's figure, so the ring showed one
 * number that belonged to whichever session happened to speak last.
 */
export interface RateLimitAccount {
  /** Stable identity, e.g. `claude:default` — what the windows are keyed by. */
  key: string;
  /** What to call it in the UI: the Claude profile / Codex account name. */
  label: string;
  agent: AgentKind;
  /** Resolved CLAUDE_CONFIG_DIR, for the tooltip. Null for Codex. */
  configDir: string | null;
}

/** A quota window with the credential it belongs to attached. */
export interface AccountRateLimitWindow extends RateLimitWindow {
  account: RateLimitAccount;
}

/**
 * Set on any event a subagent produced, naming the tool call that started it.
 *
 * Everything the CLI forwards under `--forward-subagent-text` arrives on the
 * same channel as the main agent's own output, so without this the transcript
 * would interleave five agents into one voice.
 */
export interface SubagentOrigin {
  parentToolUseId?: string;
}

export type AgentEvent =
  | ({ kind: 'assistant_text'; text: string } & SubagentOrigin)
  | ({ kind: 'stream_delta'; delta: string } & SubagentOrigin)
  /** Extended-thinking block. Rendered collapsed; never fed back to the model. */
  | ({ kind: 'thinking'; text: string } & SubagentOrigin)
  | ({ kind: 'tool_use'; toolUseId: string; toolName: string; input: unknown } & SubagentOrigin)
  | ({
      kind: 'tool_result';
      toolUseId: string;
      output: unknown;
      isError?: boolean;
    } & SubagentOrigin)
  /** Quota window update. Carries no conversation content. */
  | { kind: 'rate_limit'; window: RateLimitWindow }
  | {
      kind: 'result';
      cost?: number;
      durationMs?: number;
      error?: string;
      usage?: TurnUsage;
      model?: string;
    };

export interface ServerInitMsg {
  type: 'system';
  event: 'init';
  /** Optional capability flags. Absence ≡ all caps false. */
  capabilities?: { terminal: boolean };
  /**
   * Directories the bridge will spawn inside (`BRIDGE_ALLOWED_DIRS`).
   *
   * Sent so the client can offer real project suggestions by listing these,
   * instead of shipping a hard-coded sample list that is wrong for everyone
   * but its author.
   */
  allowedDirs?: string[];
}

export interface ServerLifecycleMsg {
  type: 'system';
  event: 'session_created' | 'session_ended';
  sessionId: string;
  seq: number;
  agent?: AgentKind;
  projectPath?: string;
  createdAt?: number;
  account?: string;
  correlationId?: string;
  reason?: string;
  exitCode?: number;
}

export interface ServerStreamMsg {
  type: 'assistant' | 'stream_delta' | 'tool_result' | 'result' | 'status' | 'user';
  sessionId: string;
  seq: number;
  payload: unknown;
  /**
   * Present when this came from a subagent rather than the session's own
   * agent, naming the tool call that started it — a `Task`, or a `Workflow`
   * whose script spawned it.
   *
   * The CLI only emits these under `--forward-subagent-text`. Without it a
   * subagent is a single tool call that goes quiet for minutes; with it, the
   * work streams, and this field is what stops it reading as the main agent
   * suddenly talking about somebody else's task.
   */
  parentToolUseId?: string;
}

export interface ServerSessionListMsg {
  type: 'session_list';
  sessions: Array<{
    sessionId: string;
    agent: AgentKind;
    projectPath: string;
    createdAt: number;
    account?: string;
    /**
     * Joined from the registry. Without this the web client loses the session
     * name on every page reload, since `session_renamed` only fires on change.
     */
    name?: string | null;
  }>;
  correlationId?: string;
}

// Phase 8 — board. The registry outlives the process, so the board needs a
// view that spans dead sessions too; `session_list` stays live-only for the
// existing session UI.

/** One board card: a registry entry, enriched with live state. */
export interface BoardSession {
  sessionId: string;
  agent: AgentKind;
  projectPath: string;
  additionalDirs: string[];
  createdAt: number;
  lastActiveAt: number;
  endedAt: number | null;
  name: string | null;
  /** True once renamed by hand; automatic naming leaves it alone. */
  namePinned: boolean;
  status: SessionLifecycleStatus;
  /** True iff a driver is attached in this bridge process right now. */
  alive: boolean;
  /**
   * True iff a turn is open — a `user` message with no `result` after it.
   *
   * `alive` only says a process is attached; it stays true for the whole time
   * the agent sits idle waiting on the human, which is most of a session's
   * life. The board needs the two apart to tell "still working" from "your
   * turn". Always false for a session with no driver.
   */
  turnRunning: boolean;
  phase: SessionPhase;
  phasePinned: boolean;
  tags: string[];
  archived: boolean;
  account: string | null;
  claudeConfigDir: string | null;
  headroom: boolean;
  /** True when the CLI session id is known, so `resume_session` can work. */
  resumable: boolean;
  /** Running token/cost totals for this session. */
  usage: SessionUsage;
  /** Resolved model/effort, or null meaning the CLI's own default. */
  model: string | null;
  effort: EffortLevel | null;
  /** Resolved workflow settings, or null meaning the CLI's own default. */
  workflowSize: WorkflowSize | null;
  workflowKeywordTrigger: boolean | null;
  /** The session that spawned this one via `spawn_session`, else null. */
  parentSessionId: string | null;
  /** Parent's display name, resolved server-side so the card need not join. */
  parentName: string | null;
}

export interface ClientListAllSessionsMsg {
  type: 'list_all_sessions';
  /** Include archived cards. Default false. */
  includeArchived?: boolean;
  correlationId?: string;
}

export interface ServerAllSessionsMsg {
  type: 'all_sessions';
  sessions: BoardSession[];
  correlationId?: string;
}

/**
 * Change model and/or effort on an existing session.
 *
 * Claude applies it in place via `/model` / `/effort` on the live stdin;
 * Codex records it and the next per-turn spawn picks it up.
 */
export interface ClientSetSessionModelMsg {
  type: 'set_session_model';
  sessionId: string;
  model?: string;
  effort?: EffortLevel;
  correlationId?: string;
}

export interface ServerSessionModelChangedMsg {
  type: 'session_model_changed';
  sessionId: string;
  model: string | null;
  effort: EffortLevel | null;
}

export interface ClientSetSessionPhaseMsg {
  type: 'set_session_phase';
  sessionId: string;
  phase: SessionPhase;
  correlationId?: string;
}

export interface ServerSessionPhaseChangedMsg {
  type: 'session_phase_changed';
  sessionId: string;
  phase: SessionPhase;
  phasePinned: boolean;
  correlationId?: string;
}

export interface ClientSetSessionTagsMsg {
  type: 'set_session_tags';
  sessionId: string;
  tags: string[];
  correlationId?: string;
}

export interface ServerSessionTagsChangedMsg {
  type: 'session_tags_changed';
  sessionId: string;
  tags: string[];
  correlationId?: string;
}

export interface ClientArchiveSessionMsg {
  type: 'archive_session';
  sessionId: string;
  archived: boolean;
  correlationId?: string;
}

export interface ServerSessionArchivedMsg {
  type: 'session_archived';
  sessionId: string;
  archived: boolean;
  correlationId?: string;
}

export interface ClientDeleteSessionMsg {
  type: 'delete_session';
  sessionId: string;
  correlationId?: string;
}

// Jobs — the Backlog column. Work written down before an agent runs; starting
// one spawns a session seeded with its text. See `job-store.ts`.

export interface JobSummary {
  id: string;
  title: string;
  notes: string;
  tags: string[];
  projectPath: string;
  additionalDirs: string[];
  agent: AgentKind;
  account: string | null;
  claudeConfig: string | null;
  createdAt: number;
  updatedAt: number;
  startedSessionId: string | null;
  startedAt: number | null;
  archived: boolean;
}

/** Session token totals changed. Broadcast after each completed turn. */
export interface ServerSessionUsageMsg {
  type: 'session_usage';
  sessionId: string;
  usage: SessionUsage;
}

/**
 * Current quota windows, one per (account, `limitType`) pair.
 *
 * Pushed whenever a session observes a `rate_limit_event`, and sent on request
 * so a client that connects between turns still has something to show. Every
 * window names its account, because a bridge driving two Claude profiles is
 * reporting on two separate plans.
 */
export interface ServerRateLimitsMsg {
  type: 'rate_limits';
  windows: AccountRateLimitWindow[];
  correlationId?: string;
}

/**
 * Whether a session is mid-turn.
 *
 * Broadcast on every flip, from the session's own bookkeeping — the client used
 * to infer this by walking the event stream, which quietly went wrong whenever
 * the opening `user` message was no longer in the window it could see (a long
 * turn trimmed past the ring buffer, or a page loaded mid-turn). A card then
 * read "needs input" while the agent was still working.
 *
 * Deliberately outside the seq'd lifecycle stream: it carries no conversation
 * content, so it must not consume a sequence number or land in the transcript.
 */
export interface ServerSessionTurnMsg {
  type: 'session_turn';
  sessionId: string;
  running: boolean;
}

export interface ClientGetRateLimitsMsg {
  type: 'get_rate_limits';
  correlationId?: string;
}

export interface ClientListJobsMsg {
  type: 'list_jobs';
  includeArchived?: boolean;
  /** Include jobs already turned into sessions. Default false. */
  includeStarted?: boolean;
  correlationId?: string;
}

export interface ServerJobListMsg {
  type: 'job_list';
  jobs: JobSummary[];
  correlationId?: string;
}

export interface ClientCreateJobMsg {
  type: 'create_job';
  title: string;
  notes?: string;
  tags?: string[];
  projectPath: string;
  additionalDirs?: string[];
  agent: AgentKind;
  account?: string | null;
  claudeConfig?: string | null;
  model?: string | null;
  effort?: EffortLevel | null;
  correlationId?: string;
}

export interface ClientUpdateJobMsg {
  type: 'update_job';
  jobId: string;
  title?: string;
  notes?: string;
  tags?: string[];
  projectPath?: string;
  additionalDirs?: string[];
  agent?: AgentKind;
  account?: string | null;
  claudeConfig?: string | null;
  model?: string | null;
  effort?: EffortLevel | null;
  archived?: boolean;
  correlationId?: string;
}

export interface ServerJobUpsertedMsg {
  type: 'job_upserted';
  job: JobSummary;
  correlationId?: string;
}

export interface ClientDeleteJobMsg {
  type: 'delete_job';
  jobId: string;
  correlationId?: string;
}

export interface ServerJobDeletedMsg {
  type: 'job_deleted';
  jobId: string;
  correlationId?: string;
}

export interface ClientStartJobMsg {
  type: 'start_job';
  jobId: string;
  correlationId?: string;
}

/**
 * Emitted after `start_job` spawns the session. The `job_upserted` that
 * accompanies it carries `startedSessionId`, which removes the card from the
 * Backlog; this message tells the client which session to open.
 */
export interface ServerJobStartedMsg {
  type: 'job_started';
  jobId: string;
  sessionId: string;
  correlationId?: string;
}

export interface ServerSessionDeletedMsg {
  type: 'session_deleted';
  sessionId: string;
  correlationId?: string;
}

export interface ServerHistoryMsg {
  type: 'history';
  sessionId: string;
  events: Array<ServerLifecycleMsg | ServerStreamMsg>;
  hasMore: boolean;
  correlationId?: string;
}

export interface ServerAccountListMsg {
  type: 'account_list';
  /**
   * Codex accounts (CODEX_HOME) and Claude profiles (CLAUDE_CONFIG_DIR),
   * distinguished by `agent`. The directory itself is never sent — it is a
   * local filesystem path the client has no use for.
   */
  accounts: Array<{ name: string; agent: AgentKind; isDefault: boolean }>;
  correlationId?: string;
}

export interface ServerPromptsResultMsg {
  type: 'prompts_result';
  prompts: Array<{
    text: string;
    lastUsedAt: number;
    projectPaths: string[];
    agents: AgentKind[];
  }>;
  correlationId?: string;
}

export interface ServerDirsResultMsg {
  type: 'dirs_result';
  path: string;
  entries: Array<{ name: string; kind: 'dir' | 'file'; size?: number }>;
  correlationId?: string;
}

export interface ServerFileResultText {
  type: 'file_result';
  kind: 'text';
  path: string;
  content: string;
  bytesRead: number;
  truncated: boolean;
  /** SHA-256 of `content`; hand it back on `write_file` to detect conflicts. */
  hash: string;
  correlationId?: string;
}

export interface ServerFileResultBinary {
  type: 'file_result';
  kind: 'binary';
  path: string;
  mime?: string;
  size: number;
  correlationId?: string;
}

export interface ServerFileResultTooLarge {
  type: 'file_result';
  kind: 'too_large';
  path: string;
  size: number;
  correlationId?: string;
}

export type ServerFileResultMsg =
  | ServerFileResultText
  | ServerFileResultBinary
  | ServerFileResultTooLarge;

export interface ServerFileWrittenMsg {
  type: 'file_written';
  path: string;
  bytesWritten: number;
  /** Hash of what is now on disk — becomes the client's next `baseHash`. */
  hash: string;
  correlationId?: string;
}

export type ServerErrorCode =
  | 'not_authorized'
  | 'origin_mismatch'
  | 'path_outside_allowlist'
  | 'path_denied'
  | 'file_too_large'
  | 'file_conflict'
  | 'file_write_failed'
  | 'session_dead'
  | 'interrupt_not_supported'
  | 'claude_config_invalid'
  | 'claude_config_not_found'
  | 'agent_not_installed'
  | 'unknown_account'
  | 'codex_session_id_missing'
  | 'message_too_large'
  | 'history_truncated'
  | 'unsupported_message'
  | 'images_not_supported_for_agent'
  | 'image_too_large'
  | 'image_invalid_mime'
  | 'too_many_images'
  | 'history_session_not_found'
  | 'project_path_disallowed'
  | 'project_path_missing'
  | 'cli_session_id_unknown'
  | 'claude_resume_rejected'
  | 'session_model_invalid'
  | 'codex_resume_rejected'
  | 'resume_spawn_failed'
  | 'profile_invalid_name'
  | 'profile_dirs_disallowed'
  | 'profile_not_found'
  | 'session_name_invalid'
  | 'session_not_found'
  | 'session_phase_invalid'
  | 'session_tags_invalid'
  | 'job_invalid'
  | 'job_not_found'
  | 'job_already_started'
  | 'file_search_failed'
  | 'slash_commands_failed'
  | 'terminal_not_found'
  | 'terminal_spawn_failed'
  | 'pty_not_available';

export interface ServerErrorMsg {
  type: 'error';
  code: ServerErrorCode;
  message: string;
  sessionId?: string;
  correlationId?: string;
}

export type ServerMsg =
  | ServerInitMsg
  | ServerLifecycleMsg
  | ServerStreamMsg
  | ServerSessionListMsg
  | ServerHistoryMsg
  | ServerAccountListMsg
  | ServerPromptsResultMsg
  | ServerDirsResultMsg
  | ServerFileResultMsg
  | ServerFileWrittenMsg
  | ServerErrorMsg
  | ServerHistoryListMsg
  | ServerSessionResumedMsg
  | ServerProfileListMsg
  | ServerProfileSavedMsg
  | ServerProfileDeletedMsg
  | ServerProfileDefaultSetMsg
  | ServerSlashCommandsListMsg
  | ServerFileSearchResultsMsg
  | ServerClipboardPathsMsg
  | ServerSessionRenamedMsg
  | ServerTermStartedMsg
  | ServerTermOutputMsg
  | ServerTermExitMsg
  | ServerAllSessionsMsg
  | ServerSessionModelChangedMsg
  | ServerSessionPhaseChangedMsg
  | ServerSessionTagsChangedMsg
  | ServerSessionArchivedMsg
  | ServerSessionDeletedMsg
  | ServerJobListMsg
  | ServerJobUpsertedMsg
  | ServerJobDeletedMsg
  | ServerJobStartedMsg
  | ServerSessionUsageMsg
  | ServerRateLimitsMsg
  | ServerSessionTurnMsg;

// Phase 5 — history viewer + session resume

export interface HistoryEntry {
  agent: 'claude' | 'codex';
  /** CLI's own session uuid (Claude: filename without `.jsonl`; Codex: session_meta.payload.id). */
  sessionId: string;
  /** Ground-truth cwd extracted from file content. Entries with no parseable user message are dropped. */
  projectPath: string;
  /** ms since epoch */
  mtime: number;
  /** First user message text, truncated to 80 chars; "" if none parseable. */
  firstPrompt: string;
}

export interface ClientListHistoryMsg {
  type: 'list_history';
  correlationId: string;
}

/**
 * Resume — tagged union with two shapes:
 *   (a) Bridge-known: only webSessionId is required; bridge looks up the
 *       agent + projectPath + cliSessionId from its registry.
 *   (b) Native-history first-resume: agent + sessionId + projectPath required;
 *       bridge issues a new webSessionId.
 */
export type ClientResumeSessionMsg =
  | {
      type: 'resume_session';
      webSessionId: string;
      account?: string;
      correlationId: string;
    }
  | {
      type: 'resume_session';
      agent: 'claude' | 'codex';
      sessionId: string;
      projectPath: string;
      account?: string;
      correlationId: string;
    };

export interface ServerHistoryListMsg {
  type: 'history_list';
  claude: HistoryEntry[];
  codex: HistoryEntry[];
  correlationId: string;
}

export interface ServerSessionResumedMsg {
  type: 'session_resumed';
  webSessionId: string;
  alive: true;
  correlationId: string;
}

// Phase 6 — slash + multi-dir/profiles + @-tag + telegram

export interface Profile {
  /** Unique within (agent); regex `[A-Za-z0-9 _-]{1,40}` */
  name: string;
  agent: 'claude' | 'codex';
  /** Working dirs in order; dirs[0] = primary cwd, dirs[1..] = --add-dir for Claude. Non-empty. */
  dirs: string[];
  /** Codex profile name; null for Claude. */
  account: string | null;
  /** One profile per agent can have default: true. */
  default: boolean;
  /** Server-set on load when validation fails (e.g. dirs[i] outside allowlist). UI greys out invalid entries. */
  valid?: boolean;
}

export interface SlashCommand {
  /** Includes leading `/`. */
  name: string;
  /** Empty string when none. */
  description: string;
  source: 'builtin' | 'user' | 'project';
  /** `'both'` for shared commands; otherwise scoped. */
  agent: 'claude' | 'codex' | 'both';
}

export interface SearchHit {
  /** Already formatted for textarea insertion (with @ prefix). */
  insertText: string;
  /** Absolute path for tooltip display. */
  fullPath: string;
  /** 0 = primary, 1..N = index into session.additionalDirs. */
  dirIndex: number;
  mtime: number;
  /** True when this hit is a directory; absent or false for files. */
  isDir?: boolean;
}

export interface ClientListProfilesMsg {
  type: 'list_profiles';
  correlationId: string;
}

export interface ClientSaveProfileMsg {
  type: 'save_profile';
  profile: Profile;
  correlationId: string;
}

export interface ClientDeleteProfileMsg {
  type: 'delete_profile';
  name: string;
  agent: 'claude' | 'codex';
  correlationId: string;
}

export interface ClientSetDefaultProfileMsg {
  type: 'set_default_profile';
  name: string;
  agent: 'claude' | 'codex';
  correlationId: string;
}

export interface ClientListSlashCommandsMsg {
  type: 'list_slash_commands';
  sessionId: string;
  correlationId: string;
}

export interface ClientSearchFilesMsg {
  type: 'search_files';
  sessionId: string;
  query: string;
  correlationId: string;
}

/**
 * "The browser saw a paste of these filenames — does your clipboard know where
 * they live?"
 *
 * `names` is both the question and the safety gate: the bridge answers only
 * with paths whose basename is in this list, so a bridge whose clipboard has
 * nothing to do with the browser's (a phone over Tailscale) answers with
 * nothing. See `clipboard.ts`.
 */
export interface ClientGetClipboardPathsMsg {
  type: 'get_clipboard_paths';
  names: string[];
  correlationId: string;
}

export interface ClientRenameSessionMsg {
  type: 'rename_session';
  sessionId: string;
  name: string;
  correlationId: string;
}

export interface ServerProfileListMsg {
  type: 'profile_list';
  profiles: Profile[];
  correlationId: string;
}

export interface ServerProfileSavedMsg {
  type: 'profile_saved';
  profile: Profile;
  correlationId: string;
}

export interface ServerProfileDeletedMsg {
  type: 'profile_deleted';
  name: string;
  agent: 'claude' | 'codex';
  correlationId: string;
}

export interface ServerProfileDefaultSetMsg {
  type: 'profile_default_set';
  name: string;
  agent: 'claude' | 'codex';
  correlationId: string;
}

export interface ServerSlashCommandsListMsg {
  type: 'slash_commands_list';
  commands: SlashCommand[];
  correlationId: string;
}

export interface ServerFileSearchResultsMsg {
  type: 'file_search_results';
  hits: SearchHit[];
  truncated: boolean;
  correlationId: string;
}

/** Absolute paths for the requested names; empty when none matched. */
export interface ServerClipboardPathsMsg {
  type: 'clipboard_paths';
  paths: string[];
  correlationId: string;
}

export interface ServerSessionRenamedMsg {
  type: 'session_renamed';
  sessionId: string;
  name: string;
  correlationId: string;
}

// Phase 7 — terminal mode

export interface ClientTermStartMsg {
  type: 'term_start';
  cwd: string;
  cols: number;
  rows: number;
  correlationId: string;
}

export interface ClientTermInputMsg {
  type: 'term_input';
  termId: string;
  data: string;
}

export interface ClientTermResizeMsg {
  type: 'term_resize';
  termId: string;
  cols: number;
  rows: number;
}

export interface ClientTermKillMsg {
  type: 'term_kill';
  termId: string;
  correlationId: string;
}

export interface ServerTermStartedMsg {
  type: 'term_started';
  termId: string;
  cwd: string;
  createdAt: number;
  correlationId: string;
}

export interface ServerTermOutputMsg {
  type: 'term_output';
  termId: string;
  data: string;
}

export interface ServerTermExitMsg {
  type: 'term_exit';
  termId: string;
  exitCode: number | null;
  signal: string | null;
}
