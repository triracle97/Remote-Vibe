import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { realpath as fsRealpath } from 'node:fs/promises';
import { homedir } from 'node:os';
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
import { FsApi } from './fs-api.js';
import { ImageStore } from './image-store.js';
import { HistoryScanner } from './history-scanner.js';
import { SessionRegistry } from './session-registry.js';
import { ProfileStore } from './profile-store.js';
import { SlashCommandsScanner } from './slash-commands.js';
import { FileSearch } from './file-search.js';
import { Notifier } from './notifier.js';

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

  const fsApi = new FsApi({ allowedDirs: cfg.allowedDirs });
  const imageStore = new ImageStore({ dataDir: cfg.dataDir });

  const registry = new SessionRegistry(join('.bridge', 'sessions.json'));
  await registry.load();

  // Phase 6: profiles
  const profilesPath = process.env.BRIDGE_PROFILES_FILE ?? join('.bridge', 'profiles.json');
  const profileStore = new ProfileStore(profilesPath);
  await profileStore.load();

  // Phase 6: slash commands scanner
  const slashCommands = new SlashCommandsScanner({ homeDir: homedir() });

  // Phase 6: file search
  const fileSearch = new FileSearch({
    getDirsForSession: (sessionId: string) => {
      const entry = registry.get(sessionId);
      if (!entry) return [];
      return [entry.projectPath, ...entry.additionalDirs];
    },
    ...(process.env.BRIDGE_FILE_SEARCH_CAP
      ? { fileCap: Number(process.env.BRIDGE_FILE_SEARCH_CAP) }
      : {}),
  });

  // Phase 6: telegram notifier (no-op if env unset)
  const notifier = new Notifier({
    ...(process.env.BRIDGE_TELEGRAM_BOT_TOKEN ? { token: process.env.BRIDGE_TELEGRAM_BOT_TOKEN } : {}),
    ...(process.env.BRIDGE_TELEGRAM_CHAT_ID ? { chatId: process.env.BRIDGE_TELEGRAM_CHAT_ID } : {}),
    minDurationMs: process.env.BRIDGE_NOTIFY_MIN_DURATION_MS
      ? Number(process.env.BRIDGE_NOTIFY_MIN_DURATION_MS)
      : 180_000,
    ...(process.env.BRIDGE_PUBLIC_URL ? { publicUrl: process.env.BRIDGE_PUBLIC_URL } : {}),
  });

  const sessionManager = new SessionManager({
    allowedDirs: cfg.allowedDirs,
    bufferCap: 1000,
    driverFactory,
    transcriptStore,
    promptStore,
    accounts,
    imageStore,
    registry,
    notifier,
  });

  const handler = createHttpHandler({
    token: cfg.token,
    staticDir,
    dataDir: cfg.dataDir,
  });
  const server = createServer(handler);
  // Pre-resolve allowed dirs once for the history scanner's allowlist gate.
  // Uses the same prefix-match semantics as fs-api / SessionManager.
  const resolvedAllowed = await Promise.all(
    cfg.allowedDirs.map((d) => fsRealpath(d).catch(() => d)),
  );
  const historyScanner = new HistoryScanner({
    homeDir: homedir(),
    allowedDirs: cfg.allowedDirs,
    allowlistGate: async (cwd: string) => {
      let real: string;
      try {
        real = await fsRealpath(cwd);
      } catch {
        return false;
      }
      return resolvedAllowed.some((d) => real === d || real.startsWith(d + sep));
    },
  });
  attachWebSocket({
    server,
    token: cfg.token,
    sessionManager,
    accounts,
    promptStore,
    fsApi,
    imageStore,
    historyScanner,
    profileStore,
    slashCommands,
    fileSearch,
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
