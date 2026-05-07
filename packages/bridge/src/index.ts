import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ClaudeProcess } from './claude-process.js';
import { CodexProcess } from './codex-process.js';
import { loadCodexAccounts } from './accounts.js';
import { loadEnv } from './env.js';
import { resolveTailscaleIPv4 } from './tailscale.js';
import { createHttpHandler } from './http-server.js';
import { attachWebSocket } from './websocket.js';
import { SessionManager, type AgentDriver, type DriverFactoryArgs } from './session.js';
import { TranscriptStore } from './transcript-store.js';
import { PromptStore } from './prompt-store.js';

async function main(): Promise<void> {
  const cfg = loadEnv(process.env);
  const accounts = loadCodexAccounts({ dataDir: cfg.dataDir, env: process.env });
  console.log(`[bridge] loaded ${accounts.size} codex account(s): ${[...accounts.keys()].join(', ')}`);

  const transcriptStore = new TranscriptStore(cfg.dataDir);
  const promptStore = new PromptStore(cfg.dataDir);

  if (cfg.transcriptRetentionDays > 0) {
    const deleted = await transcriptStore.prune(cfg.transcriptRetentionDays);
    if (deleted > 0) console.log(`[bridge] pruned ${deleted} stale transcript file(s)`);
  }

  const bindHost = cfg.bindHost ?? (await resolveTailscaleIPv4());
  console.log(`[bridge] binding to ${bindHost}:${cfg.port}`);

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../apps/web/dist'),
    resolve(here, '../../apps/web/dist'),
  ];
  const staticDir = candidates.find((p) => existsSync(p));
  if (!staticDir) {
    throw new Error(
      `web bundle not found. Run \`npm run web:build\`. Looked in:\n  ${candidates.join('\n  ')}`,
    );
  }
  console.log(`[bridge] serving static bundle from ${staticDir}`);

  const driverFactory = (args: DriverFactoryArgs): AgentDriver => {
    if (args.agent === 'claude') {
      return new ClaudeProcess(args.projectPath) as unknown as AgentDriver;
    }
    if (args.agent === 'codex') {
      if (!args.account) {
        throw new Error('CodexProcess requires an account');
      }
      return new CodexProcess({
        projectPath: args.projectPath,
        codexHome: args.account.codexHome,
      }) as unknown as AgentDriver;
    }
    throw new Error(`unsupported agent: ${args.agent}`);
  };

  const sessionManager = new SessionManager({
    allowedDirs: cfg.allowedDirs,
    bufferCap: 1000,
    driverFactory,
    transcriptStore,
    promptStore,
    accounts,
  });

  const handler = createHttpHandler({
    token: cfg.token,
    staticDir,
    dataDir: cfg.dataDir,
  });
  const server = createServer(handler);
  attachWebSocket({
    server,
    token: cfg.token,
    sessionManager,
    accounts,
    promptStore,
  });

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
