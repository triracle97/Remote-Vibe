import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcessByStdio, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { parseClaudeLine } from './parser.js';
import type { AgentEvent } from './types.js';

const STDERR_TAIL_BYTES = 4096;
const KILL_GRACE_MS = 5000;

export type SpawnFn = (cmd: string, args: string[], options: SpawnOptions) => ChildProcessByStdio<Writable, Readable, Readable>;

const CLAUDE_FLAGS = [
  '-p',
  '--dangerously-skip-permissions',
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--include-partial-messages',
  '--verbose',
].join(' ');

export interface ClaudeProcessEvents {
  event: (e: AgentEvent) => void;
  exit: (code: number | null, reason?: string) => void;
}

export class ClaudeProcess extends EventEmitter {
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private stdoutBuf = '';
  private stderrBuf = Buffer.alloc(0);
  private killed = false;

  constructor(projectPath: string, opts: { spawn?: SpawnFn } = {}) {
    super();
    const spawnFn = (opts.spawn ?? (nodeSpawn as unknown as SpawnFn));
    const argv = ['-li', '-c', `exec claude ${CLAUDE_FLAGS}`];
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
      const ev = parseClaudeLine(line);
      if (ev) this.emit('event', ev);
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

  sendUserText(text: string): void {
    const line =
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
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
