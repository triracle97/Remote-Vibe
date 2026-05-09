import { EventEmitter } from 'node:events';
import { realpath as fsRealpath, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClaudeProcess } from './claude-process.js';
import type { TranscriptStore } from './transcript-store.js';
import type { CodexAccount } from './accounts.js';
import type { PromptStore } from './prompt-store.js';
import type { ImageStore } from './image-store.js';
import type { Notifier } from './notifier.js';
import type { SessionRegistry, RegistryEntry } from './session-registry.js';
import { PathOutsideAllowlistError, makePathValidator } from './path-allowlist.js';
export { PathOutsideAllowlistError } from './path-allowlist.js';
import type {
  AgentEvent,
  AgentKind,
  ServerLifecycleMsg,
  ServerSessionRenamedMsg,
  ServerStreamMsg,
} from './types.js';
import { loadReplayEvents, type ReplayEvent } from './native-history-replay.js';
import { DEFAULT_WORKSPACE_DIRS } from './default-workspaces.js';

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
  sendUserText(text: string, images?: ReadonlyArray<{ mime: string; base64: string }>): void;
  kill(): void;
}

export interface DriverFactoryArgs {
  agent: AgentKind;
  projectPath: string;
  account?: CodexAccount;
  /** Phase 5 — Claude resume tokens (e.g. ['--resume', '<id>']). */
  resumeArgs?: string[];
  /** Phase 5 — Codex CLI session uuid to seed driver state. */
  codexResumeSeed?: string;
  /** Phase 6 — additional working dirs (Claude: --add-dir; Codex: ignored with warning). */
  additionalDirs?: string[];
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
  promptStore?: PromptStore;
  imageStore?: ImageStore;
  /** Phase 5 — disk-persisted webSessionId → metadata map. */
  registry?: SessionRegistry;
  /** Phase 5 — directory under which transcript files live (relative). */
  transcriptDir?: string;
  /** Phase 5 — pluggable stat fn for the resume-time projectPath existence check. */
  stat?: (p: string) => Promise<{ isDirectory(): boolean }>;
  /** Phase 5 — early-exit window before classifying claude --resume as alive. */
  claudeResumeSettleMs?: number;
  /** Phase 6 — Telegram notifier; subscribed to input/result/session_ended. */
  notifier?: Notifier;
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

export class InvalidSessionNameError extends Error {
  code = 'session_name_invalid' as const;
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
  private readonly promptStore: PromptStore | undefined;
  private readonly imageStore: ImageStore | undefined;
  private readonly registry: SessionRegistry | undefined;
  private readonly transcriptDir: string;
  private readonly stat: (p: string) => Promise<{ isDirectory(): boolean }>;
  private readonly claudeResumeSettleMs: number;
  private readonly notifier: Notifier | null;
  private readonly validatePathFn: (projectPath: string) => Promise<string>;
  private readonly resumeInFlight = new Map<string, Promise<void>>();
  /**
   * Phase 7 — replay-on-resume. Populated by `resumeFromHistoryEntry` BEFORE
   * `resume()` runs; drained by `attachSession` immediately after the
   * synthesized `session_created` (seq=1) and BEFORE driver listeners wire,
   * so prior CLI turns occupy seq=2..N+1 and live driver events follow.
   */
  private readonly pendingReplays = new Map<string, ReplayEvent[]>();
  /** Track spawn count for tests / observability. Incremented on every driver instantiation. */
  spawnCallCount = 0;

  constructor(opts: SessionManagerOpts) {
    super();
    this.allowedDirs = opts.allowedDirs;
    this.bufferCap = opts.bufferCap;
    this.realpath = opts.realpath ?? fsRealpath;
    this.transcriptStore = opts.transcriptStore;
    this.accounts = opts.accounts ?? new Map();
    this.promptStore = opts.promptStore;
    this.imageStore = opts.imageStore;
    this.registry = opts.registry;
    this.transcriptDir = opts.transcriptDir ?? join('.bridge', 'transcripts');
    this.stat = opts.stat ?? ((p) => fsStat(p));
    this.claudeResumeSettleMs = opts.claudeResumeSettleMs ?? 1500;
    this.notifier = opts.notifier ?? null;
    this.validatePathFn = makePathValidator({
      allowedDirs: this.allowedDirs,
      realpath: this.realpath,
    });
    if (opts.driverFactory) {
      const userFactory = opts.driverFactory;
      this.driverFactory = (args) => {
        this.spawnCallCount += 1;
        return userFactory(args);
      };
    } else if (opts.spawnClaude) {
      const spawnClaude = opts.spawnClaude;
      this.driverFactory = ({ agent, projectPath }) => {
        if (agent !== 'claude') {
          throw new Error(`agent ${agent} not supported by this SessionManager (claude-only factory)`);
        }
        this.spawnCallCount += 1;
        return spawnClaude(projectPath) as unknown as AgentDriver;
      };
    } else {
      throw new Error('SessionManager: either driverFactory or spawnClaude must be provided');
    }
  }

  private async validatePath(projectPath: string): Promise<string> {
    return this.validatePathFn(projectPath);
  }

  private isAllowedDir(realPath: string): boolean {
    return this.allowedDirs.some((d) => realPath === d || realPath.startsWith(d + '/'));
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
    const sessionId = this.mintWebSessionId();
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
    this.registerInternalSession(internal);

    // Write registry entry up-front so cli_session_id capture (handled inside
    // registerInternalSession's event wiring) has an entry to update. The
    // entry starts with both CLI ids null; the first cli_session_id event
    // fills the appropriate one.
    if (this.registry) {
      await this.registry.add({
        webSessionId: sessionId,
        agent: params.agent,
        projectPath: real,
        transcriptPath: this.transcriptPathFor(sessionId),
        claudeSessionId: null,
        codexSessionId: null,
        createdAt: internal.createdAt,
        account: account ? account.name : null,
        name: null,
        additionalDirs: [],
      });
    }

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

    return {
      sessionId,
      agent: internal.agent,
      projectPath: internal.projectPath,
      createdAt: internal.createdAt,
      ...(account ? { account: account.name } : {}),
    };
  }

  /**
   * Phase 6 — Multi-dir spawn. Generalisation of `create()` that accepts a
   * primary cwd plus additional working dirs. Validation:
   *   - dirs must be non-empty
   *   - every dir must pass the same allowlist+realpath check as projectPath
   *   - exact-match duplicates are de-duped (after realpath resolution)
   *
   * Per-agent semantics:
   *   - Claude: dirs[1..] are passed as `--add-dir <dir>` via the driver.
   *   - Codex: dirs[1..] are stored in the registry for diagnostics; the
   *     CodexProcess constructor logs a one-time warning that they are
   *     ignored (Codex CLI lacks a `--add-dir` equivalent).
   *
   * Returns the same SessionInfo shape as `create()` so existing callers
   * (e.g. websocket handlers) can forward without translation.
   */
  async spawnSession(params: {
    agent: AgentKind;
    dirs: string[];
    account?: string;
    correlationId?: string;
  }): Promise<SessionInfo & { webSessionId: string }> {
    if (!Array.isArray(params.dirs) || params.dirs.length === 0) {
      throw new PathOutsideAllowlistError('(empty)');
    }
    // Validate every dir BEFORE we mint or spawn anything; first failure
    // surfaces the offending raw path. Resolved real paths replace the raw
    // values for downstream use (so dedup/allowlist are consistent).
    const realDirs: string[] = [];
    for (const d of params.dirs) {
      const real = await this.validatePath(d);
      realDirs.push(real);
    }
    // Exact-match dedup on the resolved paths. Order is preserved so
    // dirs[0] stays the primary cwd.
    const seen = new Set<string>();
    const dirs: string[] = [];
    for (const r of realDirs) {
      if (seen.has(r)) continue;
      seen.add(r);
      dirs.push(r);
    }
    const primary = dirs[0]!;
    const additionalDirs = dirs.slice(1);
    const account = this.resolveAccount(params.agent, params.account);
    const sessionId = this.mintWebSessionId();
    const proc = this.driverFactory({
      agent: params.agent,
      projectPath: primary,
      ...(account ? { account } : {}),
      ...(additionalDirs.length > 0 ? { additionalDirs } : {}),
    });

    const internal: InternalSession = {
      sessionId,
      agent: params.agent,
      projectPath: primary,
      createdAt: Date.now(),
      proc,
      buffer: [],
      nextSeq: 1,
      alive: true,
      ...(account ? { account: account.name } : {}),
    };
    this.registerInternalSession(internal);

    if (this.registry) {
      await this.registry.add({
        webSessionId: sessionId,
        agent: params.agent,
        projectPath: primary,
        transcriptPath: this.transcriptPathFor(sessionId),
        claudeSessionId: null,
        codexSessionId: null,
        createdAt: internal.createdAt,
        account: account ? account.name : null,
        name: null,
        additionalDirs,
      });
    }

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

    return {
      sessionId,
      webSessionId: sessionId,
      agent: internal.agent,
      projectPath: internal.projectPath,
      createdAt: internal.createdAt,
      ...(account ? { account: account.name } : {}),
    };
  }

  /**
   * Phase 6 — input lifecycle hook. Called from `sendInput` (and tests) to:
   *   (a) start the notifier turn timer,
   *   (b) auto-name the session on the first input if the registry entry
   *       still has `name === null`. Truncated to 60 chars; trimmed; the
   *       fallback `'(empty)'` is used when the slice is whitespace-only.
   * Either step is a no-op if its precondition isn't met. The method returns
   * a Promise so callers can await the registry write in tests; production
   * call sites fire-and-forget.
   */
  async handleInput(webSessionId: string, text: string): Promise<void> {
    this.notifier?.noteInput(webSessionId);
    if (!this.registry) return;
    const entry = this.registry.get(webSessionId);
    if (!entry || entry.name !== null) return;
    const sliced = text.slice(0, 60);
    const trimmed = sliced.trim();
    const name = trimmed.length === 0 ? '(empty)' : trimmed;
    try {
      await this.registry.update(webSessionId, { name });
    } catch (err) {
      console.warn('[session-registry] auto-name update failed:', err);
      return;
    }
    // Broadcast a session_renamed lifecycle event so the web UI can update
    // its session list / page title in lock-step with the registry write.
    // Reuses the same wire-shape as user-driven renameSession.
    this.broadcastSessionRenamed(webSessionId, name);
  }

  /**
   * Phase 6 — result lifecycle hook. Looks up the registry entry and hands
   * it to the notifier (which decides whether to send Telegram based on
   * elapsed turn duration). No-op if the registry isn't configured.
   */
  async handleResult(webSessionId: string): Promise<void> {
    if (!this.notifier) return;
    if (!this.registry) return;
    const entry = this.registry.get(webSessionId);
    if (!entry) return;
    await this.notifier.noteResult(entry);
  }

  /**
   * Phase 6 — user-initiated rename. Validates name (trim → reject empty →
   * ≤200 chars → reject control chars), persists registry, broadcasts a
   * `session_renamed` lifecycle event so all connected clients re-render.
   * Throws `session_name_invalid` on validation failure;
   * `history_session_not_found` if the registry has no such entry.
   */
  async renameSession(webSessionId: string, name: string): Promise<void> {
    if (typeof name !== 'string') {
      throw new InvalidSessionNameError('Invalid session name');
    }
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      throw new InvalidSessionNameError('Invalid session name');
    }
    // eslint-disable-next-line no-control-regex
    if (/[ -]/.test(trimmed)) {
      throw new InvalidSessionNameError('Invalid session name');
    }
    if (!this.registry) {
      throw resumeError('history_session_not_found', 'Rename requires a SessionRegistry');
    }
    const entry = this.registry.get(webSessionId);
    if (!entry) {
      throw resumeError('history_session_not_found', `Unknown webSessionId ${webSessionId}`);
    }
    await this.registry.update(webSessionId, { name: trimmed });
    this.broadcastSessionRenamed(webSessionId, trimmed);
  }

  /**
   * Emit a session_renamed lifecycle event. Used by both auto-name (on first
   * input) and user-driven rename. The event sits outside the seq machinery
   * because it's idempotent metadata (the registry is the source of truth);
   * we use an empty correlationId on the wire shape and emit through the
   * same `broadcast` event as everything else so connected websockets pick
   * it up via the existing fan-out.
   */
  private broadcastSessionRenamed(webSessionId: string, name: string): void {
    const msg: ServerSessionRenamedMsg = {
      type: 'session_renamed',
      sessionId: webSessionId,
      name,
      correlationId: '',
    };
    this.emit('broadcast', msg);
  }

  /**
   * Resume a previously-known dead session by webSessionId (Path 1).
   * Looks up the registry entry, validates path + cliSessionId presence,
   * then either spawns Claude with --resume or instantiates a Codex driver
   * seeded with the codexSessionId (no spawn — Codex spawns per-turn).
   *
   * Concurrent calls for the same webSessionId share a single in-flight
   * promise so a double-click on a list entry doesn't double-spawn.
   */
  async resume(webSessionId: string): Promise<void> {
    const existing = this.resumeInFlight.get(webSessionId);
    if (existing) return existing;
    const promise = this.doResume(webSessionId).finally(() => {
      this.resumeInFlight.delete(webSessionId);
    });
    this.resumeInFlight.set(webSessionId, promise);
    return promise;
  }

  private async doResume(webSessionId: string): Promise<void> {
    if (!this.registry) {
      throw resumeError('history_session_not_found', 'Resume requires a SessionRegistry');
    }
    const entry = this.registry.get(webSessionId);
    if (!entry) {
      throw resumeError('history_session_not_found', `Unknown webSessionId ${webSessionId}`);
    }
    const cliId = entry.agent === 'claude' ? entry.claudeSessionId : entry.codexSessionId;
    if (cliId === null) {
      throw resumeError(
        'cli_session_id_unknown',
        'Bridge never captured the CLI session id for this entry',
      );
    }
    // Path existence check.
    try {
      const stat = await this.stat(entry.projectPath);
      if (!stat.isDirectory()) {
        throw new Error('not a directory');
      }
    } catch {
      throw resumeError(
        'project_path_missing',
        `Project path no longer exists: ${entry.projectPath}`,
      );
    }
    // Allowlist re-check (allowlist may have tightened since entry was created).
    let real: string;
    try {
      real = await this.realpath(entry.projectPath);
    } catch {
      throw resumeError(
        'project_path_disallowed',
        `Project path is not in BRIDGE_ALLOWED_DIRS: ${entry.projectPath}`,
      );
    }
    if (!this.isAllowedDir(real)) {
      throw resumeError(
        'project_path_disallowed',
        `Project path is not in BRIDGE_ALLOWED_DIRS: ${entry.projectPath}`,
      );
    }
    // Per-agent dispatch.
    if (entry.agent === 'claude') {
      await this.spawnClaudeWithResume(entry, cliId);
    } else {
      this.instantiateCodexWithResumeSeed(entry, cliId);
    }
  }

  private async defaultAdditionalDirsFor(primaryRealPath: string): Promise<string[]> {
    const seen = new Set<string>([primaryRealPath]);
    const out: string[] = [];
    for (const raw of DEFAULT_WORKSPACE_DIRS) {
      let real: string;
      try {
        real = await this.realpath(raw);
      } catch {
        continue;
      }
      if (seen.has(real) || !this.isAllowedDir(real)) continue;
      seen.add(real);
      out.push(real);
    }
    return out;
  }

  /**
   * Native-history first-resume entry point (Path 2). Called by the WS handler
   * with a HistoryEntry that the scanner already verified. Issues a brand-new
   * webSessionId, persists registry, then runs the same per-agent
   * spawn/instantiate logic as Path 1.
   */
  async resumeFromHistoryEntry(
    entry: {
      agent: AgentKind;
      sessionId: string;
      projectPath: string;
      /**
       * On-disk path to the CLI's own session JSONL. When provided, prior
       * turns are parsed and replayed into the bridge's transcript so the
       * web UI shows context immediately on resume.
       */
      replayFilePath?: string;
    },
    accountName: string | null,
  ): Promise<string> {
    if (!this.registry) {
      throw resumeError('history_session_not_found', 'Resume requires a SessionRegistry');
    }
    // Re-validate cwd (scanner may be stale; allowlist may have tightened).
    let real: string;
    try {
      real = await this.realpath(entry.projectPath);
    } catch {
      throw resumeError(
        'project_path_missing',
        `Project path no longer exists: ${entry.projectPath}`,
      );
    }
    if (!this.isAllowedDir(real)) {
      throw resumeError(
        'project_path_disallowed',
        `Project path is not in BRIDGE_ALLOWED_DIRS: ${entry.projectPath}`,
      );
    }
    const additionalDirs = await this.defaultAdditionalDirsFor(real);
    const webSessionId = this.mintWebSessionId();
    await this.registry.add({
      webSessionId,
      agent: entry.agent,
      projectPath: real,
      transcriptPath: this.transcriptPathFor(webSessionId),
      claudeSessionId: entry.agent === 'claude' ? entry.sessionId : null,
      codexSessionId: entry.agent === 'codex' ? entry.sessionId : null,
      createdAt: Date.now(),
      account: accountName,
      name: null,
      additionalDirs,
    });
    // Pre-load replay events so attachSession can drain them synchronously
    // BETWEEN the synthesized session_created and driver listener wiring.
    // Errors during parse are non-fatal — resume should succeed even if the
    // CLI file is malformed; the user just gets no history backfill.
    if (entry.replayFilePath) {
      try {
        const events = await loadReplayEvents(entry.agent, entry.replayFilePath);
        if (events.length > 0) {
          this.pendingReplays.set(webSessionId, events);
        }
      } catch (err) {
        console.warn('[native-history-replay] parse failed', err);
      }
    }
    try {
      await this.resume(webSessionId);
    } finally {
      // Drop any unconsumed replay payload so a subsequent retry doesn't
      // double-replay (attachSession deletes on success).
      this.pendingReplays.delete(webSessionId);
    }
    return webSessionId;
  }

  private mintWebSessionId(): string {
    return randomUUID();
  }

  private transcriptPathFor(webSessionId: string): string {
    return join(this.transcriptDir, `${webSessionId}.jsonl`);
  }

  private async spawnClaudeWithResume(entry: RegistryEntry, claudeSessionId: string): Promise<void> {
    let driver: AgentDriver;
    try {
      // Claude is not codex; resolveAccount returns undefined for claude.
      // Spread account only if defined to satisfy exactOptionalPropertyTypes.
      const account = entry.account ? this.resolveAccount('claude', entry.account) : undefined;
      const additionalDirs = entry.additionalDirs ?? [];
      driver = this.driverFactory({
        agent: 'claude',
        projectPath: entry.projectPath,
        ...(account ? { account } : {}),
        ...(additionalDirs.length > 0 ? { additionalDirs } : {}),
        resumeArgs: ['--resume', claudeSessionId],
      });
    } catch (err) {
      throw resumeError(
        'resume_spawn_failed',
        `Spawn failed: ${(err as Error).message}`,
      );
    }
    // CRITICAL: register + wire listeners IMMEDIATELY so any stdout that
    // arrives during the settle window is captured into s.buffer (Phase 1
    // ring buffer + transcript) instead of being dropped on a listener-less
    // EventEmitter. Without this, a fast-responding resumed Claude can lose
    // its first assistant chunks during the ~1500ms settle race below.
    this.attachSession(entry.webSessionId, driver, entry);
    // Now race the early-exit detection. If Claude rejects the resume in the
    // first ~claudeResumeSettleMs, tear down the InternalSession we just
    // registered and throw the typed error. If the child exits inside the
    // settle window AND stderr matches a known rejection phrasing, throw
    // `claude_resume_rejected`. If it exits but stderr is something else
    // (segfault, perm error), throw `resume_spawn_failed`. Otherwise the
    // driver settles as alive and we leave the attached session in place.
    const earlyExit = await this.waitForEarlyExitOrSettle(driver);
    if (earlyExit !== null) {
      // Tear down what we registered; the driver already exited so it can't
      // emit further events, but make sure the manager's session map and
      // alive flag reflect that. We don't roll back the registry entry —
      // the registry entry pre-existed the resume call (Path 1 looked it up;
      // Path 2 wrote it before calling resume()). It's still useful for a
      // future retry once the user fixes the underlying problem.
      const s = this.sessions.get(entry.webSessionId);
      if (s) {
        s.alive = false;
        this.sessions.delete(entry.webSessionId);
      }
      if (this.isClaudeResumeRejection(earlyExit.stderr)) {
        throw resumeError(
          'claude_resume_rejected',
          earlyExit.stderr || 'claude rejected resume',
        );
      }
      throw resumeError(
        'resume_spawn_failed',
        earlyExit.stderr || `claude exited with code ${earlyExit.code ?? '?'}`,
      );
    }
    // Settled into a normal running state — already attached, nothing more.
  }

  /**
   * Resolve(null) if the driver stays alive past `claudeResumeSettleMs`.
   * Resolve({code, stderr}) if the driver fires `exit` first. We attempt to
   * read stderr from a `stderrTail()` method if the concrete driver exposes
   * one (ClaudeProcess does); otherwise we fall back to the empty string.
   */
  private waitForEarlyExitOrSettle(
    driver: AgentDriver,
  ): Promise<null | { code: number | null; stderr: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const onExit = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const tail = (driver as unknown as { stderrTail?: () => string }).stderrTail;
        const stderr = typeof tail === 'function' ? tail.call(driver) : '';
        resolve({ code, stderr });
      };
      driver.once('exit', onExit);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        driver.off('exit', onExit);
        resolve(null);
      }, this.claudeResumeSettleMs);
      // Don't keep the test runner alive on this timer.
      (timer as { unref?: () => void }).unref?.();
    });
  }

  /**
   * Substring/regex match on the stderr tail to recognize Claude's
   * `--resume <missing-id>` rejection. Claude phrasings change across
   * versions; we tolerate any of the known shapes.
   */
  private isClaudeResumeRejection(stderr: string): boolean {
    const patterns = [
      /no conversation found/i,
      /session not found/i,
      /unknown session/i,
      /invalid session/i,
    ];
    return patterns.some((p) => p.test(stderr));
  }

  private instantiateCodexWithResumeSeed(entry: RegistryEntry, codexSessionId: string): void {
    // Codex is spawn-per-turn. We instantiate the driver with the seed but
    // don't spawn — the resume rejection (if any) surfaces via the existing
    // turn-error path on the user's first send_text after resume. The driver
    // emits `result.error = 'codex_resume_rejected'` (CodexProcess change)
    // and onProcEvent broadcasts a typed error.
    const account = entry.account
      ? this.resolveAccount('codex', entry.account) ?? undefined
      : this.resolveAccount('codex', undefined);
    const additionalDirs = entry.additionalDirs ?? [];
    const driver = this.driverFactory({
      agent: 'codex',
      projectPath: entry.projectPath,
      ...(account ? { account } : {}),
      ...(additionalDirs.length > 0 ? { additionalDirs } : {}),
      codexResumeSeed: codexSessionId,
    });
    this.attachSession(entry.webSessionId, driver, entry);
  }

  /**
   * Wire a freshly-created or freshly-resumed driver into the in-memory
   * session map, attach event handlers, then synthesize the lifecycle
   * `session_created` event so the web learns about the new webSessionId.
   * For the resume path this is the ONLY reliable signal for Codex (which
   * doesn't spawn until first send) and serves as a redundant-but-idempotent
   * marker for Claude.
   */
  private attachSession(
    webSessionId: string,
    driver: AgentDriver,
    entry: RegistryEntry,
  ): void {
    const internal: InternalSession = {
      sessionId: webSessionId,
      agent: entry.agent,
      projectPath: entry.projectPath,
      createdAt: entry.createdAt,
      proc: driver,
      buffer: [],
      nextSeq: 1,
      alive: true,
      ...(entry.account ? { account: entry.account } : {}),
    };
    // Insert into the session map FIRST so appendAndBroadcast (and any
    // observers reacting to broadcast events) can find it.
    this.sessions.set(internal.sessionId, internal);
    // Synthesized session_created MUST fire BEFORE driver listeners are
    // wired so it takes seq=1; the first real driver event will then
    // naturally take seq=2. If we wired listeners first and the driver
    // flushed stdout synchronously, the real event would steal seq=1 and
    // arrive on the wire before session_created — wrong order.
    this.emitSynthesizedSessionCreated(internal);
    // Drain any pending replay events (resume-from-history backfill) so
    // they occupy seq=2..N+1 immediately after session_created and BEFORE
    // any live driver event takes a seq. Replay events are pre-loaded by
    // resumeFromHistoryEntry so this drain stays synchronous.
    this.drainPendingReplay(internal);
    // NOW wire the driver event/exit/cli_session_id listeners. Any
    // subsequent events from the driver flow through onProcEvent +
    // onCliSessionId, with seq starting at N+2.
    this.wireDriverListeners(internal);
    this.emit('session_resumed', { webSessionId, alive: true });
  }

  private drainPendingReplay(s: InternalSession): void {
    const events = this.pendingReplays.get(s.sessionId);
    if (!events || events.length === 0) return;
    this.pendingReplays.delete(s.sessionId);
    for (const e of events) {
      this.appendAndBroadcast(s, {
        ...e,
        sessionId: s.sessionId,
        seq: s.nextSeq++,
      } as ServerStreamMsg);
    }
  }

  private emitSynthesizedSessionCreated(s: InternalSession): void {
    this.appendAndBroadcast(s, {
      type: 'system',
      event: 'session_created',
      sessionId: s.sessionId,
      seq: s.nextSeq++,
      agent: s.agent,
      projectPath: s.projectPath,
      createdAt: s.createdAt,
      ...(s.account ? { account: s.account } : {}),
    });
  }

  /**
   * Fresh-spawn registration helper used by `create()`. Inserts the
   * InternalSession into the map and wires the driver event handlers in a
   * single step. The resume/`attachSession` path does NOT use this helper —
   * it inserts into the map, emits the synthesized session_created (seq=1),
   * THEN wires listeners separately via `wireDriverListeners`, so any
   * synchronous-stdout-flush from the driver doesn't steal seq=1.
   */
  private registerInternalSession(internal: InternalSession): void {
    this.sessions.set(internal.sessionId, internal);
    this.wireDriverListeners(internal);
  }

  /**
   * Attach the event/exit/cli_session_id listeners to the driver. Split out
   * of `registerInternalSession` so `attachSession` (resume path) can defer
   * listener wiring until AFTER it has emitted the synthesized
   * session_created — preventing a synchronous driver stdout flush from
   * stealing seq=1 from session_created.
   */
  private wireDriverListeners(internal: InternalSession): void {
    internal.proc.on('event', (e: AgentEvent) => this.onProcEvent(internal, e));
    internal.proc.on('exit', (code: number | null, reason?: string) =>
      this.onProcExit(internal, code, reason),
    );
    internal.proc.on('cli_session_id', (id: string) => {
      void this.onCliSessionId(internal, id);
    });
  }

  private async onCliSessionId(s: InternalSession, id: string): Promise<void> {
    if (!this.registry) return;
    const patch = s.agent === 'claude'
      ? { claudeSessionId: id }
      : { codexSessionId: id };
    try {
      await this.registry.update(s.sessionId, patch);
    } catch (err) {
      console.warn('[session-registry] update failed:', err);
    }
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
    // Phase 6: notifier — result lifecycle hook. Fired for any result
    // (success or error). Notifier internally checks duration ≥ threshold.
    if (e.kind === 'result') {
      void this.handleResult(s.sessionId);
    }
    // If a Codex turn surfaced a session_id_missing error inside the result,
    // also broadcast a typed ServerErrorMsg so the frontend can route it via
    // the standard error channel (App.tsx may show a distinct UI for it).
    if (e.kind === 'result' && (e as { error?: string }).error === 'codex_session_id_missing') {
      this.emit('broadcast', {
        type: 'error',
        code: 'codex_session_id_missing',
        message:
          'Codex did not emit a session_id; subsequent turns will start a fresh session (no resume).',
        sessionId: s.sessionId,
      });
    }
    if (e.kind === 'result' && (e as { error?: string }).error === 'codex_resume_rejected') {
      this.emit('broadcast', {
        type: 'error',
        code: 'codex_resume_rejected',
        message:
          'Codex rejected the resumed session id; the conversation may have been deleted or expired.',
        sessionId: s.sessionId,
      });
    }
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
    void this.imageStore?.cleanup(s.sessionId).catch((err) =>
      console.warn('[image-audit] cleanup', err),
    );
    // Phase 6: notifier — session_ended lifecycle hook so the notifier can
    // drop any per-session state (turn timers, failure counters).
    this.notifier?.noteSessionEnd(s.sessionId);
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

  /**
   * Test/inspection accessor — returns the live driver for a webSessionId
   * if any. Used by tests that need to assert on driver-internal state
   * (e.g. that codexResumeSeed populated codexSessionId).
   */
  getDriver(sessionId: string): AgentDriver | undefined {
    return this.sessions.get(sessionId)?.proc;
  }

  isAlive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.alive === true;
  }

  sendInput(
    sessionId: string,
    text: string,
    images?: ReadonlyArray<{ mime: string; base64: string }>,
  ): void {
    const s = this.sessions.get(sessionId);
    if (!s || !s.alive) throw new SessionDeadError(sessionId);
    this.appendAndBroadcast(s, {
      type: 'user',
      sessionId,
      seq: s.nextSeq++,
      payload: { text, ...(images && images.length > 0 ? { imageCount: images.length } : {}) },
    });
    this.promptStore?.add({ text, projectPath: s.projectPath, agent: s.agent });
    s.proc.sendUserText(text, images);
    // Fire-and-forget audit copy (Phase 3 §6 ordering). Errors are logged inside
    // ImageStore; never block delivery.
    if (this.imageStore && images && images.length > 0) {
      void this.imageStore
        .writeAuditCopy(sessionId, images.slice())
        .catch((err) => console.warn('[image-audit]', err));
    }
    // Phase 6: notifier — input lifecycle hook. Auto-name on first input is
    // also handled here (entry.name === null path). Both are best-effort.
    void this.handleInput(sessionId, text);
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

interface ResumeError extends Error {
  code: string;
}

function resumeError(code: string, message: string): ResumeError {
  return Object.assign(new Error(message), { code });
}
