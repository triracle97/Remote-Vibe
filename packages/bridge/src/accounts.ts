import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface CodexAccount {
  name: string;
  codexHome: string;
  isDefault: boolean;
}

/**
 * A named CLAUDE_CONFIG_DIR. Claude Code keeps settings, installed plugins,
 * hooks, slash commands and native session history under one directory, so
 * pointing at `~/.claude1` instead of `~/.claude` swaps the whole profile —
 * including whichever plugins that profile has enabled.
 *
 * Deliberately parallel to `CodexAccount` rather than merged with it: the two
 * are selected independently, and `RegistryEntry.account` already means
 * "Codex profile name".
 */
export interface ClaudeConfigProfile {
  name: string;
  /** Absolute path exported as CLAUDE_CONFIG_DIR. */
  configDir: string;
  isDefault: boolean;
  /**
   * True for the synthesized `default` that nobody pinned: spawns inherit the
   * bridge's own environment instead of exporting `configDir`.
   *
   * This is not cosmetic. Claude Code derives its macOS keychain item from
   * CLAUDE_CONFIG_DIR — `Claude Code-credentials-<sha256(dir)[0..8]>` when the
   * variable is set, plain `Claude Code-credentials` when it is not. Exporting
   * `~/.claude` explicitly therefore reads a *different* keychain slot from a
   * plain `claude` in a terminal, and a session started that way reports
   * itself logged out even though the machine is logged in. `configDir` is
   * still the right path for anything reading the profile's files (history,
   * slash commands); only the spawn environment leaves it unset.
   */
  inheritEnv: boolean;
}

interface RawAccountsFile {
  codex_accounts?: Array<{ name?: unknown; codexHome?: unknown }>;
  claude_config_dirs?: Array<{ name?: unknown; configDir?: unknown }>;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function synthesizeDefault(env: Record<string, string | undefined>): CodexAccount {
  const codexHome = env.CODEX_HOME ?? (env.HOME ? join(env.HOME, '.codex') : '/');
  return { name: 'default', codexHome, isDefault: true };
}

export function loadCodexAccounts(opts: {
  dataDir: string;
  env: Record<string, string | undefined>;
}): Map<string, CodexAccount> {
  const path = join(opts.dataDir, 'accounts.json');
  if (!existsSync(path)) {
    return new Map([['default', synthesizeDefault(opts.env)]]);
  }

  let raw: RawAccountsFile;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as RawAccountsFile;
  } catch (err) {
    console.warn(`[accounts] malformed ${path}: ${(err as Error).message}. Falling back to default.`);
    return new Map([['default', synthesizeDefault(opts.env)]]);
  }

  const list = Array.isArray(raw.codex_accounts) ? raw.codex_accounts : [];
  const out = new Map<string, CodexAccount>();
  for (const entry of list) {
    if (typeof entry?.name !== 'string' || typeof entry.codexHome !== 'string') {
      console.warn(`[accounts] skipping malformed entry in ${path}`);
      continue;
    }
    if (!isDirectory(entry.codexHome)) {
      console.warn(
        `[accounts] account '${entry.name}' codexHome '${entry.codexHome}' is not a directory; dropping.`,
      );
      continue;
    }
    out.set(entry.name, { name: entry.name, codexHome: entry.codexHome, isDefault: false });
  }

  if (out.size === 0) {
    return new Map([['default', synthesizeDefault(opts.env)]]);
  }

  return out;
}

/**
 * Named CLAUDE_CONFIG_DIR profiles, read from the `claude_config_dirs` key of
 * the same `accounts.json`.
 *
 * The `default` entry is always synthesized and always present, so the picker
 * has something to fall back to. `defaultConfigDir` (from
 * BRIDGE_CLAUDE_CONFIG_DIR) overrides what `default` points at; without it the
 * CLI's own default `~/.claude` is used — and, because nobody asked for a
 * specific directory in that case, it is marked `inheritEnv` so spawns export
 * no CLAUDE_CONFIG_DIR at all. Pinning it, either through the env var or an
 * explicit `default` entry in `accounts.json`, is a deliberate choice and does
 * get exported.
 *
 * Unlike `loadCodexAccounts`, a non-existent directory is kept rather than
 * dropped — Claude creates its config dir on first run, so a fresh `~/.claude1`
 * is a legitimate target.
 */
export function loadClaudeConfigProfiles(opts: {
  dataDir: string;
  env: Record<string, string | undefined>;
  defaultConfigDir?: string | undefined;
}): Map<string, ClaudeConfigProfile> {
  const fallbackDir =
    opts.defaultConfigDir ??
    opts.env.CLAUDE_CONFIG_DIR ??
    (opts.env.HOME ? join(opts.env.HOME, '.claude') : '/');
  const out = new Map<string, ClaudeConfigProfile>([
    [
      'default',
      {
        name: 'default',
        configDir: fallbackDir,
        isDefault: true,
        inheritEnv: opts.defaultConfigDir === undefined,
      },
    ],
  ]);

  const path = join(opts.dataDir, 'accounts.json');
  if (!existsSync(path)) return out;

  let raw: RawAccountsFile;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as RawAccountsFile;
  } catch {
    // loadCodexAccounts already warned about the same file.
    return out;
  }

  const list = Array.isArray(raw.claude_config_dirs) ? raw.claude_config_dirs : [];
  for (const entry of list) {
    if (typeof entry?.name !== 'string' || typeof entry.configDir !== 'string') {
      console.warn(`[accounts] skipping malformed claude_config_dirs entry in ${path}`);
      continue;
    }
    if (entry.name === 'default') {
      // An explicit `default` entry wins over the synthesized one — and, being
      // explicit, is exported rather than inherited.
      out.set('default', {
        name: 'default',
        configDir: entry.configDir,
        isDefault: true,
        inheritEnv: false,
      });
      continue;
    }
    out.set(entry.name, {
      name: entry.name,
      configDir: entry.configDir,
      isDefault: false,
      inheritEnv: false,
    });
  }

  return out;
}
