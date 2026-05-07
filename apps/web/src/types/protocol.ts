export type AgentKind = 'claude' | 'codex';

export interface ClientStartMsg {
  type: 'start';
  agent: AgentKind;
  projectPath: string;
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
  | ClientReadFileMsg;

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
  | 'too_many_images';

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
  | ServerErrorMsg;
