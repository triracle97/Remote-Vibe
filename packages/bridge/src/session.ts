import { EventEmitter } from 'node:events';
import { realpath as fsRealpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ClaudeProcess } from './claude-process.js';
import type {
  AgentEvent,
  AgentKind,
  ServerLifecycleMsg,
  ServerStreamMsg,
} from './types.js';

export interface SessionInfo {
  sessionId: string;
  agent: AgentKind;
  projectPath: string;
  createdAt: number;
}

interface InternalSession extends SessionInfo {
  proc: ClaudeProcess;
  buffer: Array<ServerLifecycleMsg | ServerStreamMsg>;
  nextSeq: number;
  alive: boolean;
}

export interface SessionManagerOpts {
  allowedDirs: string[];
  bufferCap: number;
  spawnClaude: (projectPath: string) => ClaudeProcess;
  realpath?: (p: string) => Promise<string>;
}

export class PathOutsideAllowlistError extends Error {
  code = 'path_outside_allowlist' as const;
  constructor(public projectPath: string) {
    super(`projectPath ${projectPath} is not inside any allowed directory`);
  }
}

export class SessionDeadError extends Error {
  code = 'session_dead' as const;
  constructor(public sessionId: string) {
    super(`[session_dead] session ${sessionId} is not alive`);
  }
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly allowedDirs: string[];
  private readonly bufferCap: number;
  private readonly spawnClaude: (projectPath: string) => ClaudeProcess;
  private readonly realpath: (p: string) => Promise<string>;

  constructor(opts: SessionManagerOpts) {
    super();
    this.allowedDirs = opts.allowedDirs;
    this.bufferCap = opts.bufferCap;
    this.spawnClaude = opts.spawnClaude;
    this.realpath = opts.realpath ?? fsRealpath;
  }

  private async validatePath(projectPath: string): Promise<string> {
    let real: string;
    try {
      real = await this.realpath(projectPath);
    } catch {
      throw new PathOutsideAllowlistError(projectPath);
    }
    const inside = this.allowedDirs.some((d) => real === d || real.startsWith(d + '/'));
    if (!inside) throw new PathOutsideAllowlistError(projectPath);
    return real;
  }

  async create(params: {
    agent: AgentKind;
    projectPath: string;
    correlationId?: string;
  }): Promise<SessionInfo> {
    if (params.agent !== 'claude') {
      throw new Error(`agent ${params.agent} not supported in Phase 1`);
    }
    const real = await this.validatePath(params.projectPath);
    const sessionId = randomUUID();
    const proc = this.spawnClaude(real);

    const internal: InternalSession = {
      sessionId,
      agent: 'claude',
      projectPath: real,
      createdAt: Date.now(),
      proc,
      buffer: [],
      nextSeq: 1,
      alive: true,
    };
    this.sessions.set(sessionId, internal);

    this.appendAndBroadcast(internal, {
      type: 'system',
      event: 'session_created',
      sessionId,
      seq: internal.nextSeq++,
      agent: internal.agent,
      projectPath: internal.projectPath,
      createdAt: internal.createdAt,
      ...(params.correlationId ? { correlationId: params.correlationId } : {}),
    });

    proc.on('event', (e: AgentEvent) => this.onProcEvent(internal, e));
    proc.on('exit', (code: number | null, reason?: string) => this.onProcExit(internal, code, reason));

    return {
      sessionId,
      agent: internal.agent,
      projectPath: internal.projectPath,
      createdAt: internal.createdAt,
    };
  }

  private onProcEvent(s: InternalSession, e: AgentEvent): void {
    if (!s.alive) return;
    const seq = s.nextSeq++;
    let msg: ServerStreamMsg;
    switch (e.kind) {
      case 'assistant_text':
        msg = { type: 'assistant', sessionId: s.sessionId, seq, payload: { text: e.text } };
        break;
      case 'stream_delta':
        msg = { type: 'stream_delta', sessionId: s.sessionId, seq, payload: { delta: e.delta } };
        break;
      case 'tool_use':
        msg = { type: 'assistant', sessionId: s.sessionId, seq, payload: { toolUse: e } };
        break;
      case 'tool_result':
        msg = { type: 'tool_result', sessionId: s.sessionId, seq, payload: e };
        break;
      case 'result':
        msg = { type: 'result', sessionId: s.sessionId, seq, payload: e };
        break;
    }
    this.appendAndBroadcast(s, msg);
  }

  private onProcExit(s: InternalSession, code: number | null, reason?: string): void {
    if (!s.alive) return;
    s.alive = false;
    const finalReason = reason ?? 'agent_exit';
    if (finalReason === 'agent_not_installed') {
      this.emit('broadcast', {
        type: 'error',
        code: 'agent_not_installed',
        message: 'claude CLI not found on PATH',
      });
    }
    this.appendAndBroadcast(s, {
      type: 'system',
      event: 'session_ended',
      sessionId: s.sessionId,
      seq: s.nextSeq++,
      // Omit exitCode entirely when the OS did not give us a numeric one
      // (signal-terminated children — the SIGTERM/SIGKILL path — exit with
      // code === null). The UI renders the absence as "exit ?" rather than
      // a misleading "exit -1".
      ...(typeof code === 'number' ? { exitCode: code } : {}),
      reason: finalReason,
    });
    this.sessions.delete(s.sessionId);
  }

  private appendAndBroadcast(s: InternalSession, msg: ServerLifecycleMsg | ServerStreamMsg): void {
    s.buffer.push(msg);
    if (s.buffer.length > this.bufferCap) {
      s.buffer.splice(0, s.buffer.length - this.bufferCap);
    }
    this.emit('broadcast', msg);
  }

  listSessions(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      agent: s.agent,
      projectPath: s.projectPath,
      createdAt: s.createdAt,
    }));
  }

  getHistory(sessionId: string, since: number): {
    events: Array<ServerLifecycleMsg | ServerStreamMsg>;
    hasMore: boolean;
  } {
    const s = this.sessions.get(sessionId);
    if (!s) return { events: [], hasMore: false };
    const minSeqInBuffer = s.buffer.length > 0 ? s.buffer[0]!.seq : s.nextSeq;
    const events = s.buffer.filter((e) => e.seq > since);
    const hasMore = since + 1 < minSeqInBuffer;
    return { events, hasMore };
  }

  sendInput(sessionId: string, text: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || !s.alive) throw new SessionDeadError(sessionId);
    s.proc.sendUserText(text);
  }

  stop(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.proc.kill();
  }

  shutdown(): void {
    for (const s of this.sessions.values()) s.proc.kill();
  }
}
