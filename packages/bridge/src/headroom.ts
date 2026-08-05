import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

/**
 * Headroom is a local optimization proxy for Anthropic API traffic. `headroom
 * wrap claude` sets ANTHROPIC_BASE_URL to point at it and then execs the real
 * `claude` binary with stdio inherited — so it is byte-transparent to our
 * stream-json protocol and safe to put in front of the agent.
 *
 * The wrapper can start its own proxy, but every concurrent session would race
 * to bind the same port. Instead the bridge owns exactly one proxy and each
 * session spawns `headroom wrap claude --no-proxy`, pointing at it.
 *
 * If a proxy is already listening (started by hand, or by a previous bridge)
 * we reuse it and never kill it — `stop()` only touches a child we started.
 */

const DEFAULT_PORT = 8787;
const PROBE_TIMEOUT_MS = 1500;
const POLL_INTERVAL_MS = 500;
const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const KILL_GRACE_MS = 5000;

export interface HeadroomOpts {
  enabled: boolean;
  /** Binary name or absolute path. Bare names resolve via PATH. */
  bin: string;
  port: number;
  /** Injectable for tests. */
  spawn?: typeof nodeSpawn;
  fetch?: typeof globalThis.fetch;
  startupTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The subset the Claude driver needs to build its command line. */
export interface HeadroomSpawnConfig {
  bin: string;
  port: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

export class HeadroomProxy {
  readonly enabled: boolean;
  readonly bin: string;
  readonly port: number;
  private readonly spawnFn: typeof nodeSpawn;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly startupTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Non-null only when *this* bridge started the proxy. */
  private child: ChildProcess | null = null;
  private ready = false;
  /** Shared in-flight promise so concurrent spawns don't start N proxies. */
  private ensuring: Promise<boolean> | null = null;
  /** Set once we have logged a startup failure, to avoid log spam per session. */
  private warned = false;

  constructor(opts: HeadroomOpts) {
    this.enabled = opts.enabled;
    this.bin = opts.bin;
    this.port = opts.port;
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Config for `ClaudeProcess`, or null when headroom is off/unavailable. */
  spawnConfig(): HeadroomSpawnConfig | null {
    if (!this.enabled || !this.ready) return null;
    return { bin: this.bin, port: this.port };
  }

  /**
   * Idempotent. Returns true when a proxy is listening on `port`.
   *
   * Never throws: a dead or unstartable proxy degrades to "spawn Claude
   * without headroom" rather than blocking session creation.
   */
  async ensure(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.ready) return true;
    if (this.ensuring) return this.ensuring;
    this.ensuring = this.doEnsure().finally(() => {
      this.ensuring = null;
    });
    return this.ensuring;
  }

  private async doEnsure(): Promise<boolean> {
    if (await this.probe()) {
      console.log(`[headroom] reusing proxy already listening on :${this.port}`);
      this.ready = true;
      return true;
    }
    if (!this.startProxy()) return false;
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      // Bail early if the child died — no point polling a corpse.
      if (this.child !== null && this.child.exitCode !== null) {
        console.warn(
          `[headroom] proxy exited with code ${this.child.exitCode} during startup; ` +
            'continuing without headroom',
        );
        this.child = null;
        return false;
      }
      await this.sleep(POLL_INTERVAL_MS);
      if (await this.probe()) {
        console.log(`[headroom] proxy ready on :${this.port}`);
        this.ready = true;
        return true;
      }
    }
    console.warn(
      `[headroom] proxy did not become healthy within ${this.startupTimeoutMs}ms; ` +
        'continuing without headroom',
    );
    return false;
  }

  /** True when something answers `/health` on the configured port. */
  private async probe(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`http://127.0.0.1:${this.port}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return res.status < 500;
    } catch {
      return false;
    }
  }

  /** Returns false if the binary is missing — caller degrades gracefully. */
  private startProxy(): boolean {
    console.log(`[headroom] starting proxy: ${this.bin} proxy --port ${this.port}`);
    let child: ChildProcess;
    try {
      child = this.spawnFn(this.bin, ['proxy', '--port', String(this.port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      this.warnStartFailure((err as Error).message);
      return false;
    }
    child.stdout?.on('data', (b: Buffer) => this.logProxyOutput(b));
    child.stderr?.on('data', (b: Buffer) => this.logProxyOutput(b));
    child.on('error', (err: NodeJS.ErrnoException) => {
      this.warnStartFailure(
        err.code === 'ENOENT'
          ? `'${this.bin}' not found on PATH. Set BRIDGE_HEADROOM_BIN to an absolute path, ` +
              'or BRIDGE_HEADROOM_ENABLED=false to disable.'
          : err.message,
      );
      this.child = null;
      this.ready = false;
    });
    child.on('exit', (code) => {
      // Only meaningful after startup; the startup loop checks exitCode itself.
      if (this.ready) {
        console.warn(`[headroom] proxy exited with code ${code ?? '?'}`);
        this.ready = false;
      }
      this.child = null;
    });
    this.child = child;
    return true;
  }

  private logProxyOutput(buf: Buffer): void {
    const text = buf.toString('utf8').trimEnd();
    if (text.length === 0) return;
    for (const line of text.split('\n')) console.log(`[headroom] ${line}`);
  }

  private warnStartFailure(message: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[headroom] could not start proxy: ${message}`);
  }

  /** Kills the proxy only if this bridge started it. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise<boolean>((res) => child.once('exit', () => res(true))),
      this.sleep(KILL_GRACE_MS).then(() => false),
    ]);
    if (!exited) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
  }
}

export function headroomConfigFromEnv(env: Record<string, string | undefined>): {
  enabled: boolean;
  bin: string;
  port: number;
} {
  const raw = env.BRIDGE_HEADROOM_ENABLED;
  // Default on: the whole point of this integration is that it is the norm.
  const enabled = raw === undefined ? true : /^(1|true|yes|on)$/i.test(raw.trim());
  const bin = env.BRIDGE_HEADROOM_BIN?.trim() || 'headroom';
  const portRaw = env.BRIDGE_HEADROOM_PORT;
  let port = DEFAULT_PORT;
  if (portRaw !== undefined) {
    const parsed = Number(portRaw);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error('BRIDGE_HEADROOM_PORT must be a positive integer');
    }
    port = parsed;
  }
  return { enabled, bin, port };
}
