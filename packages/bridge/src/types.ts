export type AgentKind = 'claude';

export interface ClientStartMsg {
  type: 'start';
  agent: AgentKind;
  projectPath: string;
  sessionId?: string;
  resume?: boolean;
  correlationId?: string;
}

export interface ClientInputMsg {
  type: 'input';
  sessionId: string;
  text: string;
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

export type ClientMsg =
  | ClientStartMsg
  | ClientInputMsg
  | ClientStopMsg
  | ClientListSessionsMsg
  | ClientGetHistoryMsg;

export type AgentEvent =
  | { kind: 'assistant_text'; text: string }
  | { kind: 'stream_delta'; delta: string }
  | { kind: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; output: unknown }
  | { kind: 'result'; cost?: number; durationMs?: number };

export interface ServerInitMsg {
  type: 'system';
  event: 'init';
}

export interface ServerLifecycleMsg {
  type: 'system';
  event: 'session_created' | 'session_ended';
  sessionId: string;
  seq: number;
  // Populated only on session_created so the web client gets metadata
  // without an extra round-trip:
  agent?: AgentKind;
  projectPath?: string;
  createdAt?: number;
  // Echoed only on session_created when the client's `start` carried a
  // correlationId. Lets the UI deterministically link a `start` request
  // to its server-assigned sessionId without racing other lifecycle
  // events (e.g. session_list arriving with old sessions right after).
  correlationId?: string;
  // Populated only on session_ended:
  reason?: string;
  exitCode?: number;
}

export interface ServerStreamMsg {
  type: 'assistant' | 'stream_delta' | 'tool_result' | 'result' | 'status';
  sessionId: string;
  seq: number;
  payload: unknown;
}

export interface ServerSessionListMsg {
  type: 'session_list';
  sessions: Array<{ sessionId: string; agent: AgentKind; projectPath: string; createdAt: number }>;
  correlationId?: string;
}

export interface ServerHistoryMsg {
  type: 'history';
  sessionId: string;
  events: Array<ServerLifecycleMsg | ServerStreamMsg>;
  hasMore: boolean;
  correlationId?: string;
}

export type ServerErrorCode =
  | 'not_authorized'
  | 'origin_mismatch'
  | 'path_outside_allowlist'
  | 'session_dead'
  | 'agent_not_installed'
  | 'message_too_large'
  | 'history_truncated'
  | 'unsupported_message';

export interface ServerErrorMsg {
  type: 'error';
  code: ServerErrorCode;
  message: string;
  correlationId?: string;
}

export type ServerMsg =
  | ServerInitMsg
  | ServerLifecycleMsg
  | ServerStreamMsg
  | ServerSessionListMsg
  | ServerHistoryMsg
  | ServerErrorMsg;
