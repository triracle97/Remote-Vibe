import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { realpath as fsRealpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { ClaudeProcess } from './claude-process.js';
import { CodexProcess } from './codex-process.js';
import { loadClaudeConfigProfiles, loadCodexAccounts } from './accounts.js';
import { HeadroomProxy } from './headroom.js';
import { SessionTitler } from './titler.js';
import { loadEnv } from './env.js';
import { loadEnvFile } from './env-file.js';
import { resolveTailscaleIPv4 } from './tailscale.js';
import { createHttpHandler } from './http-server.js';
import { McpConfigWriter } from './mcp-config.js';
import { ClaudeSettingsWriter } from './claude-settings.js';
import { ClaudeConfigStore } from './claude-config-store.js';
import { handleMcpRequest, type McpDeps } from './mcp-server.js';
import { attachWebSocket } from './websocket.js';
import { SessionManager, type AgentDriver, type DriverFactoryArgs } from './session.js';
import { TranscriptStore } from './transcript-store.js';
import { PromptStore } from './prompt-store.js';
import { FsApi } from './fs-api.js';
import { ImageStore } from './image-store.js';
import { HistoryScanner } from './history-scanner.js';
import { SessionRegistry } from './session-registry.js';
import { JobStore } from './job-store.js';
import { AGENT_DIRECTIVE_PROMPT } from './agent-directives.js';
import { ProfileStore } from './profile-store.js';
import { SlashCommandsScanner } from './slash-commands.js';
import { FileSearch } from './file-search.js';
import { Notifier } from './notifier.js';
import { TerminalManager } from './terminal-manager.js';

/**
 * Repo root, derived from this module's location rather than `process.cwd()`.
 *
 * `npm run bridge:dev` runs the script with cwd set to `packages/bridge`, so
 * anything resolved against cwd silently misses the root `.env` (fatal:
 * "BRIDGE_TOKEN is required") and would scatter a second `.bridge/` state
 * directory inside the package. Both `dist/index.js` and `src/index.ts` sit
 * three levels below the root, so one expression covers dev and prod.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Resolve a configured path against the repo root, leaving absolutes alone. */
function fromRepoRoot(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

async function main(): Promise<void> {
  // Load .env. Existing process env (e.g. shell exports) wins; the file is
  // just a default-source for missing values. Path can be overridden via
  // BRIDGE_ENV_FILE.
  const applied = loadEnvFile(
    process.env.BRIDGE_ENV_FILE
      ? fromRepoRoot(process.env.BRIDGE_ENV_FILE)
      : join(REPO_ROOT, '.env'),
  );
  if (applied > 0) console.log(`[bridge] loaded ${applied} value(s) from .env`);

  const cfg = loadEnv(process.env);

  const requireCJS = createRequire(import.meta.url);
  let terminalCapable = false;
  try {
    requireCJS('node-pty');
    terminalCapable = true;
  } catch (err) {
    console.warn(
      '[bridge] node-pty failed to load — terminal mode disabled:',
      (err as Error).message,
    );
  }

  const accounts = loadCodexAccounts({ dataDir: cfg.dataDir, env: process.env });
  console.log(`[bridge] loaded ${accounts.size} codex account(s): ${[...accounts.keys()].join(', ')}`);

  const claudeConfigs = loadClaudeConfigProfiles({
    dataDir: cfg.dataDir,
    env: process.env,
    defaultConfigDir: cfg.claudeConfigDir,
  });
  console.log(
    `[bridge] claude config profile(s): ` +
      [...claudeConfigs.values()]
        .map((c) => `${c.name}${c.isDefault ? '*' : ''}=${c.configDir}`)
        .join(', '),
  );

  const titler = new SessionTitler(cfg.titler);
  console.log(
    titler.enabled
      ? `[bridge] session titler on (${cfg.titler.model})`
      : '[bridge] session titler disabled (BRIDGE_TITLER_ENABLED)',
  );

  const headroomProxy = new HeadroomProxy(cfg.headroom);
  if (headroomProxy.enabled) {
    // Warm the proxy at boot so the first session does not pay the startup
    // cost. Deliberately not awaited — a slow or missing headroom must not
    // delay the bridge coming up, and sessions re-`ensure()` anyway.
    void headroomProxy.ensure();
  } else {
    console.log('[bridge] headroom disabled (BRIDGE_HEADROOM_ENABLED)');
  }

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
      // Every field here used to be dropped on the floor: the factory took
      // only projectPath, so `--resume` and `--add-dir` were dead in
      // production (they still passed in tests, which build the driver
      // directly). Resuming a session silently spawned a fresh Claude.
      return new ClaudeProcess(args.projectPath, {
        ...(args.resumeArgs ? { resumeArgs: args.resumeArgs } : {}),
        ...(args.additionalDirs ? { additionalDirs: args.additionalDirs } : {}),
        ...(args.claudeConfigDir ? { claudeConfigDir: args.claudeConfigDir } : {}),
        ...(args.headroom ? { headroom: args.headroom } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.effort ? { effort: args.effort } : {}),
        ...(args.mcpConfigPath ? { mcpConfigPath: args.mcpConfigPath } : {}),
        // Tell the agent it can move its own board card.
        appendSystemPrompt: AGENT_DIRECTIVE_PROMPT,
      }) as unknown as AgentDriver;
    }
    if (args.agent === 'codex') {
      if (!args.account) {
        throw new Error('CodexProcess requires an account');
      }
      return new CodexProcess({
        projectPath: args.projectPath,
        codexHome: args.account.codexHome,
        ...(args.headroom ? { headroom: args.headroom } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.effort ? { effort: args.effort } : {}),
      }) as unknown as AgentDriver;
    }
    throw new Error(`unsupported agent: ${args.agent}`);
  };

  const fsApi = new FsApi({
    allowedDirs: cfg.allowedDirs,
    readMaxBytes: cfg.fsReadMaxBytes,
    writeMaxBytes: cfg.fsWriteMaxBytes,
  });
  const imageStore = new ImageStore({ dataDir: cfg.dataDir });

  const jobStore = new JobStore(
    fromRepoRoot(process.env.BRIDGE_JOBS_FILE ?? join('.bridge', 'jobs.json')),
  );
  await jobStore.load();

  const registry = new SessionRegistry(fromRepoRoot(cfg.sessionsFile));
  await registry.load();

  // Older entries recorded `.bridge/transcripts/<id>.jsonl` while the store
  // has always written under the data dir, so every one named a file that did
  // not exist. Point them at the real location.
  {
    let fixed = 0;
    for (const entry of registry.all()) {
      const real = transcriptStore.pathFor(entry.webSessionId);
      if (entry.transcriptPath === real) continue;
      await registry.update(entry.webSessionId, { transcriptPath: real });
      fixed++;
    }
    if (fixed > 0) console.log(`[bridge] corrected ${fixed} transcript path(s)`);
  }

  // Backlog now means "jobs you wrote down", not "sessions that already ran".
  // Sessions predating that change were migrated into `backlog`, so move them
  // to `done` — they are finished runs, and they belong at the far end of the
  // board rather than in the queue of work still to do. One-time: the demoted
  // entries are pinned so inference and this migration both leave them alone.
  {
    const stale = registry.all().filter((e) => e.phase === 'backlog' && !e.phasePinned);
    for (const entry of stale) {
      await registry.update(entry.webSessionId, { phase: 'done', phasePinned: true });
    }
    if (stale.length > 0) {
      console.log(`[bridge] moved ${stale.length} pre-existing session(s) from Backlog to Done`);
    }
  }

  // Phase 6: profiles
  const profilesPath = fromRepoRoot(
    process.env.BRIDGE_PROFILES_FILE ?? join('.bridge', 'profiles.json'),
  );
  const profileStore = new ProfileStore(profilesPath);
  await profileStore.load();

  // Phase 6: slash commands scanner
  // Both scanners follow the default Claude profile so discovery matches what
  // sessions actually launch against.
  const defaultClaudeConfigDir = claudeConfigs.get('default')?.configDir;
  const slashCommands = new SlashCommandsScanner({
    homeDir: homedir(),
    ...(defaultClaudeConfigDir ? { claudeConfigDir: defaultClaudeConfigDir } : {}),
  });

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

  const mcpConfigWriter = new McpConfigWriter({
    dataDir: cfg.dataDir,
    port: cfg.port,
    token: cfg.token,
  });
  const claudeSettingsWriter = new ClaudeSettingsWriter(cfg.dataDir);

  const sessionManager = new SessionManager({
    allowedDirs: cfg.allowedDirs,
    bufferCap: 1000,
    driverFactory,
    transcriptStore,
    promptStore,
    accounts,
    claudeConfigs,
    defaultModel: cfg.defaultModel,
    defaultEffort: cfg.defaultEffort,
    defaultWorkflowSize: cfg.defaultWorkflowSize,
    defaultWorkflowKeywordTrigger: cfg.defaultWorkflowKeywordTrigger,
    imageStore,
    registry,
    notifier,
    // Re-checked per spawn rather than captured once: if the proxy died since
    // boot this restarts it, and if it can't start the session still spawns.
    resolveHeadroom: async () =>
      (await headroomProxy.ensure()) ? headroomProxy.spawnConfig() : null,
    titler,
    writeMcpConfig: (webSessionId) => mcpConfigWriter.write(webSessionId),
    writeClaudeSettings: (webSessionId, settings) =>
      claudeSettingsWriter.write(webSessionId, settings),
  });

  // Backs the `spawn_session` MCP tool. Reads the registry directly rather than
  // caching, so the child count and parent lookup reflect sessions started by
  // any route — board, job, or another agent.
  const mcpDeps: McpDeps = {
    spawnSession: (o) =>
      sessionManager.spawnSession({
        agent: o.agent,
        dirs: o.dirs,
        ...(o.account ? { account: o.account } : {}),
        ...(o.model ? { model: o.model } : {}),
        ...(o.effort ? { effort: o.effort as never } : {}),
        ...(o.parentSessionId ? { parentSessionId: o.parentSessionId } : {}),
      }),
    sendUserText: (sessionId, text) => {
      sessionManager.sendInput(sessionId, text);
    },
    lookupSession: (sessionId) => {
      const entry = registry.get(sessionId);
      if (!entry) return undefined;
      return {
        projectPath: entry.projectPath,
        parentSessionId: entry.parentSessionId,
        name: entry.name,
      };
    },
    countChildren: (parentSessionId) =>
      registry.all().filter((e) => e.parentSessionId === parentSessionId).length,
  };

  const claudeConfigStore = new ClaudeConfigStore({
    dataDir: cfg.dataDir,
    profiles: claudeConfigs,
    ...(process.env.HOME ? { home: process.env.HOME } : {}),
  });

  const handler = createHttpHandler({
    token: cfg.token,
    staticDir,
    dataDir: cfg.dataDir,
    mcp: (req, res, body) => handleMcpRequest(mcpDeps, req, res, body),
  });
  const server = createServer(handler);
  // Pre-resolve allowed dirs once for the history scanner's allowlist gate.
  // Uses the same prefix-match semantics as fs-api / SessionManager.
  const resolvedAllowed = await Promise.all(
    cfg.allowedDirs.map((d) => fsRealpath(d).catch(() => d)),
  );
  const historyScanner = new HistoryScanner({
    homeDir: homedir(),
    ...(defaultClaudeConfigDir ? { claudeConfigDir: defaultClaudeConfigDir } : {}),
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
  const terminalManager = new TerminalManager({
    allowedDirs: cfg.allowedDirs,
  });
  attachWebSocket({
    server,
    token: cfg.token,
    sessionManager,
    accounts,
    claudeConfigs,
    promptStore,
    fsApi,
    claudeConfigStore,
    imageStore,
    historyScanner,
    profileStore,
    slashCommands,
    fileSearch,
    terminalManager,
    jobStore,
    allowedDirs: cfg.allowedDirs,
    capabilities: { terminal: terminalCapable },
  });

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(cfg.port, bindHost, () => res());
  });

  console.log(`[bridge] open: http://${bindHost}:${cfg.port}/?token=<TOKEN>`);

  const shutdown = async (): Promise<void> => {
    console.log('[bridge] shutting down');
    // Hard-kill deadline covers the entire shutdown sequence (PTY drain +
    // HTTP drain), not just the post-await tail.
    setTimeout(() => process.exit(1), 6000).unref();
    sessionManager.shutdown();
    await terminalManager.shutdown();
    // No-op unless this bridge started the proxy; a pre-existing one survives.
    await headroomProxy.stop();
    server.close(() => process.exit(0));
  };
  const onSignal = (): void => {
    shutdown().catch((err) => console.error('[bridge] shutdown error:', err));
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

main().catch((err) => {
  console.error('[bridge] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
