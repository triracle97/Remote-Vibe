import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface CodexAccount {
  name: string;
  codexHome: string;
  isDefault: boolean;
}

interface RawAccountsFile {
  codex_accounts?: Array<{ name?: unknown; codexHome?: unknown }>;
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
