import { EventEmitter } from 'node:events';
import { realpath as fsRealpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ClaudeProcess } from './claude-process.js';
import type { TranscriptStore } from './transcript-store.js';
import type { CodexAccount } from './accounts.js';
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
  account?: string;
}

interface InternalSession extends SessionInfo {
  proc: AgentDriver;
  buffer: Array<ServerLifecycleMsg | ServerStreamMsg>;
  nextSeq: number;
  alive: boolean;
}

export interface AgentDriver extends EventEmitter {
  sendUserText(text: string): void;
  kill(): void;
}

export interface DriverFactoryArgs {
  agent: AgentKind;
  projectPath: string;
  account?: CodexAccount;
}

export interface SessionManagerOpts {
  allowedDirs: string[];
  bufferCap: number;
  /** Phase 1 back-compat: a Claude-only factory. Mutually exclusive with driverFactory. */
  spawnClaude?: (projectPath: string) => ClaudeProcess;
  /** Phase 2 generalised driver factory. */
  driverFactory?: (args: DriverFactoryArgs) => AgentDriver;
  realpath?: (p: string) => Promise<string>;
  transcriptStore?: TranscriptStore;
  accounts?: Map<string, CodexAccount>;
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

export class UnknownAccountError extends Error {
  code = 'unknown_account' as const;
  constructor(message: string) {
    super(message);
  }
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly allowedDirs: string[];
  private readonly bufferCap: number;
  private readonly driverFactory: (args: DriverFactoryArgs) => AgentDriver;
  private readonly realpath: (p: string) => Promise<string>;
  private readonly transcriptStore: TranscriptStore | undefined;
  private readonly accounts: Map<string, CodexAccount>;

  constructor(opts: SessionManagerOpts) {
    super();
    this.allowedDirs = opts.allowedDirs;
    this.bufferCap = opts.bufferCap;
    this.realpath = opts.realpath ?? fsRealpath;
    this.transcriptStore = opts.transcriptStore;
    this.accounts = opts.accounts ?? new Map();
    if (opts.driverFactory) {
      this.driverFactory = opts.driverFactory;
    } else if (opts.spawnClaude) {
      const spawnClaude = opts.spawnClaude;
      this.driverFactory = ({ agent, projectPath }) => {
        if (agent !== 'claude') {
          throw new Error(`agent ${agent} not supported by this SessionManager (claude-only factory)`);
        }
        return spawnClaude(projectPath) as unknown as AgentDriver;
      };
    } else {
      throw new Error('SessionManager: either driverFactory or spawnClaude must be provided');
    }
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

  private resolveAccount(agent: AgentKind, requested: string | undefined): CodexAccount | undefined {
    if (agent !== 'codex') return undefined;
    if (this.accounts.size === 0) {
      throw new UnknownAccountError('No Codex accounts are configured.');
    }
    if (!requested) {
      if (this.accounts.size === 1) {
        return [...this.accounts.values()][0];
      }
      const names = [...this.accounts.keys()].join(', ');
      throw new UnknownAccountError(
        `Account is required when multiple Codex accounts exist. Configured: [${names}]`,
      );
    }
    const found = this.accounts.get(requested);
    if (!found) {
      const names = [...this.accounts.keys()].join(', ');
      throw new UnknownAccountError(`Unknown Codex account '${requested}'. Configured: [${names}]`);
    }
    return found;
  }

  async create(params: {
    agent: AgentKind;
    projectPath: string;
    account?: string;
    correlationId?: string;
  }): Promise<SessionInfo> {
    const real = await this.validatePath(params.projectPath);
    const account = this.resolveAccount(params.agent, params.account);
    const sessionId = randomUUID();
    const proc = this.driverFactory({
      agent: params.agent,
      projectPath: real,
      ...(account ? { account } : {}),
    });

    const internal: InternalSession = {
      sessionId,
      agent: params.agent,
      projectPath: real,
      createdAt: Date.now(),
      proc,
      buffer: [],
      nextSeq: 1,
      alive: true,
      ...(account ? { account: account.name } : {}),
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
      ...(account ? { account: account.name } : {}),
      ...(params.correlationId ? { correlationId: params.correlationId } : {}),
    });

    proc.on('event', (e: AgentEvent) => this.onProcEvent(internal, e));
    proc.on('exit', (code: number | null, reason?: string) => this.onProcExit(internal, code, reason));

    return {
      sessionId,
      agent: internal.agent,
      projectPath: internal.projectPath,
      createdAt: internal.createdAt,
      ...(account ? { account: account.name } : {}),
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
        message: `${s.agent} CLI not found on PATH`,
        sessionId: s.sessionId,
      });
    }
    this.appendAndBroadcast(s, {
      type: 'system',
      event: 'session_ended',
      sessionId: s.sessionId,
      seq: s.nextSeq++,
      ...(typeof code === 'number' ? { exitCode: code } : {}),
      reason: finalReason,
    });
    this.transcriptStore?.close(s.sessionId);
    this.sessions.delete(s.sessionId);
  }

  private appendAndBroadcast(s: InternalSession, msg: ServerLifecycleMsg | ServerStreamMsg): void {
    s.buffer.push(msg);
    if (s.buffer.length > this.bufferCap) {
      s.buffer.splice(0, s.buffer.length - this.bufferCap);
    }
    this.transcriptStore?.append(s.sessionId, msg);
    this.emit('broadcast', msg);
  }

  listSessions(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      agent: s.agent,
      projectPath: s.projectPath,
      createdAt: s.createdAt,
      ...(s.account ? { account: s.account } : {}),
    }));
  }

  getHistory(
    sessionId: string,
    since: number,
  ):
    | {
        events: Array<ServerLifecycleMsg | ServerStreamMsg>;
        hasMore: boolean;
      }
    | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    const minSeqInBuffer = s.buffer.length > 0 ? s.buffer[0]!.seq : s.nextSeq;
    const events = s.buffer.filter((e) => e.seq > since);
    const hasMore = since + 1 < minSeqInBuffer;
    return { events, hasMore };
  }

  knowsSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  sendInput(sessionId: string, text: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || !s.alive) throw new SessionDeadError(sessionId);
    this.appendAndBroadcast(s, {
      type: 'user',
      sessionId,
      seq: s.nextSeq++,
      payload: { text },
    });
    s.proc.sendUserText(text);
  }

  stop(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.proc.kill();
  }

  shutdown(): void {
    for (const s of this.sessions.values()) s.proc.kill();
    this.transcriptStore?.closeAll();
  }
}
