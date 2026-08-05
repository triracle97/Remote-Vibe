import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcessByStdio, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { parseCodexLine } from './codex-parser.js';
import { isEffortLevel, isValidModelId, type EffortLevel } from './models.js';
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
  /**
   * When set, pre-populates this.codexSessionId so the next sendUserText
   * invokes `codex exec resume <id>`. Used by SessionManager.resume() to
   * resume a previously-known Codex CLI session on the user's first turn.
   */
  codexResumeSeed?: string;
  /**
   * Phase 6: additional working dirs stored for diagnostics. The Codex CLI
   * does NOT support a `--add-dir` equivalent, so these are not passed to
   * spawn. SessionManager surfaces a one-time warning at construction.
   */
  additionalDirs?: string[];
  /** Model id, passed as `--model`. Omitted leaves the CLI/config default. */
  model?: string;
  /**
   * Reasoning effort, passed as `-c model_reasoning_effort=<level>`. Codex has
   * no dedicated flag; the config override is the documented route.
   */
  effort?: EffortLevel;
  /**
   * When set, `codex` is launched through `headroom wrap codex` so its API
   * traffic routes via the shared proxy. The proxy is started once by the
   * bridge (see `headroom.ts`), hence `--no-proxy`.
   */
  headroom?: { bin: string; port: number };
}

/**
 * Reject anything that is not a plain path/identifier.
 *
 * Codex is spawned via argv, not a shell, so this is not injection defence the
 * way the Claude driver's equivalent is — nothing here reaches a shell. It is a
 * sanity gate on a value that comes from the environment (`BRIDGE_HEADROOM_BIN`)
 * and keeps the two drivers' accepted shapes identical.
 */
function assertHeadroomBinSafe(bin: string): void {
  if (!/^[A-Za-z0-9_./-]+$/.test(bin)) {
    throw new Error(`unsafe headroom bin: ${bin}`);
  }
}

/**
 * Build the argv for one Codex turn.
 *
 * Two shapes:
 *   plain     `codex <codexArgs>`
 *   headroom  `<bin> wrap codex --port N --no-proxy ... -- <codexArgs>`
 *
 * The `--` separator is mandatory, same as the Claude driver: headroom's own
 * `-p/--port` and `-v/--verbose` are real Click options and would be consumed
 * before Codex ever saw them.
 *
 * `--no-mcp --no-serena --no-rtk` are load-bearing, and more so here than for
 * Claude — `headroom wrap codex` registers its MCP server in the *active Codex
 * config file*. Concurrent sessions would race on that file, and the bridge has
 * no business rewriting the user's Codex profile behind their back.
 */
export function buildCodexSpawn(opts: {
  codexArgs: string[];
  headroom?: { bin: string; port: number } | undefined;
}): { cmd: string; args: string[] } {
  const { codexArgs, headroom } = opts;
  if (!headroom) return { cmd: 'codex', args: codexArgs };
  assertHeadroomBinSafe(headroom.bin);
  return {
    cmd: headroom.bin,
    args: [
      'wrap',
      'codex',
      '--port',
      String(headroom.port),
      '--no-proxy',
      '--no-mcp',
      '--no-serena',
      '--no-rtk',
      '--',
      ...codexArgs,
    ],
  };
}

/**
 * Signal a turn's whole process group, falling back to the direct child.
 *
 * Turns are spawned `detached`, so the child leads its own group and
 * `kill(-pid)` reaches grandchildren. That is what makes headroom safe here:
 * under the wrapper `codex` is a grandchild, and Python's default SIGTERM
 * handling exits without forwarding, which would leave the agent orphaned and
 * still burning tokens.
 */
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
      // ESRCH (group already gone) or EPERM — fall through to the child.
    }
  }
  try {
    proc.kill(sig);
  } catch {
    /* already dead */
  }
}

export class CodexProcess extends EventEmitter {
  private readonly projectPath: string;
  private readonly codexHome: string;
  private model: string | null;
  private effort: EffortLevel | null;
  private readonly spawnFn: SpawnFn;
  /**
   * The Codex CLI session uuid for this driver. Mutates from null → uuid on
   * first session_id event from the CLI; once set, sendUserText switches to
   * `codex exec [opts] resume <id>` so the CLI continues the same conversation.
   */
  private codexSessionId: string | null = null;
  /**
   * True iff this driver was instantiated with codexResumeSeed (a stale uuid
   * persisted from a prior session). Used so the SessionManager can classify
   * the FIRST turn's exit as `codex_resume_rejected` if it fails.
   */
  readonly resumed: boolean;
  /**
   * Flips true once a `session_id` event is observed during this driver's
   * lifetime. For non-resumed drivers this is the first time codex emits one;
   * for resumed drivers it's the moment the CLI confirms our seed survived
   * (accepted resume). When still false at first-turn exit on a resumed
   * driver, we treat it as a rejection of the seed.
   */
  private resumeAcknowledged = false;
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
  private readonly headroom: { bin: string; port: number } | undefined;

  constructor(opts: CodexProcessOpts) {
    super();
    this.projectPath = opts.projectPath;
    this.codexHome = opts.codexHome;
    this.model = opts.model ?? null;
    this.effort = opts.effort ?? null;
    this.headroom = opts.headroom;
    this.spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
    if (opts.codexResumeSeed) {
      this.codexSessionId = opts.codexResumeSeed;
      this.resumed = true;
    } else {
      this.resumed = false;
    }
    // Phase 6: warn once per spawn if the caller passed additionalDirs. The
    // Codex CLI lacks `--add-dir`, so we have nowhere to forward them; the
    // diagnostic helps developers spot Profiles authored with Claude in mind
    // that are then run against Codex.
    if (opts.additionalDirs && opts.additionalDirs.length > 0) {
      console.warn(
        `[codex] ignoring ${opts.additionalDirs.length} additional dir(s) — CLI lacks --add-dir`,
      );
    }
  }

  /**
   * Switch model and/or effort for subsequent turns.
   *
   * Codex spawns a fresh `codex exec` per turn, so there is no live process to
   * signal — recording the new values is enough and the next turn picks them
   * up. This mirrors how nimbalyst handles it (`SessionManager.updateSessionModel`),
   * which is the only option on a per-turn driver. The Claude driver can do
   * better and switches in place; see `ClaudeProcess.applyModelChange`.
   */
  applyModelChange(next: { model?: string; effort?: EffortLevel }): void {
    if (next.model !== undefined) {
      if (!isValidModelId(next.model)) throw new Error(`unsafe model id: ${next.model}`);
      this.model = next.model;
    }
    if (next.effort !== undefined) {
      if (!isEffortLevel(next.effort)) throw new Error(`unknown effort level: ${next.effort}`);
      this.effort = next.effort;
    }
  }

  sendUserText(
    text: string,
    _images?: ReadonlyArray<{ mime: string; base64: string }>,
    imagePaths?: readonly string[],
  ): void {
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
      signalTree(stale, 'SIGTERM');
    }
    if (this.killed) return;
    // Read at turn time, not construction time, so a mid-session switch takes
    // effect on the very next turn. Codex spawns per turn, so that is free —
    // there is no live process to signal, unlike the Claude driver.
    // `codex exec -i <FILE>` attaches images to the prompt of that invocation.
    // Because this driver spawns once per turn, every turn is an "initial
    // prompt" as far as the CLI is concerned, so images work on any turn and
    // not just the first.
    const imageArgs = (imagePaths ?? []).flatMap((p) => ['-i', p]);
    const baseArgs = [
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      ...imageArgs,
      ...(this.model !== null ? ['--model', this.model] : []),
      ...(this.effort !== null ? ['-c', `model_reasoning_effort=${this.effort}`] : []),
      '-C',
      this.projectPath,
    ];
    const codexArgs =
      this.codexSessionId === null
        ? ['exec', ...baseArgs, text]
        : ['exec', ...baseArgs, 'resume', this.codexSessionId, text];
    const { cmd, args } = buildCodexSpawn({ codexArgs, headroom: this.headroom });

    const child = this.spawnFn(cmd, args, {
      cwd: this.projectPath,
      env: { ...process.env, CODEX_HOME: this.codexHome },
      // stdin MUST be ignored. Codex's `exec` reads piped stdin as
      // additional prompt input ("Reading additional input from stdin...")
      // and won't run until EOF. Since we pass the prompt as argv, leaving
      // stdin as 'pipe' without writing/closing it makes the child hang
      // forever — observed against codex-cli 0.128.0 in development.
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group so a stop can signal the whole tree. Under headroom
      // `codex` is a grandchild of the Python wrapper, which exits on SIGTERM
      // without forwarding — killing only the direct child would orphan the
      // agent mid-turn. Never unref'd: the bridge must not exit with live
      // children.
      detached: true,
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
        // session_id capture — store + emit `cli_session_id` upstream so the
        // SessionManager can persist the CLI's session uuid into the registry.
        // Idempotent: only emit on the FIRST observation per driver lifetime.
        // The `=== null` guard MUST evaluate before the assignment below.
        if (this.codexSessionId === null) {
          this.emit('cli_session_id', parsed.id);
        }
        this.codexSessionId = parsed.id;
        this.currentTurnSawSessionId = true;
        // Either way, the CLI is alive enough to echo a session id, so a
        // resumed driver can no longer be classified as `codex_resume_rejected`
        // for any future failure on this driver.
        this.resumeAcknowledged = true;
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
        // First-turn failure on a resumed driver = stale uuid; classify so the
        // SessionManager can broadcast a typed `codex_resume_rejected` error.
        // After this first turn, `resumed` stays true but `currentTurnSawSessionId`
        // would have flipped on success, so we use the absence of a captured
        // session-id event during the lifetime of this driver as the resume
        // signal: the CLI didn't echo our seeded id.
        if (this.resumed && !this.resumeAcknowledged) {
          result.error = 'codex_resume_rejected';
        } else {
          const tail = this.stderrBuf.toString('utf8').trim();
          if (tail.length > 0) {
            result.error = tail.length > 1024 ? tail.slice(-1024) : tail;
          } else {
            result.error = `codex exec exited with code ${code}`;
          }
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

  /**
   * Stop the turn in flight, leaving the session usable.
   *
   * This driver spawns one `codex exec` per turn, so killing that child *is*
   * the interrupt — the session's identity lives in `codexSessionId`, and the
   * next turn resumes from it. Deliberately does not emit `exit`: that is what
   * `kill()` means, and it would end the session.
   */
  interrupt(): void {
    if (this.killed) return;
    const proc = this.currentTurnProc;
    if (!proc) return;
    // Clear both refs before signalling so the child's own exit handler sees no
    // current turn and stays quiet — this method owns the terminating event.
    this.currentTurnProc = null;
    this.activeChild = null;
    signalTree(proc, 'SIGTERM');
    setTimeout(() => signalTree(proc, 'SIGKILL'), KILL_GRACE_MS).unref();
    // Close the turn in the UI. Without this the transcript keeps a tool call
    // spinning forever, because no `result` is coming.
    this.emit('event', { kind: 'result', error: 'interrupted' } satisfies AgentEvent);
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    const proc = this.currentTurnProc;
    this.currentTurnProc = null; // ensure handleExit's natural-exit path no-ops
    this.activeChild = null; // suppress any deferred data/exit from killed child
    if (proc) {
      signalTree(proc, 'SIGTERM');
      setTimeout(() => {
        signalTree(proc, 'SIGKILL');
      }, KILL_GRACE_MS).unref();
    }
    // Always emit a terminal 'exit' so SessionManager fires session_ended,
    // closes the transcript file, and removes the session — even when no
    // turn is in flight (between Codex turns the spawn-per-turn driver has
    // no live child process to wait on).
    this.emit('exit', null, proc ? 'stopped' : 'idle_stop');
  }
}
