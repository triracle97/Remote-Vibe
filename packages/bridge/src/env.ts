export interface BridgeConfig {
  token: string;
  port: number;
  bindHost?: string;
  allowedDirs: string[];
}

const MIN_TOKEN_LEN = 24;

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

  const bindHost = env.BRIDGE_BIND_HOST;

  return { token, port, allowedDirs, ...(bindHost ? { bindHost } : {}) };
}
