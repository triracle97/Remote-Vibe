import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcessByStdio, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { parseClaudeLine } from './parser.js';
import type { AgentEvent } from './types.js';

const STDERR_TAIL_BYTES = 4096;
const KILL_GRACE_MS = 5000;

export type SpawnFn = (cmd: string, args: string[], options: SpawnOptions) => ChildProcessByStdio<Writable, Readable, Readable>;

const CLAUDE_FLAG_TOKENS = [
  '-p',
  '--dangerously-skip-permissions',
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--include-partial-messages',
  '--verbose',
];
const CLAUDE_FLAGS = CLAUDE_FLAG_TOKENS.join(' ');

/**
 * Resume args are uuids + literal `--resume`, so they need no quoting in
 * practice. We still validate to be defensive: reject anything that contains
 * shell metacharacters or whitespace, since a bad value would let the caller
 * inject arbitrary shell at the `exec claude ...` line.
 */
function assertResumeArgSafe(token: string): void {
  if (!/^[A-Za-z0-9_./-]+$/.test(token)) {
    throw new Error(`unsafe resume arg token: ${token}`);
  }
}

export interface ClaudeProcessEvents {
  event: (e: AgentEvent) => void;
  exit: (code: number | null, reason?: string) => void;
}

export interface ClaudeProcessOpts {
  spawn?: SpawnFn;
  /**
   * When set, the spawn args are prepended with these tokens (e.g. ['--resume', '<id>']).
   * Used by SessionManager.resume() to ask Claude to resume an existing CLI conversation.
   */
  resumeArgs?: string[];
}

export class ClaudeProcess extends EventEmitter {
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private stdoutBuf = '';
  private stderrBuf = Buffer.alloc(0);
  private killed = false;
  private claudeSessionIdEmitted = false;
  /** True iff this driver was spawned with --resume; used by SessionManager to classify exit reason. */
  readonly resumed: boolean;

  constructor(projectPath: string, opts: ClaudeProcessOpts = {}) {
    super();
    const spawnFn = (opts.spawn ?? (nodeSpawn as unknown as SpawnFn));
    const resumeArgs = opts.resumeArgs ?? [];
    for (const t of resumeArgs) assertResumeArgSafe(t);
    this.resumed = resumeArgs.length > 0;
    // Resume tokens are prepended to the existing claude argv so the final
    // shell command is `exec claude --resume <id> -p --dangerously-skip-permissions ...`.
    const claudePrefix = resumeArgs.length > 0 ? `${resumeArgs.join(' ')} ` : '';
    const argv = ['-li', '-c', `exec claude ${claudePrefix}${CLAUDE_FLAGS}`];
    this.child = spawnFn('zsh', argv, {
      cwd: projectPath,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => this.handleStderr(chunk));
    this.child.on('exit', (code) => this.emit('exit', code));
    // ENOENT (claude not on PATH) and other spawn errors arrive on the
    // child's `error` event instead of `exit`. Without a listener, Node
    // throws and crashes the bridge. Translate into the same `exit` event
    // shape with a reason so SessionManager can surface a typed error.
    this.child.on('error', (err: NodeJS.ErrnoException) => {
      const reason = err.code === 'ENOENT' ? 'agent_not_installed' : 'spawn_failed';
      this.emit('exit', null, reason);
    });

    // Swallow stdin EPIPE: when the agent exits, its stdin closes asynchronously
    // before the child 'exit' event fires. Without this, a write() in the gap
    // becomes an uncaught stream error and crashes the bridge. The 'exit' event
    // will fire next tick and SessionManager will mark the session dead via
    // onProcExit.
    this.child.stdin.on('error', () => {});
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.length === 0) continue;
      const parsed = parseClaudeLine(line);
      if (parsed === null) continue;
      if (parsed.kind === 'session_id') {
        // Capture Claude's CLI session uuid — emit once per driver lifetime
        // so SessionManager can persist it. Do NOT pass through to the
        // downstream `event` channel.
        if (!this.claudeSessionIdEmitted) {
          this.emit('cli_session_id', parsed.id);
          this.claudeSessionIdEmitted = true;
        }
        continue;
      }
      this.emit('event', parsed);
    }
  }

  private handleStderr(chunk: Buffer): void {
    this.stderrBuf = Buffer.concat([this.stderrBuf, chunk]);
    if (this.stderrBuf.length > STDERR_TAIL_BYTES) {
      this.stderrBuf = this.stderrBuf.subarray(this.stderrBuf.length - STDERR_TAIL_BYTES);
    }
  }

  stderrTail(): string {
    return this.stderrBuf.toString('utf8');
  }

  sendUserText(text: string, images?: ReadonlyArray<{ mime: string; base64: string }>): void {
    const content: Array<unknown> = [{ type: 'text', text }];
    if (images) {
      for (const img of images) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mime, data: img.base64 },
        });
      }
    }
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
    }) + '\n';
    this.child.stdin.write(line);
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.child.kill('SIGTERM');
    setTimeout(() => {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }, KILL_GRACE_MS).unref();
  }
}
