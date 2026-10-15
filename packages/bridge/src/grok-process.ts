import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcessByStdio, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { parseGrokLine } from './grok-parser.js';
import { isEffortLevel, isValidModelId, type CliEffortLevel, type EffortLevel } from './models.js';
import type { AgentEvent } from './types.js';

const STDERR_TAIL_BYTES = 4096;
const KILL_GRACE_MS = 5000;

/**
 * Ids we put on the command line. Grok wants a UUID for `--session-id`; a
 * resumed id is one we stored earlier. Reject anything that could be read as
 * a second flag.
 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type SpawnFn = (
  cmd: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessByStdio<Writable, Readable, Readable>;

export interface GrokProcessOpts {
  projectPath: string;
  spawn?: SpawnFn;
  /**
   * When set, the next `sendUserText` resumes this Grok session (`--resume`)
   * instead of minting a new one. Used by `SessionManager.resume()`.
   */
  grokResumeSeed?: string;
  /**
   * Extra working dirs. Grok has no `--add-dir`, so they are not passed
   * through. Logged once so a Claude-shaped profile run as Grok is visible.
   */
  additionalDirs?: string[];
  /** Model id, passed as `--model`. Omitted leaves the CLI default. */
  model?: string;
  /** Reasoning effort, passed as `--effort`. Omitted leaves the CLI default. */
  effort?: CliEffortLevel;
}

export function assertGrokSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) {
    throw new Error(`unsafe grok session id: ${id}`);
  }
}

/**
 * Argv for one Grok turn.
 *
 * Headless Grok is one-shot: `grok -p` runs the prompt and exits. The first
 * turn creates a session with a client UUID (`--session-id`); later turns
 * continue it (`--resume`). `--always-approve` is load-bearing — a remote
 * browser cannot answer an interactive permission prompt, and a turn that
 * waits on one never finishes.
 */
export function buildGrokArgs(opts: {
  prompt: string;
  projectPath: string;
  model: string | null;
  effort: CliEffortLevel | null;
  sessionId: string;
  resume: boolean;
}): string[] {
  assertGrokSessionId(opts.sessionId);
  return [
    opts.resume ? '--resume' : '--session-id',
    opts.sessionId,
    '--output-format',
    'streaming-json',
    '--always-approve',
    '--cwd',
    opts.projectPath,
    '--verbatim',
    ...(opts.model !== null ? ['--model', opts.model] : []),
    ...(opts.effort !== null ? ['--effort', opts.effort] : []),
    '-p',
    opts.prompt,
  ];
}

function promptWithImages(text: string, imagePaths: readonly string[] | undefined): string {
  if (!imagePaths || imagePaths.length === 0) return text;
  const lines = imagePaths.map((p) => `- ${p}`).join('\n');
  const body = text.trim().length > 0 ? text : 'Look at the attached images.';
  return `${body}\n\n[Attached images — read these files]\n${lines}`;
}

function signalTree(
  proc: ChildProcessByStdio<Writable, Readable, Readable>,
  sig: NodeJS.Signals,
): void {
  const pid = proc.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      // ESRCH or EPERM — fall through to the child.
    }
  }
  try {
    proc.kill(sig);
  } catch {
    /* already dead */
  }
}

export class GrokProcess extends EventEmitter {
  private readonly projectPath: string;
  private model: string | null;
  private effort: CliEffortLevel | null;
  private readonly spawnFn: SpawnFn;
  /** Grok CLI session id. Null until the first turn mints one, or a resume seed. */
  private grokSessionId: string | null = null;
  private readonly resumed: boolean;
  private resumeAcknowledged = false;
  private killed = false;
  private currentTurnProc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private activeChild: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private currentTurnSawResult = false;
  private stdoutBuf = '';
  private stderrBuf: Buffer = Buffer.alloc(0);
  /** Thought chunks are joined so the transcript gets one block, not one per token. */
  private thoughtBuf = '';

  constructor(opts: GrokProcessOpts) {
    super();
    this.projectPath = opts.projectPath;
    this.model = opts.model ?? null;
    this.effort = opts.effort ?? null;
    this.spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
    if (opts.grokResumeSeed) {
      assertGrokSessionId(opts.grokResumeSeed);
      this.grokSessionId = opts.grokResumeSeed;
      this.resumed = true;
    } else {
      this.resumed = false;
    }
    if (opts.additionalDirs && opts.additionalDirs.length > 0) {
      console.warn(
        `[grok] ignoring ${opts.additionalDirs.length} additional dir(s) — CLI lacks --add-dir`,
      );
    }
  }

  /**
   * Record model/effort for the next turn. There is no live process between
   * turns, so nothing else has to be signalled.
   */
  applyModelChange(next: { model?: string; effort?: EffortLevel }): void {
    if (next.model !== undefined) {
      if (!isValidModelId(next.model)) throw new Error(`unsafe model id: ${next.model}`);
      this.model = next.model;
    }
    if (next.effort !== undefined) {
      if (!isEffortLevel(next.effort)) throw new Error(`unknown effort level: ${next.effort}`);
      // `ultracode` is a Claude mode. Callers strip it before it gets here;
      // refusing it is the backstop so it never lands on `--effort`.
      if (next.effort === 'ultracode') {
        throw new Error('ultracode is not a grok effort level');
      }
      this.effort = next.effort;
    }
  }

  sendUserText(
    text: string,
    _images?: ReadonlyArray<{ mime: string; base64: string }>,
    imagePaths?: readonly string[],
  ): void {
    if (this.currentTurnProc) {
      const stale = this.currentTurnProc;
      this.currentTurnProc = null;
      this.activeChild = null;
      signalTree(stale, 'SIGTERM');
    }
    if (this.killed) return;

    const creating = this.grokSessionId === null;
    if (creating) {
      this.grokSessionId = randomUUID();
      this.emit('cli_session_id', this.grokSessionId);
    }
    const sessionId = this.grokSessionId;
    if (sessionId === null) return;

    const prompt = promptWithImages(text, imagePaths);
    const args = buildGrokArgs({
      prompt,
      projectPath: this.projectPath,
      model: this.model,
      effort: this.effort,
      sessionId,
      resume: !creating,
    });

    const child = this.spawnFn('grok', args, {
      cwd: this.projectPath,
      // The installed CLI has no `--no-auto-update` flag. This env is what the
      // docs say suppresses the updater for the process.
      env: { ...process.env, GROK_DISABLE_AUTOUPDATER: '1' },
      // Headless Grok does not read the prompt from stdin. A piped stdin it
      // never sees closed would leave the turn hanging, same as Codex exec.
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    this.currentTurnProc = child;
    this.activeChild = child;
    this.currentTurnSawResult = false;
    this.stdoutBuf = '';
    this.stderrBuf = Buffer.alloc(0);
    this.thoughtBuf = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.activeChild !== child) return;
      this.handleStdout(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.activeChild !== child) return;
      this.handleStderr(chunk);
    });
    child.on('exit', (code) => {
      if (this.activeChild !== child) return;
      this.handleExit(code);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (this.activeChild !== child) return;
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
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    const parsed = parseGrokLine(line);
    if (!parsed) return;
    if (parsed.sessionId && parsed.sessionId !== this.grokSessionId && SESSION_ID_RE.test(parsed.sessionId)) {
      this.grokSessionId = parsed.sessionId;
      this.emit('cli_session_id', parsed.sessionId);
    }
    if (!parsed.event) return;
    if (parsed.event.kind === 'thinking') {
      this.thoughtBuf += parsed.event.text;
      this.resumeAcknowledged = true;
      return;
    }
    this.flushThought();
    if (parsed.event.kind === 'result') {
      this.currentTurnSawResult = true;
      if (!parsed.event.error) this.resumeAcknowledged = true;
    } else {
      this.resumeAcknowledged = true;
    }
    this.emit('event', parsed.event);
  }

  private flushThought(): void {
    if (this.thoughtBuf.length === 0) return;
    const text = this.thoughtBuf;
    this.thoughtBuf = '';
    this.emit('event', { kind: 'thinking', text } satisfies AgentEvent);
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
    setImmediate(() => this.finaliseExit(code));
  }

  private finaliseExit(code: number | null): void {
    if (this.stdoutBuf.length > 0) {
      const tail = this.stdoutBuf;
      this.stdoutBuf = '';
      this.consumeLine(tail);
    }
    this.flushThought();

    if (this.currentTurnSawResult) return;

    const nonZeroExit = code !== 0 && code !== null;
    let error: string | undefined;
    if (nonZeroExit) {
      if (this.resumed && !this.resumeAcknowledged) {
        error = 'grok_resume_rejected';
      } else {
        const tail = this.stderrBuf.toString('utf8').trim();
        error = tail.length > 0
          ? (tail.length > 1024 ? tail.slice(-1024) : tail)
          : `grok exited with code ${code}`;
      }
    }
    this.emit('event', {
      kind: 'result',
      ...(error !== undefined ? { error } : {}),
    } satisfies AgentEvent);
  }

  stderrTail(): string {
    return this.stderrBuf.toString('utf8');
  }

  /**
   * Stop the turn in flight. The session id survives, so the next prompt
   * resumes. Does not emit `exit` — that ends the session.
   */
  interrupt(): void {
    if (this.killed) return;
    const proc = this.currentTurnProc;
    if (!proc) return;
    this.currentTurnProc = null;
    this.activeChild = null;
    this.thoughtBuf = '';
    signalTree(proc, 'SIGTERM');
    setTimeout(() => signalTree(proc, 'SIGKILL'), KILL_GRACE_MS).unref();
    this.emit('event', { kind: 'result', error: 'interrupted' } satisfies AgentEvent);
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    const proc = this.currentTurnProc;
    this.currentTurnProc = null;
    this.activeChild = null;
    this.thoughtBuf = '';
    if (proc) {
      signalTree(proc, 'SIGTERM');
      setTimeout(() => {
        signalTree(proc, 'SIGKILL');
      }, KILL_GRACE_MS).unref();
    }
    this.emit('exit', null, proc ? 'stopped' : 'idle_stop');
  }
}
