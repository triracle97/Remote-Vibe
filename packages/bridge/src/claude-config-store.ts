import { existsSync, readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ClaudeConfigProfile } from './accounts.js';

/**
 * Editing the named `CLAUDE_CONFIG_DIR` profiles at runtime.
 *
 * The profiles themselves are loaded once at boot by `loadClaudeConfigProfiles`
 * from the `claude_config_dirs` key of `accounts.json`. Until now the only way
 * to add one was to hand-edit that file and restart, which is why the picker in
 * the New Session dialog stayed hidden — it only appears when more than one
 * profile exists, and nobody had a second one.
 *
 * This mutates the very Map the rest of the bridge holds, rather than replacing
 * it: `SessionManager` and the websocket layer both captured that reference at
 * construction, so a fresh Map would leave them reading a stale copy.
 */

/** The synthesized entry, whose directory comes from the environment. */
const DEFAULT_NAME = 'default';

/**
 * Matches the shell-safety gate the spawn path applies to `CLAUDE_CONFIG_DIR`.
 *
 * Validated here so a bad directory is rejected while the user is typing it,
 * with a message naming the problem — rather than at spawn time, as an opaque
 * "unsafe resume arg token" that surfaces only when a session fails to start.
 */
const SAFE_PATH_RE = /^[A-Za-z0-9_./-]+$/;

export class ClaudeConfigStoreError extends Error {
  constructor(
    public code: 'claude_config_invalid' | 'claude_config_not_found',
    message: string,
  ) {
    super(message);
  }
}

interface RawAccountsFile {
  claude_config_dirs?: Array<{ name: string; configDir: string }>;
  [key: string]: unknown;
}

export interface ClaudeConfigStoreOpts {
  dataDir: string;
  /** The live map, mutated in place. */
  profiles: Map<string, ClaudeConfigProfile>;
  /** For expanding a leading `~`. */
  home?: string | undefined;
}

export class ClaudeConfigStore {
  private readonly path: string;
  private readonly profiles: Map<string, ClaudeConfigProfile>;
  private readonly home: string | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  /**
   * True once `default` has been pointed somewhere explicitly.
   *
   * Until then it is written back out as absent, so a fresh boot keeps deriving
   * it from the environment rather than freezing today's value into the file.
   */
  private explicitDefault: boolean;

  constructor(opts: ClaudeConfigStoreOpts) {
    this.path = join(opts.dataDir, 'accounts.json');
    this.profiles = opts.profiles;
    this.home = opts.home;
    // An explicit entry already on disk stays explicit across restarts.
    this.explicitDefault = readsExplicitDefault(this.path);
  }

  list(): ClaudeConfigProfile[] {
    return [...this.profiles.values()];
  }

  /**
   * Add or update a named profile.
   *
   * `default` is writable on purpose: an explicit entry overrides the
   * environment-derived fallback, which is the only way to pin the profile
   * without also editing `.env`.
   */
  async save(nameRaw: string, configDirRaw: string): Promise<void> {
    const name = nameRaw.trim();
    if (name.length === 0 || name.length > 64) {
      throw new ClaudeConfigStoreError('claude_config_invalid', 'Name must be 1–64 characters');
    }
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new ClaudeConfigStoreError(
        'claude_config_invalid',
        'Name may contain letters, digits, dot, dash and underscore only',
      );
    }
    const configDir = this.expandHome(configDirRaw.trim());
    if (!isAbsolute(configDir)) {
      throw new ClaudeConfigStoreError(
        'claude_config_invalid',
        `Config dir must be an absolute path (got '${configDirRaw}')`,
      );
    }
    if (!SAFE_PATH_RE.test(configDir)) {
      throw new ClaudeConfigStoreError(
        'claude_config_invalid',
        'Config dir may not contain spaces or shell metacharacters',
      );
    }

    if (name === DEFAULT_NAME) this.explicitDefault = true;
    this.profiles.set(name, {
      name,
      configDir,
      // `isDefault` marks which entry the picker preselects, and stays with
      // whatever is named `default` regardless of who wrote it.
      isDefault: name === DEFAULT_NAME,
    });
    await this.persist();
  }

  async remove(nameRaw: string): Promise<void> {
    const name = nameRaw.trim();
    if (name === DEFAULT_NAME) {
      throw new ClaudeConfigStoreError(
        'claude_config_invalid',
        'The default profile cannot be removed; point it somewhere else instead',
      );
    }
    if (!this.profiles.has(name)) {
      throw new ClaudeConfigStoreError('claude_config_not_found', `Unknown profile '${name}'`);
    }
    this.profiles.delete(name);
    await this.persist();
  }

  private expandHome(p: string): string {
    if (p === '~' || p.startsWith('~/')) {
      if (!this.home) return p;
      return p === '~' ? this.home : join(this.home, p.slice(2));
    }
    return p;
  }

  /**
   * Rewrite only the `claude_config_dirs` key.
   *
   * `accounts.json` is shared with the Codex accounts, which this store knows
   * nothing about — read, replace one key, write back, so editing a Claude
   * profile from the UI cannot drop somebody's Codex configuration.
   */
  private persist(): Promise<void> {
    const snapshot = [...this.profiles.values()]
      // The synthesized default is only worth writing when it has been
      // explicitly pointed somewhere; otherwise it should keep following the
      // environment on the next boot.
      .filter((p) => p.name !== DEFAULT_NAME || this.explicitDefault)
      .map((p) => ({ name: p.name, configDir: p.configDir }));

    this.writeQueue = this.writeQueue.then(async () => {
      let raw: RawAccountsFile = {};
      if (existsSync(this.path)) {
        try {
          raw = JSON.parse(readFileSync(this.path, 'utf8')) as RawAccountsFile;
        } catch {
          // A malformed file is not a reason to lose the edit; the loader
          // already warns about it at boot.
          raw = {};
        }
      }
      raw.claude_config_dirs = snapshot;
      const tmp = `${this.path}.tmp.${process.pid}`;
      const fh = await fsp.open(tmp, 'w', 0o600);
      try {
        await fh.writeFile(`${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fsp.rename(tmp, this.path);
    });
    return this.writeQueue;
  }
}

/** Whether `accounts.json` already pins `default` explicitly. */
function readsExplicitDefault(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as RawAccountsFile;
    return (raw.claude_config_dirs ?? []).some((e) => e?.name === DEFAULT_NAME);
  } catch {
    return false;
  }
}
