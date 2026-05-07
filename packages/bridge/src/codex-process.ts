import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcessByStdio, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { parseCodexLine } from './codex-parser.js';
import type { AgentEvent } from './types.js';

const STDERR_TAIL_BYTES = 4096;
const KILL_GRACE_MS = 5000;

export type SpawnFn = (
  cmd: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessByStdio<Writable, Readable, Readable>;

export interface CodexProcessOpts {
  projectPath: string;
  codexHome: string;
  spawn?: SpawnFn;
}

export class CodexProcess extends EventEmitter {
  private readonly projectPath: string;
  private readonly codexHome: string;
  private readonly spawnFn: SpawnFn;
  private codexSessionId: string | null = null;
  private currentTurnProc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  // activeChild tracks the "accepted" child for stdout/stderr data guards.
  // It is set when a new child is spawned and cleared only when a newer child
  // supersedes it — NOT when the child exits naturally. This lets deferred
  // stdout/stderr data (which Node delivers asynchronously after the process
  // exits) still reach handleStdout/handleStderr for the exiting child.
  private activeChild: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private currentTurnSawSessionId = false;
  private currentTurnSawResult = false;
  private stdoutBuf = '';
  private stderrBuf = Buffer.alloc(0);
  private killed = false;

  constructor(opts: CodexProcessOpts) {
    super();
    this.projectPath = opts.projectPath;
    this.codexHome = opts.codexHome;
    this.spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  }

  sendUserText(text: string): void {
    // Concurrent-turn guard. If a previous turn is still in flight when the
    // next sendUserText arrives, terminate it cleanly first. Without this,
    // `currentTurnProc` would be silently overwritten and the prior child's
    // late `exit` event would clobber state for the new child.
    if (this.currentTurnProc) {
      const stale = this.currentTurnProc;
      this.currentTurnProc = null;
      // Supersede activeChild NOW so stale child's deferred stdout/stderr data
      // and exit events are filtered out by the per-listener guards below.
      this.activeChild = null;
      try {
        stale.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }
    if (this.killed) return;
    const baseArgs = [
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '-C',
      this.projectPath,
    ];
    const args =
      this.codexSessionId === null
        ? ['exec', ...baseArgs, text]
        : ['exec', 'resume', this.codexSessionId, ...baseArgs, text];

    const child = this.spawnFn('codex', args, {
      cwd: this.projectPath,
      env: { ...process.env, CODEX_HOME: this.codexHome },
      // stdin MUST be ignored. Codex's `exec` reads piped stdin as
      // additional prompt input ("Reading additional input from stdin...")
      // and won't run until EOF. Since we pass the prompt as argv, leaving
      // stdin as 'pipe' without writing/closing it makes the child hang
      // forever — observed against codex-cli 0.128.0 in development.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.currentTurnProc = child;
    // activeChild is set to the new child so its stdout/stderr/exit/error
    // listeners are accepted. It is only superseded when a NEWER child is
    // spawned — NOT when this child exits naturally — so deferred async data
    // events that arrive after the child exits still reach the handlers.
    this.activeChild = child;
    this.currentTurnSawSessionId = false;
    this.currentTurnSawResult = false;
    this.stdoutBuf = '';
    this.stderrBuf = Buffer.alloc(0);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.activeChild !== child) return; // superseded child, ignore
      this.handleStdout(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.activeChild !== child) return; // superseded child, ignore
      this.handleStderr(chunk);
    });
    child.on('exit', (code) => {
      if (this.activeChild !== child) return; // superseded child, ignore
      this.handleExit(code);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (this.activeChild !== child) return; // superseded child, ignore
      const reason = err.code === 'ENOENT' ? 'agent_not_installed' : 'spawn_failed';
      this.currentTurnProc = null;
      this.emit('exit', null, reason);
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.length === 0) continue;
      const parsed = parseCodexLine(line);
      if (!parsed) continue;
      if ('id' in parsed) {
        // session_id capture — store but do NOT emit upstream.
        this.codexSessionId = parsed.id;
        this.currentTurnSawSessionId = true;
        continue;
      }
      const ev = parsed as AgentEvent;
      if (ev.kind === 'result') {
        this.currentTurnSawResult = true;
      }
      this.emit('event', ev);
    }
  }

  private handleStderr(chunk: Buffer): void {
    this.stderrBuf = Buffer.concat([this.stderrBuf, chunk]);
    if (this.stderrBuf.length > STDERR_TAIL_BYTES) {
      this.stderrBuf = this.stderrBuf.subarray(this.stderrBuf.length - STDERR_TAIL_BYTES);
    }
  }

  private handleExit(code: number | null): void {
    const proc = this.currentTurnProc;
    this.currentTurnProc = null;
    if (proc === null) return;
    // Defer one tick so pending stdout/stderr 'data' events — which Node
    // streams deliver asynchronously even after push() — have a chance to
    // fire before we evaluate sessionIdMissing / nonZeroExit. Without this
    // deferral, data pushed before child.emit('exit') is not yet in
    // stdoutBuf / stderrBuf when we read them.
    setImmediate(() => this.finaliseExit(code));
  }

  private finaliseExit(code: number | null): void {
    // Flush any tail line that lacked a trailing newline.
    if (this.stdoutBuf.length > 0) {
      const parsed = parseCodexLine(this.stdoutBuf);
      this.stdoutBuf = '';
      if (parsed && !('id' in parsed)) {
        if ((parsed as AgentEvent).kind === 'result') {
          this.currentTurnSawResult = true;
        }
        this.emit('event', parsed);
      }
    }

    // Decide whether to synthesize a terminating result. If the parser
    // already produced one (task_completed), don't emit a duplicate — that
    // would render two "turn complete" bubbles. Only synthesize for the
    // exceptional cases: codex_session_id_missing, non-zero exit, or a
    // turn that ended without ever emitting a result.
    const sessionIdMissing =
      this.codexSessionId === null && !this.currentTurnSawSessionId;
    const nonZeroExit = code !== 0 && code !== null;

    if (sessionIdMissing || nonZeroExit) {
      const result: AgentEvent = { kind: 'result' };
      if (sessionIdMissing) {
        result.error = 'codex_session_id_missing';
      } else if (nonZeroExit) {
        const tail = this.stderrBuf.toString('utf8').trim();
        if (tail.length > 0) {
          result.error = tail.length > 1024 ? tail.slice(-1024) : tail;
        } else {
          result.error = `codex exec exited with code ${code}`;
        }
      }
      this.emit('event', result);
    } else if (!this.currentTurnSawResult) {
      // Clean exit but no task_completed event ever came through — emit a
      // bare result so the UI's "turn complete" bubble shows.
      this.emit('event', { kind: 'result' } satisfies AgentEvent);
    }
    // Successful turn that already emitted a parsed result: emit nothing.
  }

  stderrTail(): string {
    return this.stderrBuf.toString('utf8');
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    const proc = this.currentTurnProc;
    this.currentTurnProc = null; // ensure handleExit's natural-exit path no-ops
    this.activeChild = null; // suppress any deferred data/exit from killed child
    if (proc) {
      proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, KILL_GRACE_MS).unref();
    }
    // Always emit a terminal 'exit' so SessionManager fires session_ended,
    // closes the transcript file, and removes the session — even when no
    // turn is in flight (between Codex turns the spawn-per-turn driver has
    // no live child process to wait on).
    this.emit('exit', null, proc ? 'stopped' : 'idle_stop');
  }
}
