import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';

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
