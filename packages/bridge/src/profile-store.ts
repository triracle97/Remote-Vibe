import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import type { Profile } from './types.js';

interface ProfilesFile {
  profiles: Profile[];
}

const NAME_REGEX = /^[A-Za-z0-9 _-]{1,40}$/;

function profileError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export class ProfileStore {
  private state: ProfilesFile = { profiles: [] };
  private writeQueue: Promise<void> = Promise.resolve();
  private writeCounter = 0;
  private loaded = false;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const buf = await fsp.readFile(this.path, 'utf-8');
      const parsed = JSON.parse(buf) as ProfilesFile;
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.profiles)) {
        this.state = parsed;
      } else {
        this.state = { profiles: [] };
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') console.error('[profile-store] load failed, starting empty:', err);
      this.state = { profiles: [] };
    }
    this.loaded = true;
  }

  list(): Profile[] {
    return [...this.state.profiles];
  }

  get(name: string, agent: 'claude' | 'codex'): Profile | undefined {
    return this.state.profiles.find(
      (p) => p.agent === agent && p.name.toLowerCase() === name.toLowerCase(),
    );
  }

  async add(profile: Profile): Promise<void> {
    this.assertLoaded();
    if (!NAME_REGEX.test(profile.name)) {
      throw profileError('profile_invalid_name', `Invalid name: ${profile.name}`);
    }
    if (this.get(profile.name, profile.agent)) {
      throw profileError('profile_invalid_name', `Profile name already exists: ${profile.name}`);
    }
    if (!Array.isArray(profile.dirs) || profile.dirs.length === 0) {
      throw profileError('profile_dirs_disallowed', 'Profile must include at least one dir');
    }
    if (profile.default) {
      this.unsetDefaultsFor(profile.agent);
    }
    this.state.profiles.push(profile);
    await this.persist();
  }

  async update(
    name: string,
    agent: 'claude' | 'codex',
    patch: Partial<Profile>,
  ): Promise<void> {
    this.assertLoaded();
    const existing = this.get(name, agent);
    if (!existing) throw profileError('profile_not_found', `Profile not found: ${name}/${agent}`);
    const next = { ...existing, ...patch };
    if (patch.name && !NAME_REGEX.test(patch.name)) {
      throw profileError('profile_invalid_name', `Invalid name: ${patch.name}`);
    }
    if (next.dirs.length === 0) {
      throw profileError('profile_dirs_disallowed', 'Profile must include at least one dir');
    }
    if (patch.default === true) this.unsetDefaultsFor(agent);
    this.state.profiles = this.state.profiles.map((p) =>
      p.agent === agent && p.name.toLowerCase() === name.toLowerCase() ? next : p,
    );
    await this.persist();
  }

  async remove(name: string, agent: 'claude' | 'codex'): Promise<void> {
    this.assertLoaded();
    const existing = this.get(name, agent);
    if (!existing) throw profileError('profile_not_found', `Profile not found: ${name}/${agent}`);
    this.state.profiles = this.state.profiles.filter(
      (p) => !(p.agent === agent && p.name.toLowerCase() === name.toLowerCase()),
    );
    await this.persist();
  }

  async setDefault(name: string, agent: 'claude' | 'codex'): Promise<void> {
    this.assertLoaded();
    const existing = this.get(name, agent);
    if (!existing) throw profileError('profile_not_found', `Profile not found: ${name}/${agent}`);
    this.unsetDefaultsFor(agent);
    this.state.profiles = this.state.profiles.map((p) =>
      p.agent === agent && p.name.toLowerCase() === name.toLowerCase()
        ? { ...p, default: true }
        : p,
    );
    await this.persist();
  }

  private unsetDefaultsFor(agent: 'claude' | 'codex'): void {
    this.state.profiles = this.state.profiles.map((p) =>
      p.agent === agent && p.default ? { ...p, default: false } : p,
    );
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('ProfileStore: load() must be awaited before mutations');
  }

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
    this.writeQueue = queued.catch((err) => console.error('[profile-store] persist failed:', err));
    return queued;
  }
}
