import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load a `.env` file from disk and populate `process.env` for any keys that
 * are NOT already set. Existing env (e.g. shell exports) ALWAYS wins so the
 * file is just a default-source for missing values.
 *
 * Lightweight parser:
 * - Lines starting with `#` (or fully blank after trimming) are comments.
 * - `KEY=VALUE` pairs; the first `=` is the separator (values can contain `=`).
 * - Optional surrounding double-quotes or single-quotes on the value are
 *   stripped (matching common .env conventions). Inside quoted values,
 *   `\n` is converted to a real newline; no other escape interpretation.
 * - `export KEY=...` prefix accepted (some users prefer this form).
 *
 * No new dependencies. The `dotenv` npm package would do roughly the same,
 * but we keep the dependency footprint minimal.
 *
 * Returns the number of keys applied (0 if file missing or only contained
 * already-set keys).
 */
export function loadEnvFile(path: string = resolve(process.cwd(), '.env')): number {
  if (!existsSync(path)) return 0;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    console.warn(`[env-file] read failed for ${path}:`, (err as Error).message);
    return 0;
  }

  let applied = 0;
  for (const lineRaw of raw.split('\n')) {
    const line = lineRaw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    // Strip optional `export ` prefix.
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;

    const eq = body.indexOf('=');
    if (eq < 1) continue; // missing `=` or empty key

    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // invalid env name

    if (process.env[key] !== undefined) continue; // existing env wins

    let value = body.slice(eq + 1).trim();
    // Strip surrounding quotes; preserve inner content
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
      // Inside double-quotes, interpret \n as a real newline (common .env behavior)
      if (lineRaw.trim().includes('"')) {
        value = value.replace(/\\n/g, '\n');
      }
    }

    process.env[key] = value;
    applied += 1;
  }

  return applied;
}
