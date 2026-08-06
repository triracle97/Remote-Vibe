import { EventEmitter } from 'node:events';
import { realpath as fsRealpath, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClaudeProcess } from './claude-process.js';
import type { TranscriptStore } from './transcript-store.js';
import type { CodexAccount, ClaudeConfigProfile } from './accounts.js';
import type { HeadroomSpawnConfig } from './headroom.js';
import type { SessionTitler } from './titler.js';
import type { PromptStore } from './prompt-store.js';
import type { ImageStore } from './image-store.js';
import type { Notifier } from './notifier.js';
import type { SessionRegistry, RegistryEntry } from './session-registry.js';
import { PathOutsideAllowlistError, makePathValidator } from './path-allowlist.js';
export { PathOutsideAllowlistError } from './path-allowlist.js';
import type {
  AgentEvent,
  AgentKind,
  BoardSession,
  ServerLifecycleMsg,
  ServerSessionArchivedMsg,
  ServerSessionDeletedMsg,
  ServerSessionPhaseChangedMsg,
  ServerSessionRenamedMsg,
  ServerSessionModelChangedMsg,
  ServerSessionTagsChangedMsg,
  ServerRateLimitsMsg,
  ServerSessionUsageMsg,
  ServerStreamMsg,
  SessionPhase,
  SessionUsage,
  RateLimitWindow,
  TurnUsage,
} from './types.js';
import { DEFAULT_SESSION_PHASE, EMPTY_SESSION_USAGE, isSessionPhase, phaseRank, turnContextTokens } from './types.js';
import { extractDirectives } from './agent-directives.js';
import {
  parseEffortLevel,
  parseModelId,
  resolveSetting,
  type EffortLevel,
} from './models.js';
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
  /**
   * @param images inline payloads, which Claude consumes directly on stdin.
   * @param imagePaths the same images already written to disk. Codex takes
   *   `-i <FILE>` rather than inline content, so it needs paths; the caller
   *   materialises them before this is invoked, which keeps `sendInput`
   *   synchronous and avoids two turns racing to spawn.
   */
  sendUserText(
    text: string,
    images?: ReadonlyArray<{ mime: string; base64: string }>,
    imagePaths?: readonly string[],
  ): void;
  kill(): void;
  /**
   * Stop the turn in flight without ending the session.
   *
   * Optional so a test double or a future driver need not implement it; a
   * driver without it simply cannot be interrupted, and `SessionManager`
   * reports that rather than falling back to killing the session.
   */
  interrupt?(): void;
  /**
   * Switch model/effort on a running session. Optional so test doubles and any
   * future driver need not implement it — a driver without it simply keeps the
   * stored value until its next spawn.
   */
  applyModelChange?(next: { model?: string; effort?: EffortLevel }): void;
}

export interface DriverFactoryArgs {
  agent: AgentKind;
  projectPath: string;
  account?: CodexAccount;
  /**
   * Absolute CLAUDE_CONFIG_DIR for this session (claude only). Resolved from
   * the session's named Claude profile, else the bridge default.
   */
  claudeConfigDir?: string;
  /**
   * Present when this session should launch through `headroom wrap claude`.
   * Absent when headroom is disabled or its proxy failed to come up — the
   * session still spawns, just unwrapped.
   */
  headroom?: HeadroomSpawnConfig;
  /** Phase 5 — Claude resume tokens (e.g. ['--resume', '<id>']). */
  resumeArgs?: string[];
  /** Phase 5 — Codex CLI session uuid to seed driver state. */
  codexResumeSeed?: string;
  /** Phase 6 — additional working dirs (Claude: --add-dir; Codex: ignored with warning). */
  additionalDirs?: string[];
  /** Absolute path to this session's `--mcp-config` file (Claude only). */
  mcpConfigPath?: string;
  /** Resolved model id (`--model`). Absent leaves the CLI default. */
  model?: string;
  /** Resolved reasoning effort (`--effort` / `model_reasoning_effort`). */
  effort?: EffortLevel;
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
  /** Named CLAUDE_CONFIG_DIR profiles. Always contains a `default` entry. */
  claudeConfigs?: Map<string, ClaudeConfigProfile>;
  /**
   * Writes a session's `--mcp-config` and returns its path, or null if it
   * could not. Absent when agent-to-agent spawning is not wired, in which case
   * sessions launch with no bridge MCP server at all.
   */
  writeMcpConfig?: (webSessionId: string) => Promise<string | null>;
  /** Bridge-wide model/effort defaults; a session may override either. */
  defaultModel?: string | null;
  defaultEffort?: EffortLevel | null;
  /**
   * Resolves headroom wrapping at spawn time, starting the shared proxy on
   * first use. Returns null when headroom is disabled or unavailable, in which
   * case the session spawns unwrapped rather than failing.
   */
  resolveHeadroom?: () => Promise<HeadroomSpawnConfig | null>;
  /** Names sessions from their first turn. Omit to keep prompt-derived names. */
  titler?: SessionTitler;
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

export class SessionNotFoundError extends Error {
  code = 'session_not_found' as const;
  constructor(public sessionId: string) {
    super(`[session_not_found] no registry entry for session ${sessionId}`);
  }
}

export class InvalidPhaseError extends Error {
  code = 'session_phase_invalid' as const;
  constructor(message: string) {
    super(message);
  }
}

export class InvalidModelError extends Error {
  code = 'session_model_invalid' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidModelError';
  }
}

export class InvalidTagsError extends Error {
  code = 'session_tags_invalid' as const;
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
  private readonly writeMcpConfig: ((webSessionId: string) => Promise<string | null>) | undefined;
  private readonly transcriptDir: string;
  private readonly stat: (p: string) => Promise<{ isDirectory(): boolean }>;
  private readonly claudeResumeSettleMs: number;
  private readonly notifier: Notifier | null;
  private readonly claudeConfigs: Map<string, ClaudeConfigProfile>;
  /** App-wide defaults from BRIDGE_DEFAULT_MODEL / BRIDGE_DEFAULT_EFFORT. */
  private readonly defaultModel: string | null;
  private readonly defaultEffort: EffortLevel | null;
  private readonly resolveHeadroomFn: () => Promise<HeadroomSpawnConfig | null>;
  private readonly titler: SessionTitler | undefined;
  /**
   * First prompt + reply per session, held only until the first turn ends and
   * the titler runs. Dropped immediately after, so this never grows.
   */
  private readonly titleContexts = new Map<
    string,
    { prompt: string; reply: string[]; requested: boolean }
  >();
  /**
   * Sessions whose titler has already run. Without this, every later turn
   * re-arms the capture and re-titles a session the user is still working in.
   */
  private readonly titledSessions = new Set<string>();
  /** Latest quota window per limit type. Process-lifetime only. */
  private readonly rateLimits = new Map<string, RateLimitWindow>();
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
    this.writeMcpConfig = opts.writeMcpConfig;
    this.transcriptDir = opts.transcriptDir ?? join('.bridge', 'transcripts');
    this.stat = opts.stat ?? ((p) => fsStat(p));
    this.claudeResumeSettleMs = opts.claudeResumeSettleMs ?? 1500;
    this.notifier = opts.notifier ?? null;
    this.claudeConfigs = opts.claudeConfigs ?? new Map();
    this.defaultModel = parseModelId(opts.defaultModel);
    this.defaultEffort = parseEffortLevel(opts.defaultEffort);
    this.resolveHeadroomFn = opts.resolveHeadroom ?? (() => Promise.resolve(null));
    this.titler = opts.titler;
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

  /**
   * Resolve and allowlist-check a directory. Public so the job store can
   * validate a job's target dir at creation time rather than letting the
   * failure surface later, when the user tries to start it.
   */
  async validatePath(projectPath: string): Promise<string> {
    return this.validatePathFn(projectPath);
  }

  private isAllowedDir(realPath: string): boolean {
    return this.allowedDirs.some((d) => realPath === d || realPath.startsWith(d + '/'));
  }

  /**
   * Phase 8 lifecycle/board fields for a freshly created registry entry.
   * Every `registry.add` call site funnels through here so a new field only
   * has to be defaulted once.
   */
  private newEntryLifecycle(opts: {
    createdAt: number;
    claudeConfigDir?: string | undefined;
    headroom?: boolean;
    model?: string | null;
    effort?: EffortLevel | null;
    parentSessionId?: string | null;
  }): Pick<
    RegistryEntry,
    | 'status'
    | 'phase'
    | 'phasePinned'
    | 'tags'
    | 'lastActiveAt'
    | 'endedAt'
    | 'archived'
    | 'claudeConfigDir'
    | 'headroom'
    | 'usage'
    | 'model'
    | 'effort'
    | 'parentSessionId'
  > {
    return {
      status: 'live',
      phase: DEFAULT_SESSION_PHASE,
      phasePinned: false,
      tags: [],
      // Persist the RESOLVED value, so what the card claims is what the CLI
      // was actually launched with (nimbalyst #546).
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      lastActiveAt: opts.createdAt,
      endedAt: null,
      archived: false,
      claudeConfigDir: opts.claudeConfigDir ?? null,
      headroom: opts.headroom ?? false,
      usage: { ...EMPTY_SESSION_USAGE },
      // Null unless an agent spawned this one through the MCP tool.
      parentSessionId: opts.parentSessionId ?? null,
    };
  }

  /**
   * Resolve a named Claude profile to an absolute CLAUDE_CONFIG_DIR.
   *
   * Unknown names throw so a typo surfaces instead of silently launching
   * against the wrong profile. Returns undefined for non-Claude agents, and
   * for the `default` profile when no explicit dir is configured (letting the
   * CLI use its own `~/.claude`).
   */
  private resolveClaudeConfigDir(
    agent: AgentKind,
    requested: string | undefined,
  ): string | undefined {
    if (agent !== 'claude') return undefined;
    const name = requested ?? 'default';
    const found = this.claudeConfigs.get(name);
    if (!found) {
      if (requested === undefined) return undefined;
      const names = [...this.claudeConfigs.keys()].join(', ');
      throw new UnknownAccountError(
        `Unknown Claude config profile '${requested}'. Configured: [${names}]`,
      );
    }
    // The unpinned default exports nothing: Claude Code keys its macOS keychain
    // item off CLAUDE_CONFIG_DIR, so handing it `~/.claude` explicitly reads a
    // different slot from a plain terminal `claude` and the session comes up
    // logged out. See ClaudeConfigProfile.inheritEnv.
    if (found.inheritEnv) return undefined;
    return found.configDir;
  }

  /**
   * The config dir to spawn a *recorded* session with.
   *
   * Sessions created before the default profile stopped exporting
   * CLAUDE_CONFIG_DIR persisted the default's own directory. Resuming those
   * with the variable set would send them back to the empty keychain slot, so
   * drop it when it names exactly where the inherited default points — the
   * directory the CLI resolves `--resume` against is unchanged either way.
   */
  private spawnConfigDir(recorded: string | null | undefined): string | undefined {
    if (!recorded) return undefined;
    const fallback = this.claudeConfigs.get('default');
    if (fallback?.inheritEnv && fallback.configDir === recorded) return undefined;
    return recorded;
  }

  /**
   * Headroom config for an agent spawn, starting the shared proxy if needed.
   *
   * Both drivers are wrapped: `headroom wrap claude` sets ANTHROPIC_BASE_URL,
   * `headroom wrap codex` sets OPENAI_BASE_URL, and the one shared proxy serves
   * both. Terminals are deliberately excluded — they are a raw shell, not an
   * agent, and there is no API traffic to route.
   *
   * Never throws — an unavailable proxy degrades to an unwrapped spawn.
   */
  private async resolveHeadroom(agent: AgentKind): Promise<HeadroomSpawnConfig | undefined> {
    if (agent !== 'claude' && agent !== 'codex') return undefined;
    try {
      return (await this.resolveHeadroomFn()) ?? undefined;
    } catch (err) {
      console.warn('[headroom] resolve failed, spawning unwrapped:', err);
      return undefined;
    }
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
        namePinned: false,
        additionalDirs: [],
        ...this.newEntryLifecycle({ createdAt: internal.createdAt }),
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
    /** Named Claude profile (see `loadClaudeConfigProfiles`). Claude only. */
    claudeConfig?: string;
    /** Per-session model/effort override; falls back to the bridge default. */
    model?: string;
    effort?: EffortLevel;
    correlationId?: string;
    /** Set when another agent spawned this session via the MCP tool. */
    parentSessionId?: string;
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
    // Resolve before minting: an unknown profile name should fail the spawn
    // outright rather than leave a half-created session behind.
    const claudeConfigDir = this.resolveClaudeConfigDir(params.agent, params.claudeConfig);
    const headroom = await this.resolveHeadroom(params.agent);
    // Resolve once, here, then both spawn and persist read the same value —
    // that is what stops the card claiming a model the CLI never got.
    const model = resolveSetting(parseModelId(params.model), this.defaultModel);
    const effort = resolveSetting(parseEffortLevel(params.effort), this.defaultEffort);
    const sessionId = this.mintWebSessionId();
    // Claude only: the Codex CLI's MCP registration is what `--no-mcp` on the
    // headroom wrapper deliberately suppresses, so a Codex session gets no
    // bridge tools and therefore cannot spawn. That is also the depth guard
    // working in our favour — spawned work is usually Codex.
    const mcpConfigPath =
      params.agent === 'claude' && this.writeMcpConfig
        ? ((await this.writeMcpConfig(sessionId)) ?? undefined)
        : undefined;
    const proc = this.driverFactory({
      agent: params.agent,
      projectPath: primary,
      ...(account ? { account } : {}),
      ...(additionalDirs.length > 0 ? { additionalDirs } : {}),
      ...(claudeConfigDir ? { claudeConfigDir } : {}),
      ...(headroom ? { headroom } : {}),
      ...(model !== null ? { model } : {}),
      ...(effort !== null ? { effort } : {}),
      ...(mcpConfigPath ? { mcpConfigPath } : {}),
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
        namePinned: false,
        additionalDirs,
        ...this.newEntryLifecycle({
          createdAt: internal.createdAt,
          claudeConfigDir,
          headroom: headroom !== undefined,
          model,
          effort,
          parentSessionId: params.parentSessionId ?? null,
        }),
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
    if (!entry) return;
    // Every input counts as activity, named or not — the board sorts on this.
    // Remember the opening ask so the titler can see it alongside the reply.
    // Once per session: a later turn must not re-title work in progress.
    if (
      !this.titleContexts.has(webSessionId) &&
      !this.titledSessions.has(webSessionId) &&
      !entry.namePinned
    ) {
      this.titleContexts.set(webSessionId, { prompt: text, reply: [], requested: false });
    }

    const patch: Partial<RegistryEntry> = { lastActiveAt: Date.now() };
    // Provisional name from the prompt so the card isn't anonymous while the
    // first turn runs; the titler replaces it when the turn ends.
    const name = entry.name === null ? deriveSessionName(text) : null;
    if (name !== null) patch.name = name;
    try {
      await this.registry.update(webSessionId, patch);
    } catch (err) {
      console.warn('[session-registry] auto-name update failed:', err);
      return;
    }
    // Broadcast a session_renamed lifecycle event so the web UI can update
    // its session list / page title in lock-step with the registry write.
    // Reuses the same wire-shape as user-driven renameSession.
    if (name !== null) this.broadcastSessionRenamed(webSessionId, name);
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
    if (/[\x00-]/.test(trimmed)) {
      throw new InvalidSessionNameError('Invalid session name');
    }
    if (!this.registry) {
      throw resumeError('history_session_not_found', 'Rename requires a SessionRegistry');
    }
    const entry = this.registry.get(webSessionId);
    if (!entry) {
      throw resumeError('history_session_not_found', `Unknown webSessionId ${webSessionId}`);
    }
    // Pin: a name the user typed is never overwritten by automatic naming.
    await this.registry.update(webSessionId, { name: trimmed, namePinned: true });
    this.titleContexts.delete(webSessionId);
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
      await this.instantiateCodexWithResumeSeed(entry, cliId);
    }
    // Only after the spawn succeeds — a failed resume must leave the entry
    // looking ended, not falsely alive.
    await this.markResumed(webSessionId);
  }

  /**
   * Undo `markEnded` for a session that has come back to life.
   *
   * Resume reuses the original registry row, and without this the row keeps the
   * `status: 'ended'` / `phase: 'done'` that ending wrote — so a session you are
   * actively talking to sits in the Done column. Phase inference cannot dig it
   * out either: it only ever moves a card *forward*
   * (`phaseRank(inferred) > phaseRank(current)`), and `done` is the highest
   * rank, so the card is stuck there for good short of a manual drag.
   *
   * Rewinds only from the terminal state. A session resumed mid-flight keeps
   * whatever phase it had reached, and a pinned card is left alone entirely —
   * pinning means the column is the user's to own.
   */
  private async markResumed(webSessionId: string): Promise<void> {
    if (!this.registry) return;
    const entry = this.registry.get(webSessionId);
    if (!entry) return;

    const patch: Partial<RegistryEntry> = {
      status: 'live',
      endedAt: null,
      lastActiveAt: Date.now(),
    };
    const rewind = !entry.phasePinned && entry.phase === 'done';
    if (rewind) patch.phase = DEFAULT_SESSION_PHASE;

    try {
      await this.registry.update(webSessionId, patch);
    } catch (err) {
      console.warn('[session-registry] resume update failed:', err);
      return;
    }
    if (rewind) this.broadcastPhase(webSessionId, DEFAULT_SESSION_PHASE, false);
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
      /** First user prompt from the CLI history; seeds the session name. */
      firstPrompt?: string;
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
    const createdAt = Date.now();
    await this.registry.add({
      webSessionId,
      agent: entry.agent,
      projectPath: real,
      transcriptPath: this.transcriptPathFor(webSessionId),
      claudeSessionId: entry.agent === 'claude' ? entry.sessionId : null,
      codexSessionId: entry.agent === 'codex' ? entry.sessionId : null,
      createdAt,
      account: accountName,
      // Seed the name from the CLI history's first prompt so a resumed session
      // is not an anonymous card on the board until its next turn.
      name: entry.firstPrompt ? deriveSessionName(entry.firstPrompt) : null,
      // Not pinned — a resumed session gets titled on its next turn.
      namePinned: false,
      additionalDirs,
      ...this.newEntryLifecycle({
        createdAt,
        claudeConfigDir: this.resolveClaudeConfigDir(entry.agent, undefined),
      }),
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

  /**
   * Where this session's transcript is actually written.
   *
   * Delegates to the store, which owns the location (`<dataDir>/transcripts`).
   * The `transcriptDir` fallback is for tests that construct a manager without
   * a store — using it in production recorded `.bridge/transcripts/…` in every
   * registry entry while the file was really under the data dir.
   */
  private transcriptPathFor(webSessionId: string): string {
    return this.transcriptStore
      ? this.transcriptStore.pathFor(webSessionId)
      : join(this.transcriptDir, `${webSessionId}.jsonl`);
  }

  private async spawnClaudeWithResume(entry: RegistryEntry, claudeSessionId: string): Promise<void> {
    let driver: AgentDriver;
    try {
      // Claude is not codex; resolveAccount returns undefined for claude.
      // Spread account only if defined to satisfy exactOptionalPropertyTypes.
      const account = entry.account ? this.resolveAccount('claude', entry.account) : undefined;
      const additionalDirs = entry.additionalDirs ?? [];
      // Everything the original spawn was given has to be reconstructed here,
      // not just the resume flag. `--resume <id>` is looked up inside the
      // CLI's *config dir*, so resuming without the entry's `claudeConfigDir`
      // searches the default `~/.claude` for an id that only exists in the
      // profile the session was created under — and the CLI rejects it every
      // time. Model, effort and headroom matter for the same reason the
      // original spawn records them: a resumed session that quietly drops them
      // is not the session the board claims it is.
      const headroom = await this.resolveHeadroom('claude');
      const claudeConfigDir = this.spawnConfigDir(entry.claudeConfigDir);
      const mcpConfigPath = this.writeMcpConfig
        ? ((await this.writeMcpConfig(entry.webSessionId)) ?? undefined)
        : undefined;
      driver = this.driverFactory({
        agent: 'claude',
        projectPath: entry.projectPath,
        ...(account ? { account } : {}),
        ...(additionalDirs.length > 0 ? { additionalDirs } : {}),
        ...(claudeConfigDir ? { claudeConfigDir } : {}),
        ...(headroom ? { headroom } : {}),
        ...(entry.model !== null ? { model: entry.model } : {}),
        ...(entry.effort !== null ? { effort: entry.effort } : {}),
        ...(mcpConfigPath ? { mcpConfigPath } : {}),
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

  private async instantiateCodexWithResumeSeed(
    entry: RegistryEntry,
    codexSessionId: string,
  ): Promise<void> {
    // Codex is spawn-per-turn. We instantiate the driver with the seed but
    // don't spawn — the resume rejection (if any) surfaces via the existing
    // turn-error path on the user's first send_text after resume. The driver
    // emits `result.error = 'codex_resume_rejected'` (CodexProcess change)
    // and onProcEvent broadcasts a typed error.
    const account = entry.account
      ? this.resolveAccount('codex', entry.account) ?? undefined
      : this.resolveAccount('codex', undefined);
    const additionalDirs = entry.additionalDirs ?? [];
    // Same reconstruction as the Claude path: a resumed session must launch
    // with the settings it was created with, or it silently becomes a
    // different session than the one on the board.
    const headroom = await this.resolveHeadroom('codex');
    const driver = this.driverFactory({
      agent: 'codex',
      projectPath: entry.projectPath,
      ...(account ? { account } : {}),
      ...(additionalDirs.length > 0 ? { additionalDirs } : {}),
      ...(headroom ? { headroom } : {}),
      ...(entry.model !== null ? { model: entry.model } : {}),
      ...(entry.effort !== null ? { effort: entry.effort } : {}),
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

    // Quota state, not conversation. Handled before a seq is minted so it
    // never lands in the transcript and never leaves a gap in the sequence
    // the client uses to detect dropped events.
    if (e.kind === 'rate_limit') {
      this.noteRateLimit(e.window);
      return;
    }

    // The agent can drive its own board card with inline directives. Act on
    // them and strip them here, so no client ever sees the marker and the
    // transcript on disk stays clean too.
    if (e.kind === 'assistant_text') {
      const directives = extractDirectives(e.text);
      if (directives.phase !== null || directives.tags !== null) {
        void this.applyAgentDirectives(s.sessionId, directives.phase, directives.tags);
        // A message that was *only* a directive has nothing left to show.
        if (directives.text.length === 0) return;
        e = { kind: 'assistant_text', text: directives.text };
      }
    }

    const seq = s.nextSeq++;
    let msg: ServerStreamMsg;
    switch (e.kind) {
      case 'assistant_text':
        msg = { type: 'assistant', sessionId: s.sessionId, seq, payload: { text: e.text } };
        break;
      case 'stream_delta':
        msg = { type: 'stream_delta', sessionId: s.sessionId, seq, payload: { delta: e.delta } };
        break;
      case 'thinking':
        // Rides the assistant channel with a discriminant so the transcript
        // can render it as its own collapsed block.
        msg = { type: 'assistant', sessionId: s.sessionId, seq, payload: { thinking: e.text } };
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
    // Phase 8: board bookkeeping. Every event is activity, and tool calls are
    // the signal we infer phase from.
    void this.notePhaseSignal(s.sessionId, e);
    this.noteTitleSignal(s, e);
    // Phase 6: notifier — result lifecycle hook. Fired for any result
    // (success or error). Notifier internally checks duration ≥ threshold.
    if (e.kind === 'result') {
      void this.handleResult(s.sessionId);
      void this.accumulateUsage(s.sessionId, e.usage, e.cost);
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

  /**
   * Accumulate the agent's first reply, then title the session once that first
   * turn ends. Fires exactly once per session — `requested` guards against a
   * turn that emits several `result` events.
   */
  private noteTitleSignal(s: InternalSession, e: AgentEvent): void {
    const ctx = this.titleContexts.get(s.sessionId);
    if (ctx === undefined) return;

    if (e.kind === 'assistant_text') {
      // Cap the accumulation — a long first reply is truncated for the prompt
      // anyway, so there is no reason to hold all of it.
      if (ctx.reply.join('').length < 2000) ctx.reply.push(e.text);
      return;
    }
    if (e.kind !== 'result' || ctx.requested) return;
    ctx.requested = true;
    this.titleContexts.delete(s.sessionId);
    this.titledSessions.add(s.sessionId);
    void this.applyAgentTitle(s, ctx.prompt, ctx.reply.join(''));
  }

  /** Best-effort: a failed or rejected title leaves the prompt-derived name. */
  private async applyAgentTitle(
    s: InternalSession,
    prompt: string,
    reply: string,
  ): Promise<void> {
    if (!this.titler?.enabled || !this.registry) return;
    let title: string | null;
    try {
      title = await this.titler.title({
        firstPrompt: prompt,
        firstReply: reply,
        projectPath: s.projectPath,
        // Same normalization as a resume: the titler is another `claude`
        // spawn, so a recorded ~/.claude would send it to the keychain slot
        // nobody logged into and every title would come back empty.
        claudeConfigDir: this.spawnConfigDir(this.registry.get(s.sessionId)?.claudeConfigDir),
      });
    } catch (err) {
      console.warn('[titler] unexpected failure:', err);
      return;
    }
    if (title === null) return;

    // Re-read: the user may have renamed the session while the titler ran, and
    // a manual name always wins.
    const entry = this.registry.get(s.sessionId);
    if (!entry || entry.namePinned) return;
    if (entry.name === title) return;

    try {
      await this.registry.update(s.sessionId, { name: title });
    } catch (err) {
      console.warn('[session-registry] title update failed:', err);
      return;
    }
    this.broadcastSessionRenamed(s.sessionId, title);
  }

  /**
   * Latest quota window per `limitType`, newest wins.
   *
   * Process-lifetime only: these describe *now*, and a stale figure from a
   * previous run would be worse than showing nothing until the next turn.
   */
  rateLimitWindows(): RateLimitWindow[] {
    return [...this.rateLimits.values()].sort((a, b) => a.limitType.localeCompare(b.limitType));
  }

  private noteRateLimit(window: RateLimitWindow): void {
    const prev = this.rateLimits.get(window.limitType);
    if (prev && prev.observedAt > window.observedAt) return;
    this.rateLimits.set(window.limitType, window);
    this.emit('broadcast', {
      type: 'rate_limits',
      windows: this.rateLimitWindows(),
    } satisfies ServerRateLimitsMsg);
  }

  /**
   * Add a completed turn's tokens to the session's running totals.
   *
   * Persisted on the registry entry so the number a card shows is the whole
   * session's spend, not just what this bridge process happened to observe.
   */
  private async accumulateUsage(
    webSessionId: string,
    usage: TurnUsage | undefined,
    cost: number | undefined,
  ): Promise<void> {
    if (!this.registry) return;
    const entry = this.registry.get(webSessionId);
    if (!entry) return;

    const prev = entry.usage ?? EMPTY_SESSION_USAGE;
    const next: SessionUsage = {
      inputTokens: prev.inputTokens + (usage?.inputTokens ?? 0),
      outputTokens: prev.outputTokens + (usage?.outputTokens ?? 0),
      cacheReadTokens: prev.cacheReadTokens + (usage?.cacheReadTokens ?? 0),
      cacheCreationTokens: prev.cacheCreationTokens + (usage?.cacheCreationTokens ?? 0),
      // The CLI reports cumulative cost per turn in USD; sum it.
      costUsd: prev.costUsd + (cost ?? 0),
      turns: prev.turns + 1,
      // Replaced, not summed — this is the current context level, and the
      // latest turn's input side *is* the answer. A turn that reports no usage
      // at all leaves the previous reading standing rather than claiming the
      // context suddenly emptied.
      contextTokens: usage ? turnContextTokens(usage) : prev.contextTokens,
    };

    try {
      await this.registry.update(webSessionId, { usage: next });
    } catch (err) {
      console.warn('[session-registry] usage update failed:', err);
      return;
    }
    this.emit('broadcast', {
      type: 'session_usage',
      sessionId: webSessionId,
      usage: next,
    } satisfies ServerSessionUsageMsg);
  }

  /**
   * Apply an agent-emitted phase/tag directive.
   *
   * Unlike inference, an explicit declaration may move the phase *backwards* —
   * the agent knows it went back to planning. A human drag still wins though:
   * `phasePinned` means the board column is the user's to own.
   */
  private async applyAgentDirectives(
    webSessionId: string,
    phase: SessionPhase | null,
    tags: string[] | null,
  ): Promise<void> {
    if (!this.registry) return;
    const entry = this.registry.get(webSessionId);
    if (!entry) return;

    const patch: Partial<RegistryEntry> = {};
    const nextPhase = phase !== null && !entry.phasePinned && phase !== entry.phase ? phase : null;
    if (nextPhase !== null) patch.phase = nextPhase;

    const nextTags =
      tags !== null && tags.join('\x00') !== entry.tags.join('\x00') ? tags : null;
    if (nextTags !== null) patch.tags = nextTags;

    if (Object.keys(patch).length === 0) return;
    try {
      await this.registry.update(webSessionId, patch);
    } catch (err) {
      console.warn('[session-registry] agent directive update failed:', err);
      return;
    }
    if (nextPhase !== null) this.broadcastPhase(webSessionId, nextPhase, false);
    if (nextTags !== null) {
      this.emit('broadcast', {
        type: 'session_tags_changed',
        sessionId: webSessionId,
        tags: nextTags,
      } satisfies ServerSessionTagsChangedMsg);
    }
  }

  /**
   * Bump activity and, when the event says so, advance the session's phase.
   *
   * Best-effort and fire-and-forget: a registry hiccup must never break the
   * event stream. Skips the phase half entirely once the user has pinned.
   */
  private async notePhaseSignal(webSessionId: string, e: AgentEvent): Promise<void> {
    if (!this.registry) return;
    const entry = this.registry.get(webSessionId);
    if (!entry) return;

    const patch: Partial<RegistryEntry> = { lastActiveAt: Date.now() };
    let nextPhase: SessionPhase | null = null;
    if (!entry.phasePinned) {
      const inferred = inferPhaseFromEvent(e, entry.phase);
      // Inference only moves forward. A session that has reached `verifying`
      // should not fall back to `implementing` because it edited one more file.
      if (inferred !== null && phaseRank(inferred) > phaseRank(entry.phase)) {
        nextPhase = inferred;
        patch.phase = inferred;
      }
    }

    try {
      await this.registry.update(webSessionId, patch);
    } catch (err) {
      console.warn('[session-registry] phase signal update failed:', err);
      return;
    }
    if (nextPhase !== null) this.broadcastPhase(webSessionId, nextPhase, false);
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
    // A session that died before its first turn ended will never be titled.
    this.titleContexts.delete(s.sessionId);
    this.titledSessions.delete(s.sessionId);
    // Phase 8: the registry outlives the process, so record the ending. A
    // finished session also advances to `done` unless the user pinned a phase.
    void this.markEnded(s.sessionId);
  }

  /** Persist end-of-life state. Best-effort; never blocks the exit path. */
  private async markEnded(webSessionId: string): Promise<void> {
    if (!this.registry) return;
    const entry = this.registry.get(webSessionId);
    if (!entry) return;
    const endedAt = Date.now();
    const patch: Partial<RegistryEntry> = {
      status: 'ended',
      endedAt,
      lastActiveAt: endedAt,
    };
    const advance = !entry.phasePinned && phaseRank('done') > phaseRank(entry.phase);
    if (advance) patch.phase = 'done';
    try {
      await this.registry.update(webSessionId, patch);
    } catch (err) {
      console.warn('[session-registry] end-of-life update failed:', err);
      return;
    }
    if (advance) this.broadcastPhase(webSessionId, 'done', false);
  }

  private appendAndBroadcast(s: InternalSession, msg: ServerLifecycleMsg | ServerStreamMsg): void {
    s.buffer.push(msg);
    if (s.buffer.length > this.bufferCap) {
      s.buffer.splice(0, s.buffer.length - this.bufferCap);
    }
    this.transcriptStore?.append(s.sessionId, msg);
    this.emit('broadcast', msg);
  }

  /**
   * Live sessions only. `name` is joined from the registry — without it the
   * web client drops the session name on every page reload, because
   * `session_renamed` is only broadcast on change.
   */
  listSessions(): Array<SessionInfo & { name?: string | null }> {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      agent: s.agent,
      projectPath: s.projectPath,
      createdAt: s.createdAt,
      ...(s.account ? { account: s.account } : {}),
      name: this.registry?.get(s.sessionId)?.name ?? null,
    }));
  }

  /**
   * Every session the bridge knows about — live *and* historical. This is the
   * board's data source, and the reason the registry exists: before this,
   * a bridge restart made every prior session invisible to the UI.
   */
  listBoardSessions(opts: { includeArchived?: boolean } = {}): BoardSession[] {
    if (!this.registry) return [];
    const out: BoardSession[] = [];
    for (const entry of this.registry.all()) {
      if (entry.archived && !opts.includeArchived) continue;
      const live = this.sessions.get(entry.webSessionId);
      const alive = live?.alive === true;
      out.push({
        sessionId: entry.webSessionId,
        agent: entry.agent,
        projectPath: entry.projectPath,
        additionalDirs: entry.additionalDirs,
        createdAt: entry.createdAt,
        lastActiveAt: entry.lastActiveAt,
        endedAt: entry.endedAt,
        name: entry.name,
        namePinned: entry.namePinned,
        // A registry entry can say `live` while this process has no driver for
        // it (e.g. crash between write and attach). Trust the in-memory map.
        status: alive ? 'live' : 'ended',
        alive,
        turnRunning: alive ? isTurnOpen(live!.buffer) : false,
        phase: entry.phase,
        phasePinned: entry.phasePinned,
        model: entry.model,
        effort: entry.effort,
        tags: entry.tags,
        archived: entry.archived,
        account: entry.account,
        claudeConfigDir: entry.claudeConfigDir,
        headroom: entry.headroom,
        usage: entry.usage ?? EMPTY_SESSION_USAGE,
        parentSessionId: entry.parentSessionId,
        // Resolved here rather than on the client: the parent may be archived
        // or filtered out of the card list the UI holds, and "spawned by
        // <uuid>" tells nobody anything.
        parentName: entry.parentSessionId
          ? (this.registry.get(entry.parentSessionId)?.name ?? null)
          : null,
        resumable:
          entry.agent === 'claude'
            ? entry.claudeSessionId !== null
            : entry.codexSessionId !== null,
      });
    }
    // Most recently active first — matches how the board reads.
    out.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return out;
  }

  private requireEntry(webSessionId: string): RegistryEntry {
    if (!this.registry) throw new SessionNotFoundError(webSessionId);
    const entry = this.registry.get(webSessionId);
    if (!entry) throw new SessionNotFoundError(webSessionId);
    return entry;
  }

  /**
   * Manual phase move. Always pins, so inference stops fighting the user for
   * that session — including moving a card backwards, which inference can't do.
   */
  async setSessionPhase(webSessionId: string, phase: SessionPhase): Promise<void> {
    if (!isSessionPhase(phase)) {
      throw new InvalidPhaseError(`Unknown session phase: ${String(phase)}`);
    }
    this.requireEntry(webSessionId);
    await this.registry!.update(webSessionId, { phase, phasePinned: true });
    this.broadcastPhase(webSessionId, phase, true);
  }

  /**
   * Change model and/or effort on an existing session.
   *
   * Claude applies it in place: the CLI honours `/model <alias>` and
   * `/effort <level>` sent as ordinary user messages on the stream-json stdin,
   * so the switch lands immediately with the transcript intact. Verified
   * against claude 2.x — a session spawned `--model haiku` reported
   * `claude-sonnet-5` on the turn after `/model sonnet`.
   *
   * Codex has no live process between turns, so recording the values is the
   * whole job; the next `codex exec` reads them. That is also how nimbalyst
   * does it on every provider (`SessionManager.updateSessionModel`).
   *
   * A dead session still accepts the change — it is stored and applies when
   * the session is resumed.
   */
  async setSessionModel(
    webSessionId: string,
    next: { model?: string | null; effort?: EffortLevel | null },
  ): Promise<void> {
    const entry = this.requireEntry(webSessionId);

    const patch: Partial<RegistryEntry> = {};
    if (next.model !== undefined) {
      const parsed = next.model === null ? null : parseModelId(next.model);
      if (next.model !== null && parsed === null) {
        throw new InvalidModelError(`Invalid model id: ${String(next.model)}`);
      }
      patch.model = parsed;
    }
    if (next.effort !== undefined) {
      const parsed = next.effort === null ? null : parseEffortLevel(next.effort);
      if (next.effort !== null && parsed === null) {
        throw new InvalidModelError(`Unknown effort level: ${String(next.effort)}`);
      }
      patch.effort = parsed;
    }
    if (Object.keys(patch).length === 0) return;

    await this.registry!.update(webSessionId, patch);

    // Push to the running driver. Only send what actually changed, and never
    // send null — there is no CLI command for "go back to the default".
    const live = this.sessions.get(webSessionId);
    if (live?.alive === true) {
      const applied: { model?: string; effort?: EffortLevel } = {};
      if (patch.model != null) applied.model = patch.model;
      if (patch.effort != null) applied.effort = patch.effort;
      if (Object.keys(applied).length > 0) {
        try {
          live.proc.applyModelChange?.(applied);
        } catch (err) {
          console.warn('[session] applying model change to live driver failed:', err);
        }
      }
    }

    const merged = this.registry!.get(webSessionId) ?? entry;
    this.emit('broadcast', {
      type: 'session_model_changed',
      sessionId: webSessionId,
      model: merged.model,
      effort: merged.effort,
    } satisfies ServerSessionModelChangedMsg);
  }

  async setSessionTags(webSessionId: string, tags: string[]): Promise<void> {
    if (!Array.isArray(tags)) throw new InvalidTagsError('tags must be an array');
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const raw of tags) {
      if (typeof raw !== 'string') throw new InvalidTagsError('tags must be strings');
      const tag = raw.trim().replace(/\s+/g, '-');
      if (tag.length === 0) continue;
      if (tag.length > 40) throw new InvalidTagsError(`tag too long: ${tag.slice(0, 20)}…`);
      if (/[\x00-\x1f]/.test(tag)) throw new InvalidTagsError('tags must not contain control characters');
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(tag);
    }
    if (cleaned.length > 20) throw new InvalidTagsError('at most 20 tags per session');
    this.requireEntry(webSessionId);
    await this.registry!.update(webSessionId, { tags: cleaned });
    this.emit('broadcast', {
      type: 'session_tags_changed',
      sessionId: webSessionId,
      tags: cleaned,
    } satisfies ServerSessionTagsChangedMsg);
  }

  async setSessionArchived(webSessionId: string, archived: boolean): Promise<void> {
    this.requireEntry(webSessionId);
    await this.registry!.update(webSessionId, { archived });
    this.emit('broadcast', {
      type: 'session_archived',
      sessionId: webSessionId,
      archived,
    } satisfies ServerSessionArchivedMsg);
  }

  /**
   * Drop a session from the registry and delete its transcript. Kills the
   * driver first if one is still attached, so deleting a running session is
   * not a way to leak a process.
   */
  async deleteSession(webSessionId: string): Promise<void> {
    this.requireEntry(webSessionId);
    const live = this.sessions.get(webSessionId);
    if (live) live.proc.kill();
    await this.transcriptStore?.delete(webSessionId).catch((err: unknown) =>
      console.warn('[transcript-store] delete failed:', err),
    );
    await this.registry!.remove(webSessionId);
    this.emit('broadcast', {
      type: 'session_deleted',
      sessionId: webSessionId,
    } satisfies ServerSessionDeletedMsg);
  }

  private broadcastPhase(webSessionId: string, phase: SessionPhase, pinned: boolean): void {
    this.emit('broadcast', {
      type: 'session_phase_changed',
      sessionId: webSessionId,
      phase,
      phasePinned: pinned,
    } satisfies ServerSessionPhaseChangedMsg);
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
    /**
     * Paths the caller has already written for `images`. Supplying them skips
     * the audit write below, because it has effectively already happened.
     */
    imagePaths?: readonly string[],
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
    s.proc.sendUserText(text, images, imagePaths);
    // Fire-and-forget audit copy (Phase 3 §6 ordering). Errors are logged inside
    // ImageStore; never block delivery. Skipped when the caller already wrote
    // the files — Codex needs them on disk before the turn spawns, so for that
    // agent the write has happened up front rather than after delivery.
    if (this.imageStore && images && images.length > 0 && imagePaths === undefined) {
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

  /**
   * Interrupt the current turn, leaving the session alive.
   *
   * Distinct from `stop`, which kills the process. Returns false when the
   * driver cannot be interrupted, so the caller can say so instead of silently
   * doing nothing — or worse, escalating to a kill the user did not ask for.
   */
  interrupt(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || !s.alive) throw new SessionDeadError(sessionId);
    if (!s.proc.interrupt) return false;
    s.proc.interrupt();
    return true;
  }

  shutdown(): void {
    for (const s of this.sessions.values()) s.proc.kill();
    this.transcriptStore?.closeAll();
  }
}

/**
 * Commands that mean "checking my work" rather than "doing the work". Matched
 * as whole words anywhere in a Bash tool call, so `npm run typecheck && npm test`
 * and `cd x && pytest -q` both count.
 */
const VERIFY_COMMAND_RE =
  /\b(test|tests|vitest|jest|pytest|typecheck|tsc|lint|eslint|build|playwright|cargo\s+test|go\s+test)\b/;

/**
 * Whether a turn is open on a session's buffer — a `user` message that no
 * `result` has closed yet.
 *
 * Deliberately the same walk as the web client's `isTurnRunning`: the board
 * hydrates from here and then tracks the same events live, and the two must
 * agree or a card would flip state on the first message after a page load.
 * A buffer trimmed past the opening `user` reads as closed, which errs towards
 * "waiting on you" rather than a spinner that never stops.
 */
export function isTurnOpen(
  buffer: ReadonlyArray<ServerLifecycleMsg | ServerStreamMsg>,
): boolean {
  for (let i = buffer.length - 1; i >= 0; i--) {
    const e = buffer[i]!;
    if (e.type === 'result') return false;
    if (e.type === 'system' && e.event === 'session_ended') return false;
    if (e.type === 'user') return true;
  }
  return false;
}

function bashCommandOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const cmd = (input as { command?: unknown }).command;
  return typeof cmd === 'string' ? cmd : null;
}

/** True when a TodoWrite payload has at least one todo and all are completed. */
function todosAllCompleted(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos) || todos.length === 0) return false;
  return todos.every(
    (t) => typeof t === 'object' && t !== null && (t as { status?: unknown }).status === 'completed',
  );
}

/**
 * Phase implied by a single agent event, or null when it says nothing.
 *
 * Deliberately conservative — a wrong guess is worse than no guess, because
 * the card is the user's mental model of the work. Callers apply the
 * forward-only rule.
 *
 * `current` is read for one purpose only: the same command means different
 * things before and after any code has been written. Running the test suite
 * having edited nothing is reproducing a bug, not verifying a fix.
 *
 * Exported for testing.
 */
export function inferPhaseFromEvent(e: AgentEvent, current: SessionPhase): SessionPhase | null {
  if (e.kind !== 'tool_use') return null;
  // Reaching `implementing` is the only way a session records that it has
  // edited something, so it doubles as "work has actually started".
  const started = phaseRank(current) >= phaseRank('implementing');
  switch (e.toolName) {
    // Leaving plan mode is the one unambiguous "planning is over" signal.
    case 'ExitPlanMode':
      return 'implementing';
    case 'TodoWrite':
      return todosAllCompleted(e.input) ? 'verifying' : null;
    case 'Bash': {
      const cmd = bashCommandOf(e.input);
      if (cmd === null || !VERIFY_COMMAND_RE.test(cmd)) return null;
      return started ? 'verifying' : 'investigating';
    }
    // Searching the codebase is what investigation looks like. Only ever
    // promotes a `backlog` card — the forward-only rule drops it otherwise.
    case 'Grep':
    case 'Glob':
      return 'investigating';
    // File mutation means work is underway, even without an explicit plan step.
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'implementing';
    default:
      return null;
  }
}

const AUTO_NAME_MAX_LEN = 60;

/**
 * Derive a session name from its first prompt.
 *
 * A raw 60-char slice makes for poor board cards: prompts routinely open with
 * a slash command and a pile of `@path` tags, so the visible part of the name
 * ends up being boilerplate. Strip those, collapse whitespace, then slice —
 * `/plan @src/foo.ts add retry` becomes `add retry`.
 *
 * Falls back to the unstripped text when stripping would leave nothing (a
 * bare `/compact` should still be named `/compact`, not `(empty)`).
 */
export function deriveSessionName(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '(empty)';
  const stripped = collapsed
    .replace(/^\/[A-Za-z0-9_:-]+\s*/, '')
    .replace(/(^|\s)@[^\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const base = stripped.length > 0 ? stripped : collapsed;
  return base.slice(0, AUTO_NAME_MAX_LEN).trim();
}

interface ResumeError extends Error {
  code: string;
}

function resumeError(code: string, message: string): ResumeError {
  return Object.assign(new Error(message), { code });
}
