import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { makePathValidator, PathOutsideAllowlistError } from './path-allowlist.js';
import { TerminalProcess } from './terminal-process.js';

export class TerminalSpawnFailedError extends Error {
  code = 'terminal_spawn_failed' as const;
  constructor(message: string) { super(message); }
}

export interface TerminalSession {
  termId: string;
  wsId: string;
  cwd: string;
  createdAt: number;
}

export interface TerminalManagerOpts {
  allowedDirs: string[];
  realpath?: (p: string) => Promise<string>;
  /** Injection seam for tests; default constructs a real TerminalProcess. */
  procFactory?: (cwd: string, cols: number, rows: number) => TerminalProcess;
  /** Default 1 MB. Backpressure pause threshold. */
  bpHighWatermark?: number;
}

interface InternalEntry extends TerminalSession {
  proc: TerminalProcess;
  paused: boolean;
}

export class TerminalManager extends EventEmitter {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly validatePath: (p: string) => Promise<string>;
  private readonly procFactory: (cwd: string, cols: number, rows: number) => TerminalProcess;
  private readonly highWatermark: number;

  constructor(opts: TerminalManagerOpts) {
    super();
    this.validatePath = makePathValidator({
      allowedDirs: opts.allowedDirs,
      ...(opts.realpath ? { realpath: opts.realpath } : {}),
    });
    this.procFactory = opts.procFactory ?? ((cwd, cols, rows) => new TerminalProcess(cwd, cols, rows));
    this.highWatermark = opts.bpHighWatermark ?? 1024 * 1024;
  }

  async spawn(wsId: string, cwd: string, cols: number, rows: number): Promise<TerminalSession> {
    let real: string;
    try {
      real = await this.validatePath(cwd);
    } catch (err) {
      if (err instanceof PathOutsideAllowlistError) throw err;
      throw err;
    }
    let proc: TerminalProcess;
    try {
      proc = this.procFactory(real, cols, rows);
    } catch (err) {
      throw new TerminalSpawnFailedError((err as Error).message);
    }
    const termId = randomUUID();
    const entry: InternalEntry = {
      termId,
      wsId,
      cwd: real,
      createdAt: Date.now(),
      proc,
      paused: false,
    };
    this.entries.set(termId, entry);
    proc.on('output', (data: string) => {
      // Drop output if entry was already torn down (race).
      if (!this.entries.has(termId)) return;
      this.emit('output', termId, data);
    });
    proc.on('exit', (exitCode: number | null, signal: string | null) => {
      this.entries.delete(termId);
      this.emit('exit', termId, exitCode, signal);
    });
    return { termId, wsId, cwd: real, createdAt: entry.createdAt };
  }

  sendInput(wsId: string, termId: string, data: string): void {
    const entry = this.entries.get(termId);
    if (!entry) return;                       // unknown / already exited → silent
    if (entry.wsId !== wsId) {                // foreign ws → typed error
      this.emit('error', { wsId, code: 'terminal_not_found', termId });
      return;
    }
    entry.proc.write(data);
  }

  resize(wsId: string, termId: string, cols: number, rows: number): void {
    const entry = this.entries.get(termId);
    if (!entry) return;
    if (entry.wsId !== wsId) {
      this.emit('error', { wsId, code: 'terminal_not_found', termId });
      return;
    }
    entry.proc.resize(cols, rows);
  }

  kill(wsId: string, termId: string): void {
    const entry = this.entries.get(termId);
    if (!entry) return;
    if (entry.wsId !== wsId) {
      this.emit('error', { wsId, code: 'terminal_not_found', termId });
      return;
    }
    entry.proc.kill();
  }

  killByWs(wsId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.wsId === wsId) entry.proc.kill();
    }
  }

  /** Called from websocket.ts after each ws.send to pace the pty. */
  reportBufferedAmount(termId: string, bufferedAmount: number): void {
    const entry = this.entries.get(termId);
    if (!entry) return;
    if (bufferedAmount > this.highWatermark && !entry.paused) {
      entry.paused = true;
      entry.proc.pause();
    } else if (bufferedAmount < this.highWatermark / 2 && entry.paused) {
      entry.paused = false;
      entry.proc.resume();
    }
  }

  async shutdown(): Promise<void> {
    for (const entry of this.entries.values()) entry.proc.kill();
    // Wait one tick so any synchronous SIGHUP-driven exit handlers can clear
    // entries before the bridge process exits. Best-effort.
    await new Promise<void>((res) => setImmediate(res));
  }
}
