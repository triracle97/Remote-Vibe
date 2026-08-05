import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * `npm run bridge:dev` runs the entrypoint with cwd set to `packages/bridge`,
 * not the repo root. Anything the bridge resolves against `process.cwd()`
 * therefore misses the root `.env` — the symptom is a hard boot failure,
 * "BRIDGE_TOKEN is required", from a repo that is configured correctly — and
 * would write a second `.bridge/` state directory inside the package.
 *
 * These tests boot the real entrypoint from that cwd and assert it finds its
 * configuration anyway.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..', '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const entry = join(pkgRoot, 'src', 'index.ts');

/** Throwaway state dir; every boot below writes here, never into the repo. */
let sandbox: string;
beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mrt-boot-'));
});
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Boot the bridge from `cwd` and resolve with everything it logged.
 *
 * Every piece of persistent state is redirected into a throwaway directory:
 * this boots the *real* entrypoint, which runs the real boot-time migrations,
 * and it must never touch the developer's own `.bridge/` registry or data dir.
 */
function boot(cwd: string, env: Record<string, string>): Promise<string> {
  return new Promise((res) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', entry],
      {
        cwd,
        env: {
          ...process.env,
          // Port 0 is rejected by the config validator, so use a high port and
          // kill the process as soon as it has told us what it resolved.
          BRIDGE_PORT: '18765',
          BRIDGE_BIND_HOST: '127.0.0.1',
          BRIDGE_HEADROOM_ENABLED: 'false',
          BRIDGE_TITLER_ENABLED: 'false',
          // Sandbox every write path away from the real repo state.
          BRIDGE_DATA_DIR: join(sandbox, 'data'),
          BRIDGE_SESSIONS_FILE: join(sandbox, 'sessions.json'),
          BRIDGE_JOBS_FILE: join(sandbox, 'jobs.json'),
          BRIDGE_PROFILES_FILE: join(sandbox, 'profiles.json'),
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    const done = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      res(out);
    };
    const onData = (b: Buffer): void => {
      out += b.toString();
      // Both the success and failure paths are decided by this point.
      if (out.includes('open: http') || out.includes('fatal:')) done();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => res(out));
    setTimeout(done, 25_000);
  });
}

describe('config paths resolve against the repo root, not cwd', () => {
  // Needs the repo's own .env to exist; skip on a checkout without one.
  const hasEnv = existsSync(join(repoRoot, '.env'));

  it.runIf(hasEnv)(
    'boots from the package directory, the way `npm run bridge:dev` does',
    async () => {
      const out = await boot(pkgRoot, {});
      expect(out).not.toContain('BRIDGE_TOKEN is required');
      expect(out).toContain('loaded');
      expect(out).toContain('open: http');
    },
    40_000,
  );

  it.runIf(hasEnv)(
    'boots from the repo root too',
    async () => {
      const out = await boot(repoRoot, {});
      expect(out).not.toContain('BRIDGE_TOKEN is required');
      expect(out).toContain('open: http');
    },
    40_000,
  );

  it(
    'still fails loudly when there is genuinely no token',
    async () => {
      // Point at an empty env file so the real .env cannot satisfy it.
      const out = await boot(pkgRoot, {
        BRIDGE_ENV_FILE: join(pkgRoot, 'src', '__tests__', 'does-not-exist.env'),
        BRIDGE_TOKEN: '',
      });
      expect(out).toContain('BRIDGE_TOKEN is required');
    },
    40_000,
  );
});
