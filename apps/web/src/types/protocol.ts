export type AgentKind = 'claude' | 'codex';

export interface ClientStartMsg {
  type: 'start';
  agent: AgentKind;
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

export type ClientMsg =
  | ClientStartMsg
  | ClientInputMsg
  | ClientStopMsg
  | ClientListSessionsMsg
  | ClientGetHistoryMsg
  | ClientListAccountsMsg
  | ClientListPromptsMsg
  | ClientListDirsMsg
  | ClientReadFileMsg
  | ClientListHistoryMsg
  | ClientResumeSessionMsg
  | ClientListProfilesMsg
  | ClientSaveProfileMsg
  | ClientDeleteProfileMsg
  | ClientSetDefaultProfileMsg
  | ClientListSlashCommandsMsg
  | ClientSearchFilesMsg
  | ClientRenameSessionMsg;

export type AgentEvent =
  | { kind: 'assistant_text'; text: string }
  | { kind: 'stream_delta'; delta: string }
  | { kind: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; output: unknown }
  | { kind: 'result'; cost?: number; durationMs?: number; error?: string };

export interface ServerInitMsg {
  type: 'system';
  event: 'init';
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
}

export interface ServerSessionListMsg {
  type: 'session_list';
  sessions: Array<{
    sessionId: string;
    agent: AgentKind;
    projectPath: string;
    createdAt: number;
    account?: string;
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
  accounts: Array<{ name: string; agent: 'codex'; isDefault: boolean }>;
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

export type ServerErrorCode =
  | 'not_authorized'
  | 'origin_mismatch'
  | 'path_outside_allowlist'
  | 'path_denied'
  | 'session_dead'
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
  | 'file_search_failed'
  | 'slash_commands_failed';

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
  | ServerErrorMsg
  | ServerHistoryListMsg
  | ServerSessionResumedMsg
  | ServerProfileListMsg
  | ServerProfileSavedMsg
  | ServerProfileDeletedMsg
  | ServerProfileDefaultSetMsg
  | ServerSlashCommandsListMsg
  | ServerFileSearchResultsMsg
  | ServerSessionRenamedMsg;

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

export interface ServerSessionRenamedMsg {
  type: 'session_renamed';
  sessionId: string;
  name: string;
  correlationId: string;
}
