import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcessByStdio, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { parseClaudeLine } from './parser.js';
import {
  isEffortLevel,
  isValidModelId,
  type CliEffortLevel,
  type EffortLevel,
} from './models.js';
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
  // Subagents are otherwise a black box: the transcript shows one `Task` call
  // and then nothing until it returns, however long it runs. This forwards
  // their text and thinking as ordinary messages carrying `parent_tool_use_id`,
  // which is what lets the UI nest them under the call that started them. The
  // CLI only honours it under `--print` with `--output-format stream-json`,
  // which is exactly how the bridge spawns.
  '--forward-subagent-text',
];
const CLAUDE_FLAGS = CLAUDE_FLAG_TOKENS.join(' ');

/**
 * Resume args are uuids + literal `--resume`, so they need no quoting in
 * practice. We still validate to be defensive: reject anything that contains
 * shell metacharacters or whitespace, since a bad value would let the caller
 * inject arbitrary shell at the `exec claude ...` line.
 *
 * Also applied to `--add-dir` paths, the headroom binary and CLAUDE_CONFIG_DIR,
 * all of which are interpolated into the same command line. Note `~` is NOT in
 * the allowlist — callers must pass absolute paths (see `resolveHomePath` in
 * env.ts).
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
  /**
   * Phase 6: additional working dirs. Each is passed as `--add-dir <dir>` to
   * Claude so it can read/write files outside the primary cwd. Each path is
   * validated by `assertResumeArgSafe` (same allowlist as `resumeArgs`) to
   * prevent shell-meta injection at the `exec claude ...` line.
   */
  additionalDirs?: string[];
  /**
   * Absolute CLAUDE_CONFIG_DIR for this session. Swaps the entire Claude
   * profile — settings, hooks, enabled plugins, slash commands, and native
   * session history. Must be absolute (`~` fails `assertResumeArgSafe`).
   */
  claudeConfigDir?: string;
  /**
   * Absolute path to an MCP config JSON, passed as `--mcp-config <path>`.
   *
   * A file rather than the inline-JSON form the flag also accepts: inline JSON
   * would have to survive `assertResumeArgSafe`, which rejects braces and
   * quotes precisely because everything here lands on a `zsh -lic` line. A path
   * made of `[A-Za-z0-9_./-]` passes cleanly.
   *
   * Deliberately NOT paired with `--strict-mcp-config`: this adds the bridge's
   * own server, it does not take over the user's MCP setup.
   */
  mcpConfigPath?: string;
  /**
   * When set, `claude` is launched through `headroom wrap claude` so its API
   * traffic routes via the local Headroom proxy. The proxy itself is owned by
   * the bridge (see `headroom.ts`), hence `--no-proxy`.
   */
  headroom?: { bin: string; port: number };
  /**
   * Extra system-prompt text, passed as `--append-system-prompt`. Used to tell
   * the agent about the board directives it can emit (see `agent-directives.ts`).
   */
  appendSystemPrompt?: string;
  /**
   * Model alias or full id, passed as `--model`. Aliases (`opus`, `sonnet`,
   * `haiku`, `fable`) always resolve to the latest model on that line.
   */
  model?: string;
  /**
   * Reasoning effort, passed as `--effort`. Omitted leaves the CLI default.
   *
   * Deliberately not `EffortLevel`: `ultracode` is a mode carried in the
   * settings file, and the CLI accepts `--effort ultracode` as a plain alias
   * for `xhigh`, so passing it here would look like it worked while turning
   * none of the mode on. Callers resolve it with `cliEffortLevel` first.
   */
  effort?: CliEffortLevel;
  /**
   * Absolute path to a session settings JSON, passed as `--settings <path>`.
   *
   * How ultracode and the workflow settings reach the session — see
   * `claude-settings.ts` for why it is a file and not inline JSON.
   */
  settingsPath?: string;
}

/**
 * Single-quote a value for the `zsh -c` command line.
 *
 * Everything else interpolated into that line goes through
 * `assertResumeArgSafe`, but the system prompt is prose — it legitimately
 * contains spaces, `|`, `<`, `>` — so it needs real quoting instead.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the `zsh -lic` command line.
 *
 * Two shapes:
 *   plain     `exec claude <flags>`
 *   headroom  `exec <bin> wrap claude --port N --no-proxy ... -- <flags>`
 *
 * The `--` separator is mandatory: headroom's own `-p/--port` and
 * `-v/--verbose` collide with claude's `-p` and `--verbose`, and Click parses
 * known options even under `ignore_unknown_options`.
 *
 * `--no-mcp --no-serena --no-rtk` are load-bearing. Those steps rewrite the
 * active Claude config dir; with concurrent sessions they would race on the
 * same `.claude.json`, and we do not want the bridge silently editing the
 * user's profile.
 *
 * `exec` is safe on both branches — headroom is the process being replaced, and
 * it reaps `claude` itself via `subprocess.run`.
 */
export function buildClaudeCommand(opts: {
  claudeFlags: string;
  headroom?: { bin: string; port: number } | undefined;
}): string {
  const { claudeFlags, headroom } = opts;
  if (!headroom) return `exec claude ${claudeFlags}`;
  assertResumeArgSafe(headroom.bin);
  return (
    `exec ${headroom.bin} wrap claude --port ${headroom.port} ` +
    `--no-proxy --no-mcp --no-serena --no-rtk -- ${claudeFlags}`
  );
}

export class ClaudeProcess extends EventEmitter {
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private stdoutBuf = '';
  private stderrBuf = Buffer.alloc(0);
  private killed = false;
  private claudeSessionIdEmitted = false;
  /** Distinguishes successive interrupt requests in the CLI's responses. */
  private interruptSeq = 0;
  /** True iff this driver was spawned with --resume; used by SessionManager to classify exit reason. */
  readonly resumed: boolean;

  constructor(projectPath: string, opts: ClaudeProcessOpts = {}) {
    super();
    const spawnFn = (opts.spawn ?? (nodeSpawn as unknown as SpawnFn));
    const resumeArgs = opts.resumeArgs ?? [];
    for (const t of resumeArgs) assertResumeArgSafe(t);
    this.resumed = resumeArgs.length > 0;
    // Phase 6: --add-dir flags follow resumeArgs but precede the standard
    // CLAUDE_FLAGS. Each token is validated through the same shell-safety
    // gate as resumeArgs; absolute filesystem paths are valid under the
    // [A-Za-z0-9_./-] allowlist.
    const additionalDirs = opts.additionalDirs ?? [];
    const addDirArgs: string[] = [];
    for (const d of additionalDirs) {
      assertResumeArgSafe(d);
      addDirArgs.push('--add-dir', d);
    }
    // Resume tokens are prepended to the existing claude argv so the final
    // shell command is `exec claude --resume <id> --add-dir <dir>... -p --dangerously-skip-permissions ...`.
    const claudePrefix = resumeArgs.length > 0 ? `${resumeArgs.join(' ')} ` : '';
    const mcpConfigPath = opts.mcpConfigPath;
    if (mcpConfigPath !== undefined) assertResumeArgSafe(mcpConfigPath);
    const mcpFlag = mcpConfigPath !== undefined ? `--mcp-config ${mcpConfigPath} ` : '';
    const settingsPath = opts.settingsPath;
    if (settingsPath !== undefined) assertResumeArgSafe(settingsPath);
    const settingsFlag = settingsPath !== undefined ? `--settings ${settingsPath} ` : '';
    const addDirPrefix = addDirArgs.length > 0 ? `${addDirArgs.join(' ')} ` : '';
    const appendPrompt = opts.appendSystemPrompt;
    const promptFlag =
      appendPrompt !== undefined && appendPrompt.length > 0
        ? `--append-system-prompt ${shellQuote(appendPrompt)} `
        : '';
    // `--model` is shell-quoted rather than run through assertResumeArgSafe:
    // the extended-context spelling (`opus[1m]`) contains brackets, which that
    // allowlist rejects. isValidModelId is the gate; quoting handles the rest.
    const { model, effort } = opts;
    if (model !== undefined && !isValidModelId(model)) {
      throw new Error(`unsafe model id: ${model}`);
    }
    // The `ultracode` check is redundant against the declared type and kept
    // anyway: it is the one value that would otherwise spawn cleanly, cost
    // xhigh money, and turn none of the mode on — the quietest possible way
    // to not ship the feature. Types do not reach callers coming over the wire.
    if (effort !== undefined && (!isEffortLevel(effort) || (effort as string) === 'ultracode')) {
      throw new Error(`unknown effort level: ${effort}`);
    }
    const modelFlag = model !== undefined ? `--model ${shellQuote(model)} ` : '';
    const effortFlag = effort !== undefined ? `--effort ${effort} ` : '';
    const claudeFlags =
      `${claudePrefix}${addDirPrefix}${mcpFlag}${settingsFlag}${modelFlag}${effortFlag}${promptFlag}${CLAUDE_FLAGS}`;
    const claudeConfigDir = opts.claudeConfigDir;
    if (claudeConfigDir !== undefined) assertResumeArgSafe(claudeConfigDir);
    const argv = [
      '-li',
      '-c',
      buildClaudeCommand({ claudeFlags, headroom: opts.headroom }),
    ];
    this.child = spawnFn('zsh', argv, {
      cwd: projectPath,
      env: {
        ...process.env,
        ...(claudeConfigDir !== undefined ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group so kill() can signal the whole tree. Under headroom,
      // `claude` is a grandchild: Python's default SIGTERM handling exits
      // without forwarding, which would orphan the agent. Never unref'd — the
      // bridge must not exit with live children.
      detached: true,
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
      // One line can carry several events — an assistant message often holds
      // prose plus one or more tool calls.
      for (const parsed of parseClaudeLine(line)) {
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

  /**
   * Stop the turn in flight, leaving the session alive.
   *
   * The CLI takes this on stdin as a control request and answers with a
   * `control_response`; verified against claude-cli directly — the turn ends
   * with `result.subtype = error_during_execution` and the **process keeps
   * running**, ready for the next prompt. That is the whole reason stop can
   * mean "stop this turn" rather than "kill the session".
   *
   * Best-effort: a write to a closed stdin is swallowed the same way
   * `sendUserText`'s is, because an interrupt racing a natural turn end is
   * normal, not an error.
   */
  interrupt(): void {
    if (this.killed) return;
    this.interruptSeq += 1;
    const line = JSON.stringify({
      type: 'control_request',
      request_id: `mrt-interrupt-${this.interruptSeq}`,
      request: { subtype: 'interrupt' },
    }) + '\n';
    try {
      this.child.stdin.write(line);
    } catch {
      /* stdin already gone — the turn is over anyway */
    }
  }

  /**
   * Switch model and/or effort on a running session.
   *
   * The CLI accepts `/model <alias>` and `/effort <level>` as ordinary user
   * messages on the stream-json stdin and applies them immediately — verified
   * against claude 2.x, where a session spawned `--model haiku` reported
   * `claude-sonnet-5` on the turn after `/model sonnet`. So no restart, and
   * no lost transcript.
   *
   * The CLI answers each with a one-line confirmation ("Set model to Sonnet 5
   * for this session only"), which flows through as a normal assistant message.
   */
  applyModelChange(next: { model?: string; effort?: EffortLevel }): void {
    if (next.model !== undefined) {
      if (!isValidModelId(next.model)) throw new Error(`unsafe model id: ${next.model}`);
      this.sendUserText(`/model ${next.model}`);
    }
    if (next.effort !== undefined) {
      if (!isEffortLevel(next.effort)) throw new Error(`unknown effort level: ${next.effort}`);
      this.sendUserText(`/effort ${next.effort}`);
    }
  }

  /**
   * Signal the child's whole process group, falling back to the direct child.
   *
   * We spawn `detached`, so the child leads its own group and `kill(-pid)`
   * reaches grandchildren too. That matters under headroom, where `claude` is a
   * grandchild that would otherwise survive the wrapper's death.
   */
  private signalTree(sig: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, sig);
        return;
      } catch {
        // ESRCH (group already gone) or EPERM — fall through to the child.
      }
    }
    try {
      this.child.kill(sig);
    } catch {
      /* already dead */
    }
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.signalTree('SIGTERM');
    setTimeout(() => {
      this.signalTree('SIGKILL');
    }, KILL_GRACE_MS).unref();
  }
}
