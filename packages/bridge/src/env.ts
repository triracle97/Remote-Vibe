import { join } from 'node:path';

export interface BridgeConfig {
  token: string;
  port: number;
  bindHost?: string;
  allowedDirs: string[];
  dataDir: string;
  transcriptRetentionDays: number;
}

const MIN_TOKEN_LEN = 24;
const DEFAULT_DATA_SUBDIR = '.config/mac-remote-terminal';
const DEFAULT_RETENTION_DAYS = 30;

export function loadEnv(env: Record<string, string | undefined>): BridgeConfig {
  const token = env.BRIDGE_TOKEN;
  if (!token) {
    throw new Error(
      'BRIDGE_TOKEN is required. Generate one: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (token.length < MIN_TOKEN_LEN) {
    throw new Error(`BRIDGE_TOKEN must be at least ${MIN_TOKEN_LEN} characters`);
  }

  const port = Number(env.BRIDGE_PORT ?? '8765');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('BRIDGE_PORT must be a positive integer');
  }

  const allowedDirsRaw = env.BRIDGE_ALLOWED_DIRS ?? env.HOME;
  if (!allowedDirsRaw) {
    throw new Error('BRIDGE_ALLOWED_DIRS or HOME must be set');
  }
  const allowedDirs = allowedDirsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const home = env.HOME;
  const dataDir =
    env.BRIDGE_DATA_DIR ??
    (home ? join(home, DEFAULT_DATA_SUBDIR) : (() => {
      throw new Error('BRIDGE_DATA_DIR or HOME must be set');
    })());

  const retentionRaw = env.BRIDGE_TRANSCRIPT_RETENTION_DAYS;
  let transcriptRetentionDays = DEFAULT_RETENTION_DAYS;
  if (retentionRaw !== undefined) {
    const parsed = Number(retentionRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error('BRIDGE_TRANSCRIPT_RETENTION_DAYS must be a non-negative integer');
    }
    transcriptRetentionDays = parsed;
  }

  const bindHost = env.BRIDGE_BIND_HOST;

  return {
    token,
    port,
    allowedDirs,
    dataDir,
    transcriptRetentionDays,
    ...(bindHost ? { bindHost } : {}),
  };
}
