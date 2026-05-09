import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const KILL_GRACE_MS = 5000;

/**
 * The shape we need from a node-pty IPty. Keeping our own interface lets
 * tests inject a fake without touching node-pty at all.
 */
export interface PtyLike {
  onData(cb: (s: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

export type PtySpawnFn = (
  shell: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    cols: number;
    rows: number;
    name: string;
  },
) => PtyLike;

export interface TerminalProcessOpts {
  /** Injection seam — defaults to the lazily-loaded node-pty.spawn. */
  spawn?: PtySpawnFn;
  /** Default 5000 ms. */
  killGraceMs?: number;
}

const SIGNAL_NAMES: Record<number, string> = {
  1: 'SIGHUP', 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM',
};

export class TerminalProcess extends EventEmitter {
  private readonly pty: PtyLike;
  private readonly killGraceMs: number;
  private killed = false;

  constructor(cwd: string, cols: number, rows: number, opts: TerminalProcessOpts = {}) {
    super();
    this.killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
    const spawn = opts.spawn ?? defaultSpawn();
    this.pty = spawn('zsh', ['-l'], {
      cwd,
      env: process.env,
      cols,
      rows,
      name: 'xterm-256color',
    });
    this.pty.onData((s) => {
      if (this.killed) return;
      this.emit('output', s);
    });
    this.pty.onExit(({ exitCode, signal }) => {
      const sigName = typeof signal === 'number' ? (SIGNAL_NAMES[signal] ?? null) : null;
      this.emit('exit', exitCode, sigName);
    });
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  pause(): void { this.pty.pause(); }
  resume(): void { this.pty.resume(); }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.pty.kill('SIGHUP');
    setTimeout(() => {
      try { this.pty.kill('SIGKILL'); } catch { /* already gone */ }
    }, this.killGraceMs).unref();
  }
}

/**
 * Lazy dynamic import so the bridge can boot without node-pty installed.
 * Failure is surfaced one level up (the manager's spawnTerminal) as
 * `terminal_spawn_failed`. The capability probe in `index.ts` (Task 6) does
 * a separate `await import('node-pty')` once at boot to set the init flag.
 */
function defaultSpawn(): PtySpawnFn {
  return (shell, args, opts) => {
    // node-pty is CJS; use createRequire to load it synchronously from ESM.
    // Throws here become `terminal_spawn_failed` at the manager layer.
    const require = createRequire(import.meta.url);
    const pty = require('node-pty') as { spawn: PtySpawnFn };
    return pty.spawn(shell, args, opts);
  };
}
