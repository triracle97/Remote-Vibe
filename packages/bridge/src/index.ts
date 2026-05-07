import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ClaudeProcess } from './claude-process.js';
import { loadEnv } from './env.js';
import { resolveTailscaleIPv4 } from './tailscale.js';
import { createHttpHandler } from './http-server.js';
import { attachWebSocket } from './websocket.js';
import { SessionManager } from './session.js';

async function main(): Promise<void> {
  const cfg = loadEnv(process.env);

  const bindHost = cfg.bindHost ?? (await resolveTailscaleIPv4());
  console.log(`[bridge] binding to ${bindHost}:${cfg.port}`);

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../apps/web/dist'),
    resolve(here, '../../apps/web/dist'),
  ];
  const staticDir = candidates.find((p) => existsSync(p));
  if (!staticDir) {
    throw new Error(`web bundle not found. Run \`npm run web:build\`. Looked in:\n  ${candidates.join('\n  ')}`);
  }
  console.log(`[bridge] serving static bundle from ${staticDir}`);

  const sessionManager = new SessionManager({
    allowedDirs: cfg.allowedDirs,
    bufferCap: 1000,
    spawnClaude: (path) => new ClaudeProcess(path),
  });

  const handler = createHttpHandler({ token: cfg.token, staticDir, dataDir: cfg.dataDir });
  const server = createServer(handler);
  attachWebSocket({ server, token: cfg.token, sessionManager });

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(cfg.port, bindHost, () => res());
  });

  console.log(`[bridge] open: http://${bindHost}:${cfg.port}/?token=<TOKEN>`);

  const shutdown = (): void => {
    console.log('[bridge] shutting down');
    sessionManager.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 6000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[bridge] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
