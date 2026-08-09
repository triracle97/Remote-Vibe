import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import type { EffortLevel } from './models.js';
import type { WorkflowSize } from './claude-settings.js';
import type { SessionPhase, SessionLifecycleStatus, SessionUsage } from './types.js';
import { DEFAULT_SESSION_PHASE, EMPTY_SESSION_USAGE } from './types.js';

export interface RegistryEntry {
  webSessionId: string;
  agent: 'claude' | 'codex';
  projectPath: string;
  transcriptPath: string;
  /** CLI's own session uuid; populated when first observed. */
  claudeSessionId: string | null;
  codexSessionId: string | null;
  /** ms since epoch */
  createdAt: number;
  /** Codex profile name, if any. */
  account: string | null;

  // Phase 6 additions
  name: string | null;
  /**
   * True once a human renames the session. Automatic naming — both the
   * first-prompt fallback and the agent titler — leaves pinned names alone.
   */
  namePinned: boolean;
  additionalDirs: string[];

  // Phase 8 — board additions. The registry is now the source of truth for the
  // session list, so entries outlive the process that created them.
  /**
   * `live` only while a bridge is actually running the session. Nothing
   * survives a bridge restart, so `load()` demotes any persisted `live` to
   * `ended` — a stale `live` is always a lie.
   */
  status: SessionLifecycleStatus;
  phase: SessionPhase;
  /** True once a human drags the card; disables automatic phase inference. */
  phasePinned: boolean;
  tags: string[];
  /** ms since epoch; bumped on input and on each agent event. */
  lastActiveAt: number;
  endedAt: number | null;
  archived: boolean;
  /** Absolute CLAUDE_CONFIG_DIR this session was spawned with, if non-default. */
  claudeConfigDir: string | null;
  /** Whether this session launched through `headroom wrap claude`. */
  headroom: boolean;
  /** Running token/cost totals for this session. */
  usage: SessionUsage;
  /**
   * Resolved model and effort this session runs with, or null to mean "the
   * CLI's own default". Always the RESOLVED value, never the raw per-session
   * field — nimbalyst's #546 was exactly that: the picker showed the app
   * default while the session silently ran on the CLI's built-in one.
   */
  model: string | null;
  effort: EffortLevel | null;
  /**
   * Workflow settings this session was launched with, or null for "say
   * nothing and let the CLI decide". Persisted for the same reason as
   * model/effort: a resume has to reconstruct the settings file, and a card
   * showing `ultracode` must mean the session really got it.
   */
  workflowSize: WorkflowSize | null;
  workflowKeywordTrigger: boolean | null;
  /**
   * The session that spawned this one via the `spawn_session` MCP tool, or
   * null for anything a human started. Lets the board explain a card that
   * appeared without the user doing anything, and bounds spawn depth.
   */
  parentSessionId: string | null;
}

interface RegistryFile {
  sessions: Record<string, RegistryEntry>;
}

export class SessionRegistry {
  private state: RegistryFile = { sessions: {} };
  private writeQueue: Promise<void> = Promise.resolve();
  private writeCounter = 0;
  private loaded = false;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const buf = await fsp.readFile(this.path, 'utf-8');
      const parsed = JSON.parse(buf) as RegistryFile;
      if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
        this.state = parsed;
        // Migration: normalize each entry to ensure Phase 6 + Phase 8 fields
        // are present. Pre-Phase-8 entries have no lifecycle data at all, so
        // they land as ended/backlog — they are historical by definition.
        for (const [id, raw] of Object.entries(this.state.sessions)) {
          const entry = raw as Partial<RegistryEntry>;
          const createdAt = entry.createdAt ?? 0;
          // A persisted `live` cannot have survived the restart that brought
          // us here; demote it so the board never shows a phantom session.
          const status: SessionLifecycleStatus =
            entry.status === undefined || entry.status === 'live' ? 'ended' : entry.status;
          const lastActiveAt = entry.lastActiveAt ?? createdAt;
          this.state.sessions[id] = {
            webSessionId: entry.webSessionId ?? id,
            agent: entry.agent!,
            projectPath: entry.projectPath!,
            transcriptPath: entry.transcriptPath!,
            claudeSessionId: entry.claudeSessionId ?? null,
            codexSessionId: entry.codexSessionId ?? null,
            createdAt,
            account: entry.account ?? null,
            name: entry.name ?? null,
            // Pre-migration entries were named from the first prompt with no
            // way to distinguish a manual rename, so treat them as pinned:
            // silently re-titling a name the user may have chosen is worse
            // than leaving a mediocre one alone.
            namePinned: entry.namePinned ?? entry.name !== null,
            additionalDirs: entry.additionalDirs ?? [],
            status,
            phase: entry.phase ?? (entry.status === undefined ? 'backlog' : DEFAULT_SESSION_PHASE),
            phasePinned: entry.phasePinned ?? false,
            tags: entry.tags ?? [],
            lastActiveAt,
            endedAt: entry.endedAt ?? (status === 'ended' ? lastActiveAt : null),
            archived: entry.archived ?? false,
            claudeConfigDir: entry.claudeConfigDir ?? null,
            headroom: entry.headroom ?? false,
            usage: { ...EMPTY_SESSION_USAGE, ...(entry.usage ?? {}) },
            model: entry.model ?? null,
            effort: entry.effort ?? null,
            // Rows written before workflows were configurable said nothing
            // about them, which is exactly what null means here.
            workflowSize: entry.workflowSize ?? null,
            workflowKeywordTrigger: entry.workflowKeywordTrigger ?? null,
            // Rows written before agent-to-agent spawning existed have no
            // parent, which is also the truth: a human started them.
            parentSessionId: entry.parentSessionId ?? null,
          };
        }
      } else {
        this.state = { sessions: {} };
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.state = { sessions: {} };
      } else {
        // Corrupt or unreadable — log and start empty. Do NOT crash on boot.
        console.error('[session-registry] failed to load, starting empty:', err);
        this.state = { sessions: {} };
      }
    }
    this.loaded = true;
  }

  get(webSessionId: string): RegistryEntry | undefined {
    return this.state.sessions[webSessionId];
  }

  all(): RegistryEntry[] {
    return Object.values(this.state.sessions);
  }

  async add(entry: RegistryEntry): Promise<void> {
    this.assertLoaded();
    this.state.sessions[entry.webSessionId] = entry;
    await this.persist();
  }

  async update(webSessionId: string, patch: Partial<RegistryEntry>): Promise<void> {
    this.assertLoaded();
    const existing = this.state.sessions[webSessionId];
    if (!existing) return;
    this.state.sessions[webSessionId] = { ...existing, ...patch };
    await this.persist();
  }

  async remove(webSessionId: string): Promise<void> {
    this.assertLoaded();
    if (!(webSessionId in this.state.sessions)) return;
    delete this.state.sessions[webSessionId];
    await this.persist();
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('SessionRegistry: load() must be awaited before mutations');
  }

  /**
   * Serialize all writes through a promise chain. Each call awaits the
   * previous write before starting its own. Snapshots the latest in-memory
   * state at the moment of write so coalesced rapid updates are fine.
   */
  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    const counter = ++this.writeCounter;
    const tmpPath = `${this.path}.tmp.${process.pid}.${counter}`;
    const queued = this.writeQueue.then(async () => {
      await fsp.mkdir(dirname(this.path), { recursive: true });
      const fh = await fsp.open(tmpPath, 'w', 0o600);
      try {
        await fh.writeFile(snapshot, 'utf-8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fsp.rename(tmpPath, this.path);
    });
    // Don't let one failure poison the chain — swallow the error after
    // surfacing it; subsequent writes still proceed.
    this.writeQueue = queued.catch((err) => {
      console.error('[session-registry] persist failed:', err);
    });
    return queued;
  }
}
