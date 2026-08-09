export type AgentKind = 'claude' | 'codex';

/**
 * Reasoning effort. Mirror of `packages/bridge/src/models.ts`.
 *
 * The first five are exactly what `claude --effort` documents. `ultracode` is
 * not one of them — it is a mode (xhigh plus standing multi-agent
 * orchestration) that Claude Code's own `/config` offers in this same row, and
 * this list is that row. The bridge resolves it into a flag and a settings
 * file; nothing here ever reaches `--effort` as written.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode';

export const EFFORT_LEVELS: ReadonlyArray<{
  value: EffortLevel;
  label: string;
  /** Claude only, and only on a model that can reach xhigh. */
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
 * Advisory ceiling on the agent fleet a dynamic workflow may write, in the
 * CLI's own terms: small aims for fewer than 5 agents, medium (its default)
 * fewer than 15, large fewer than 50, unrestricted sends no guideline.
 */
export type WorkflowSize = 'unrestricted' | 'small' | 'medium' | 'large';

export const WORKFLOW_SIZES: ReadonlyArray<{ value: WorkflowSize; label: string }> = [
  { value: 'small', label: 'Small · <5 agents' },
  { value: 'medium', label: 'Medium · <15 agents' },
  { value: 'large', label: 'Large · <50 agents' },
  { value: 'unrestricted', label: 'Unrestricted' },
] as const;

/**
 * Whether a model can run ultracode.
 *
 * The CLI names Fable 5, Opus 4.7+ and Sonnet 5 as xhigh-capable; of the
 * aliases offered here only Haiku is out, and an alias always resolves to the
 * newest model on its line. Null means the CLI's own default, which is on a
 * capable line — and if that ever stops being true the CLI says so itself.
 */
export function supportsUltracode(model: string | null | undefined): boolean {
  if (!model) return true;
  return !/haiku/i.test(model);
}

/**
 * Claude offers aliases only: an alias always resolves to the latest model on
 * its line, so this list never goes stale as new versions ship.
 */
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

export function modelsFor(agent: AgentKind): ReadonlyArray<{ value: string; label: string }> {
  return agent === 'claude' ? CLAUDE_MODELS : CODEX_MODELS;
}

/** Human label for a model id, falling back to the id itself. */
export function modelLabel(agent: AgentKind, value: string): string {
  return modelsFor(agent).find((m) => m.value === value)?.label ?? value;
}

/**
 * Where a session sits in the work it is doing. Board columns, in order.
 * Auto-inference only moves forward; a manual drag can go either way and
 * pins the phase so inference stops.
 *
 * Mirror of `packages/bridge/src/types.ts`.
 */
export type SessionPhase =
  | 'backlog'
  | 'investigating'
  | 'planning'
  | 'implementing'
  | 'verifying'
  | 'done';

export const SESSION_PHASE_COLUMNS: ReadonlyArray<{
  value: SessionPhase;
  label: string;
  /** CSS custom property holding this column's accent colour. */
  token: string;
}> = [
  { value: 'backlog', label: 'Backlog', token: '--color-phase-backlog' },
  { value: 'investigating', label: 'Investigating', token: '--color-phase-investigating' },
  { value: 'planning', label: 'Planning', token: '--color-phase-planning' },
  { value: 'implementing', label: 'Implementing', token: '--color-phase-implementing' },
  { value: 'verifying', label: 'Verifying', token: '--color-phase-verifying' },
  { value: 'done', label: 'Done', token: '--color-phase-done' },
] as const;

export type SessionLifecycleStatus = 'live' | 'ended';

export interface ClientStartMsg {
  type: 'start';
  agent: AgentKind;
  /** Phase 8: named CLAUDE_CONFIG_DIR profile (claude only). */
  claudeConfig?: string;
  model?: string;
  effort?: EffortLevel;
  /**
   * Workflow settings for a Claude session. Only reach the CLI when something
   * turns workflows on — `effort: 'ultracode'`, or one of these being set.
   */
  workflowSize?: WorkflowSize;
  workflowKeywordTrigger?: boolean;
  /** Phase 1-5: single working dir. Still supported for backward compat. */
  projectPath?: string;
  /** Phase 6: multiple working dirs (first = primary cwd). If both `dirs` and `projectPath` present, `dirs` wins. */
  dirs?: string[];
  account?: string;
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

/** Running totals for one session. Persisted by the bridge. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** USD, as reported by the CLI. */
  costUsd: number;
  turns: number;
  /**
   * How full the context window is right now, in tokens: the input side of the
   * most recent turn. A *level*, not a running total — every other field here
   * accumulates. Older bridges do not send it, hence optional.
   */
  contextTokens?: number;
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

/**
 * A quota window reported by the CLI's `rate_limit_event` and relayed by the
 * bridge. `utilization` is a fraction 0..1, not a percentage.
 */
export interface RateLimitWindow {
  limitType: string;
  /**
   * Fraction 0..1, or null when the CLI reported no figure — which it only
   * does once the window passes its warning threshold. Null means "below the
   * warning threshold", not zero.
   */
  utilization: number | null;
  /** Unix seconds, or null when not reported. */
  resetsAt: number | null;
  status: string | null;
  isUsingOverage: boolean;
  observedAt: number;
}

/**
 * Whose plan a window describes.
 *
 * Quota is per credential, and the bridge routinely drives more than one: a
 * session on `~/.claude1` has its own 5-hour window, entirely separate from the
 * default profile's. Windows are therefore keyed by account as well as type,
 * and every figure the UI shows says which account it came from.
 */
export interface RateLimitAccount {
  /** Stable identity, e.g. `claude:default`. */
  key: string;
  /** Claude profile / Codex account name, as shown in the UI. */
  label: string;
  agent: AgentKind;
  /** Resolved CLAUDE_CONFIG_DIR, for the tooltip. Null for Codex. */
  configDir: string | null;
}

/** A quota window with the credential it belongs to attached. */
export interface AccountRateLimitWindow extends RateLimitWindow {
  account: RateLimitAccount;
}

export interface ServerSessionUsageMsg {
  type: 'session_usage';
  sessionId: string;
  usage: SessionUsage;
}

export interface ServerRateLimitsMsg {
  type: 'rate_limits';
  windows: AccountRateLimitWindow[];
  correlationId?: string;
}

/**
 * Whether a session is mid-turn, straight from the bridge's own bookkeeping.
 *
 * The board used to work this out by watching for a `user` message with no
 * `result` after it, which is wrong whenever the opening message is not in the
 * events this client can see — a turn longer than the bridge's ring buffer, or
 * a page loaded while the agent was already working. The card then read "needs
 * input" while the agent was still going.
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

/** Token accounting for one turn, straight off the CLI's `result` line. */
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type AgentEvent =
  | { kind: 'assistant_text'; text: string }
  | { kind: 'stream_delta'; delta: string }
  /** Extended-thinking block. Rendered collapsed. */
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; output: unknown; isError?: boolean }
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
  /** Directories the bridge will spawn inside (`BRIDGE_ALLOWED_DIRS`). */
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
   * Present when a subagent produced this, naming the tool call that started
   * it — a `Task`, or a `Workflow` whose script spawned it.
   *
   * Subagent output shares this channel with the main agent's, so without the
   * field a transcript would read as one agent abruptly narrating five
   * different jobs. The transcript nests these under the call instead.
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
     * Joined from the bridge registry. Without it the session name is lost on
     * every page reload, since `session_renamed` only fires on change.
     */
    name?: string | null;
  }>;
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
   * distinguished by `agent`. The directory itself is never sent.
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
 * Ask the bridge host's clipboard where the pasted files live.
 *
 * `names` is the safety gate as much as the query — the bridge answers only
 * with paths whose basename appears here, so a bridge on a different machine
 * from the browser answers with nothing rather than a stale path.
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

// Phase 8 — board. Unlike `session_list` (live sessions only), these span the
// bridge's whole registry, so sessions survive a bridge restart in the UI.

/** One board card: a registry entry enriched with live state. */
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
  /** True iff a driver is attached in the bridge right now. */
  alive: boolean;
  /**
   * True iff a turn is open — a `user` message with no `result` after it.
   * `alive` stays true while the agent sits idle waiting on the human, so the
   * board needs this to tell "still working" from "your turn".
   */
  turnRunning?: boolean;
  phase: SessionPhase;
  phasePinned: boolean;
  tags: string[];
  archived: boolean;
  account: string | null;
  claudeConfigDir: string | null;
  headroom: boolean;
  /** True when the CLI session id is known, so resume can work. */
  resumable: boolean;
  /** Running token/cost totals for this session. */
  usage: SessionUsage;
  /** Resolved model/effort, or null meaning the CLI's own default. */
  model: string | null;
  effort: EffortLevel | null;
  /** Resolved workflow settings, or null meaning the CLI's own default. */
  workflowSize?: WorkflowSize | null;
  workflowKeywordTrigger?: boolean | null;
  /** The session that spawned this one via `spawn_session`, else null. */
  parentSessionId?: string | null;
  /** Parent's display name, resolved by the bridge. */
  parentName?: string | null;
}

export interface ClientListAllSessionsMsg {
  type: 'list_all_sessions';
  includeArchived?: boolean;
  correlationId?: string;
}

export interface ServerAllSessionsMsg {
  type: 'all_sessions';
  sessions: BoardSession[];
  correlationId?: string;
}

export interface ClientSetSessionModelMsg {
  type: 'set_session_model';
  sessionId: string;
  model?: string | null;
  effort?: EffortLevel | null;
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
// one spawns a session seeded with its text and carries the tags across.

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
  /** Model/effort the launched session runs with; null = CLI default. */
  model: string | null;
  effort: EffortLevel | null;
  createdAt: number;
  updatedAt: number;
  /** Non-null once started; such a job leaves the Backlog. */
  startedSessionId: string | null;
  startedAt: number | null;
  archived: boolean;
}

export interface ClientListJobsMsg {
  type: 'list_jobs';
  includeArchived?: boolean;
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
