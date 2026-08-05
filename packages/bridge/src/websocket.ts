import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  extractTokenFromRequest,
  isOriginAllowed,
  tokensMatch,
} from './auth.js';
import type { SessionManager } from './session.js';
import type { ClaudeConfigProfile, CodexAccount } from './accounts.js';
import type { PromptStore } from './prompt-store.js';
import type { FsApi, FsErrorCode } from './fs-api.js';
import type { ImageStore } from './image-store.js';
import type { HistoryScanner } from './history-scanner.js';
import type { ProfileStore } from './profile-store.js';
import type { SlashCommandsScanner } from './slash-commands.js';
import type { FileSearch } from './file-search.js';
import type { TerminalManager } from './terminal-manager.js';
import { PathOutsideAllowlistError } from './path-allowlist.js';
import { JobNotFoundError, jobLaunchPrompt, type JobStore } from './job-store.js';
import type {
  ClientMsg,
  ServerErrorMsg,
  ServerMsg,
} from './types.js';

const MAX_MSG_BYTES = 64 * 1024 * 1024; // bumped from 16 MB to fit 4×10MB image batch (base64 ~= 52 MB)

export interface AttachWsOpts {
  server: HttpServer;
  token: string;
  sessionManager: SessionManager;
  accounts: Map<string, CodexAccount>;
  /** Named CLAUDE_CONFIG_DIR profiles, surfaced through `list_accounts`. */
  claudeConfigs?: Map<string, ClaudeConfigProfile>;
  promptStore?: PromptStore;
  fsApi: FsApi;
  /** Enables editing the named Claude profiles from the UI. */
  claudeConfigStore?: import('./claude-config-store.js').ClaudeConfigStore;
  imageStore: ImageStore;
  historyScanner: HistoryScanner;
  profileStore: ProfileStore;
  slashCommands: SlashCommandsScanner;
  fileSearch: FileSearch;
  terminalManager: TerminalManager;
  /** Backlog jobs — work written down before an agent runs. */
  jobStore: JobStore;
  /** Roots the client may browse for projects. */
  allowedDirs: string[];
  capabilities: { terminal: boolean };
}

export function attachWebSocket(opts: AttachWsOpts): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });

  opts.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = extractTokenFromRequest(req);
    if (!token || !tokensMatch(token, opts.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!isOriginAllowed(req.headers.origin, req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      setTimeout(() => wss.emit('connection', ws, req), 0);
    });
  });

  /**
   * Fan a message out to every connected socket. Job mutations use this so a
   * card created on your laptop appears on your phone, matching how session
   * mutations already behave.
   */
  const broadcastAll = (m: ServerMsg): void => {
    opts.sessionManager.emit('broadcast', m);
  };

  // wsId → ws (so terminalManager output/exit can find the right socket)
  const wsByConn = new Map<string, WebSocket>();
  // termId → wsId, populated on term_started, removed on term_exit / killByWs.
  const termOwner = new Map<string, string>();

  opts.terminalManager.on('output', (termId: string, data: string) => {
    const wsId = termOwner.get(termId);
    if (!wsId) return;
    const ws = wsByConn.get(wsId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: 'term_output', termId, data } satisfies import('./types.js').ServerTermOutputMsg));
    opts.terminalManager.reportBufferedAmount(termId, ws.bufferedAmount);
  });

  opts.terminalManager.on('exit', (termId: string, exitCode: number | null, signal: string | null) => {
    const wsId = termOwner.get(termId);
    termOwner.delete(termId);
    if (!wsId) return;
    const ws = wsByConn.get(wsId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: 'term_exit', termId, exitCode, signal } satisfies import('./types.js').ServerTermExitMsg));
  });

  // IMPORTANT: the manager event was renamed from 'error' to 'policy_violation'
  // during Task 4 review (Node's EventEmitter crashes on unhandled 'error').
  opts.terminalManager.on('policy_violation', (e: { wsId: string; code: 'terminal_not_found'; termId: string }) => {
    const ws = wsByConn.get(e.wsId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: 'error', code: e.code, message: `terminal ${e.termId} not found` } satisfies import('./types.js').ServerErrorMsg));
  });

  wss.on('connection', (ws) => {
    const wsId = randomUUID();
    wsByConn.set(wsId, ws);

    const send = (m: ServerMsg) => {
      try {
        ws.send(JSON.stringify(m));
      } catch {
        /* ignore */
      }
    };
    const broadcast = (m: ServerMsg) => send(m);
    opts.sessionManager.on('broadcast', broadcast);
    ws.on('close', () => {
      opts.sessionManager.off('broadcast', broadcast);
      // Drop maps FIRST so any synchronous exit handler fired by killByWs
      // finds neither termOwner nor wsByConn populated for this connection.
      for (const [termId, owner] of termOwner) {
        if (owner === wsId) termOwner.delete(termId);
      }
      wsByConn.delete(wsId);
      // Kill any PTYs spawned by this ws (may synchronously fire exit events).
      opts.terminalManager.killByWs(wsId);
    });

    send({
      type: 'system',
      event: 'init',
      capabilities: opts.capabilities,
      allowedDirs: opts.allowedDirs,
    });

    ws.on('message', (raw) => {
      void handleMessage(
        ws,
        wsId,
        raw,
        opts.sessionManager,
        opts.terminalManager,
        termOwner,
        send,
        opts.accounts,
        opts.claudeConfigs ?? new Map(),
        opts.promptStore,
        opts.fsApi,
        opts.claudeConfigStore,
        opts.imageStore,
        opts.historyScanner,
        opts.profileStore,
        opts.slashCommands,
        opts.fileSearch,
        opts.jobStore,
        broadcastAll,
        opts.capabilities,
      );
    });
  });

  return wss;
}

function isValidPtyDim(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 65535;
}

async function handleMessage(
  _ws: WebSocket,
  wsId: string,
  raw: import('ws').RawData,
  sessionManager: SessionManager,
  terminalManager: TerminalManager,
  termOwner: Map<string, string>,
  send: (m: ServerMsg) => void,
  accounts: Map<string, CodexAccount>,
  claudeConfigs: Map<string, ClaudeConfigProfile>,
  promptStore: PromptStore | undefined,
  fsApi: FsApi,
  claudeConfigStore: import('./claude-config-store.js').ClaudeConfigStore | undefined,
  imageStore: ImageStore,
  historyScanner: HistoryScanner,
  profileStore: ProfileStore,
  slashCommands: SlashCommandsScanner,
  fileSearch: FileSearch,
  jobStore: JobStore,
  broadcastAll: (m: ServerMsg) => void,
  capabilities: { terminal: boolean },
): Promise<void> {
  const mgr = sessionManager;
  let msg: ClientMsg;
  try {
    msg = JSON.parse(raw.toString()) as ClientMsg;
  } catch {
    sendError(send, 'unsupported_message', 'malformed JSON');
    return;
  }
  if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
    sendError(send, 'unsupported_message', 'missing type');
    return;
  }

  try {
    switch (msg.type) {
      case 'start': {
        // Phase 6: dirs[] wins over projectPath; first dir is the primary cwd.
        // Multi-dir requests route to spawnSession (which validates every dir
        // and stores additionalDirs on the registry entry); single-dir falls
        // through the same code path with dirs=[projectPath]. The legacy
        // create() shape is no longer needed at the wire layer because
        // spawnSession is a strict superset.
        const dirs = msg.dirs && msg.dirs.length > 0
          ? msg.dirs
          : msg.projectPath
            ? [msg.projectPath]
            : [];
        if (dirs.length === 0) {
          sendError(send, 'project_path_missing', 'start requires projectPath or dirs', msg.correlationId);
          return;
        }
        await sessionManager.spawnSession({
          agent: msg.agent,
          dirs,
          ...(msg.account ? { account: msg.account } : {}),
          ...(msg.claudeConfig ? { claudeConfig: msg.claudeConfig } : {}),
          ...(msg.model ? { model: msg.model } : {}),
          ...(msg.effort ? { effort: msg.effort } : {}),
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
        });
        return;
      }
      case 'input': {
        const session = mgr.knowsSession(msg.sessionId)
          ? mgr.listSessions().find((s) => s.sessionId === msg.sessionId)
          : undefined;
        let imagePaths: string[] | undefined;
        if (msg.images && msg.images.length > 0) {
          const agent = session?.agent;
          if (!agent) {
            sendError(send, 'session_dead', `session ${msg.sessionId} not alive`, msg.correlationId, msg.sessionId);
            return;
          }
          const v = imageStore.validate(msg.images, agent);
          if (!v.ok) {
            sendError(send, v.error, errorMessageFor(v.error), msg.correlationId, msg.sessionId);
            return;
          }
          // Codex reads images off disk (`-i <FILE>`), so they have to exist
          // before the turn spawns. Written here, where we can await, rather
          // than inside the driver — `sendUserText` is synchronous, and making
          // it await would let two rapid turns both pass the concurrent-turn
          // guard and spawn. Claude keeps the fire-and-forget write inside
          // `sendInput`, since it gets the bytes inline on stdin.
          if (agent === 'codex') {
            imagePaths = await imageStore.writeAuditCopy(msg.sessionId, msg.images.slice());
          }
        }
        try {
          mgr.sendInput(msg.sessionId, msg.text, msg.images, imagePaths);
        } catch (err) {
          const e = err as { code?: string; message?: string };
          if (e.code === 'session_dead') {
            sendError(send, 'session_dead', e.message ?? 'session dead', msg.correlationId, msg.sessionId);
            return;
          }
          throw err;
        }
        return;
      }
      case 'stop_session': {
        mgr.stop(msg.sessionId);
        return;
      }
      case 'interrupt_session': {
        try {
          if (!mgr.interrupt(msg.sessionId)) {
            sendError(
              send,
              'interrupt_not_supported',
              errorMessageFor('interrupt_not_supported'),
              msg.correlationId,
              msg.sessionId,
            );
          }
        } catch (err) {
          const e = err as { code?: string; message?: string };
          if (e.code === 'session_dead') {
            sendError(send, 'session_dead', e.message ?? 'session dead', msg.correlationId, msg.sessionId);
            return;
          }
          throw err;
        }
        return;
      }
      case 'list_sessions': {
        send({
          type: 'session_list',
          sessions: mgr.listSessions(),
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
        });
        return;
      }
      case 'get_history': {
        const h = mgr.getHistory(msg.sessionId, msg.since ?? 0);
        if (h === null) {
          // Session is not (or no longer) live. Reply with session_dead
          // carrying both correlationId AND sessionId so the web client can
          // route to the per-session transcript-only fallback.
          sendError(
            send,
            'session_dead',
            `session ${msg.sessionId} is not alive`,
            msg.correlationId,
            msg.sessionId,
          );
          return;
        }
        send({
          type: 'history',
          sessionId: msg.sessionId,
          events: h.events,
          hasMore: h.hasMore,
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
        });
        return;
      }
      case 'list_accounts': {
        send({
          type: 'account_list',
          accounts: [
            ...[...accounts.values()].map((a) => ({
              name: a.name,
              agent: 'codex' as const,
              isDefault: a.isDefault,
            })),
            // Claude profiles ride the same channel so the picker has one
            // source. `configDir` is included so the settings UI can show and
            // edit where each profile points — a local path, but one this
            // token already grants far broader access to than reading it.
            ...[...claudeConfigs.values()].map((c) => ({
              name: c.name,
              agent: 'claude' as const,
              isDefault: c.isDefault,
              configDir: c.configDir,
            })),
          ],
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
        });
        return;
      }
      case 'save_claude_config':
      case 'delete_claude_config': {
        if (!claudeConfigStore) {
          sendError(send, 'unsupported_message', 'Claude profiles are not configurable', msg.correlationId);
          return;
        }
        try {
          if (msg.type === 'save_claude_config') {
            await claudeConfigStore.save(msg.name, msg.configDir);
          } else {
            await claudeConfigStore.remove(msg.name);
          }
        } catch (err) {
          const e = err as { code?: string };
          if (e.code === 'claude_config_invalid' || e.code === 'claude_config_not_found') {
            sendError(send, e.code, (err as Error).message, msg.correlationId);
            return;
          }
          sendError(send, 'unsupported_message', (err as Error).message, msg.correlationId);
          return;
        }
        // Everyone's picker has to agree about what exists, so the new list
        // goes to every client rather than just the one that edited it.
        broadcastAll({
          type: 'account_list',
          accounts: [
            ...[...accounts.values()].map((a) => ({
              name: a.name,
              agent: 'codex' as const,
              isDefault: a.isDefault,
            })),
            ...[...claudeConfigs.values()].map((c) => ({
              name: c.name,
              agent: 'claude' as const,
              isDefault: c.isDefault,
              configDir: c.configDir,
            })),
          ],
        });
        return;
      }
      case 'list_all_sessions': {
        send({
          type: 'all_sessions',
          sessions: sessionManager.listBoardSessions({
            includeArchived: msg.includeArchived === true,
          }),
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
        });
        return;
      }
      case 'set_session_model': {
        await runBoardMutation(send, msg.correlationId, 'session_model_invalid', () =>
          sessionManager.setSessionModel(msg.sessionId, {
            ...(msg.model !== undefined ? { model: msg.model } : {}),
            ...(msg.effort !== undefined ? { effort: msg.effort } : {}),
          }),
        );
        return;
      }
      case 'set_session_phase': {
        await runBoardMutation(send, msg.correlationId, 'session_phase_invalid', () =>
          sessionManager.setSessionPhase(msg.sessionId, msg.phase),
        );
        return;
      }
      case 'set_session_tags': {
        await runBoardMutation(send, msg.correlationId, 'session_tags_invalid', () =>
          sessionManager.setSessionTags(msg.sessionId, msg.tags),
        );
        return;
      }
      case 'archive_session': {
        await runBoardMutation(send, msg.correlationId, 'session_not_found', () =>
          sessionManager.setSessionArchived(msg.sessionId, msg.archived === true),
        );
        return;
      }
      case 'delete_session': {
        await runBoardMutation(send, msg.correlationId, 'session_not_found', () =>
          sessionManager.deleteSession(msg.sessionId),
        );
        return;
      }
      case 'get_rate_limits': {
        send({
          type: 'rate_limits',
          windows: sessionManager.rateLimitWindows(),
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
        });
        return;
      }
      case 'list_jobs': {
        send({
          type: 'job_list',
          jobs: jobStore.all({
            includeArchived: msg.includeArchived === true,
            includeStarted: msg.includeStarted === true,
          }),
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
        });
        return;
      }
      case 'create_job': {
        await runBoardMutation(send, msg.correlationId, 'job_invalid', async () => {
          // Validate the target dir against the allowlist now rather than at
          // start time — a job pointing somewhere unreachable is a trap the
          // user only discovers later.
          const real = await sessionManager.validatePath(msg.projectPath);
          const job = await jobStore.create({
            title: msg.title,
            ...(msg.notes !== undefined ? { notes: msg.notes } : {}),
            ...(msg.tags !== undefined ? { tags: msg.tags } : {}),
            projectPath: real,
            ...(msg.additionalDirs ? { additionalDirs: msg.additionalDirs } : {}),
            agent: msg.agent,
            ...(msg.account !== undefined ? { account: msg.account } : {}),
            ...(msg.claudeConfig !== undefined ? { claudeConfig: msg.claudeConfig } : {}),
            ...(msg.model !== undefined ? { model: msg.model } : {}),
            ...(msg.effort !== undefined ? { effort: msg.effort } : {}),
          });
          broadcastAll({
            type: 'job_upserted',
            job,
            ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
          });
        });
        return;
      }
      case 'update_job': {
        await runBoardMutation(send, msg.correlationId, 'job_invalid', async () => {
          const patch: Parameters<typeof jobStore.update>[1] = {};
          if (msg.title !== undefined) patch.title = msg.title;
          if (msg.notes !== undefined) patch.notes = msg.notes;
          if (msg.tags !== undefined) patch.tags = msg.tags;
          if (msg.projectPath !== undefined) {
            patch.projectPath = await sessionManager.validatePath(msg.projectPath);
          }
          if (msg.additionalDirs !== undefined) patch.additionalDirs = msg.additionalDirs;
          if (msg.agent !== undefined) patch.agent = msg.agent;
          if (msg.account !== undefined) patch.account = msg.account;
          if (msg.claudeConfig !== undefined) patch.claudeConfig = msg.claudeConfig;
          if (msg.model !== undefined) patch.model = msg.model;
          if (msg.effort !== undefined) patch.effort = msg.effort;
          if (msg.archived !== undefined) patch.archived = msg.archived;
          const job = await jobStore.update(msg.jobId, patch);
          broadcastAll({
            type: 'job_upserted',
            job,
            ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
          });
        });
        return;
      }
      case 'delete_job': {
        await runBoardMutation(send, msg.correlationId, 'job_not_found', async () => {
          await jobStore.remove(msg.jobId);
          broadcastAll({
            type: 'job_deleted',
            jobId: msg.jobId,
            ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
          });
        });
        return;
      }
      case 'start_job': {
        await runBoardMutation(send, msg.correlationId, 'job_not_found', async () => {
          const job = jobStore.get(msg.jobId);
          if (!job) throw new JobNotFoundError(msg.jobId);
          if (job.startedSessionId !== null) {
            throw Object.assign(new Error(`Job ${job.id} already started`), {
              code: 'job_already_started',
            });
          }

          const info = await sessionManager.spawnSession({
            agent: job.agent,
            dirs: [job.projectPath, ...job.additionalDirs],
            ...(job.account ? { account: job.account } : {}),
            ...(job.claudeConfig ? { claudeConfig: job.claudeConfig } : {}),
            ...(job.model ? { model: job.model } : {}),
            ...(job.effort ? { effort: job.effort } : {}),
            ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
          });

          // Carry the tags over so the board keeps its grouping across the
          // job → session hand-off.
          if (job.tags.length > 0) {
            await sessionManager.setSessionTags(info.sessionId, job.tags).catch((err: unknown) =>
              console.warn('[jobs] tag carry-over failed:', err),
            );
          }

          // Seed the first turn with the job text. This also triggers the
          // usual auto-name + titler path, so the session names itself.
          sessionManager.sendInput(info.sessionId, jobLaunchPrompt(job));

          const started = await jobStore.markStarted(job.id, info.sessionId);
          broadcastAll({ type: 'job_upserted', job: started });
          broadcastAll({
            type: 'job_started',
            jobId: job.id,
            sessionId: info.sessionId,
            ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
          });
        });
        return;
      }
      case 'list_prompts': {
        const prompts = promptStore
          ? promptStore.list(msg.query, msg.limit ?? 200).map((e) => ({
              text: e.text,
              lastUsedAt: e.lastUsedAt,
              projectPaths: e.projectPaths,
              agents: e.agents,
            }))
          : [];
        send({
          type: 'prompts_result',
          prompts,
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
        });
        return;
      }
      case 'list_dirs': {
        try {
          const entries = await fsApi.listDirs(msg.path);
          send({
            type: 'dirs_result',
            path: msg.path,
            entries,
            ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
          });
        } catch (err) {
          sendFsError(send, err, msg.correlationId);
        }
        return;
      }
      case 'read_file': {
        try {
          const result = await fsApi.readFile(msg.path);
          if (result.kind === 'text') {
            send({
              type: 'file_result',
              kind: 'text',
              path: msg.path,
              content: result.content,
              bytesRead: result.bytesRead,
              truncated: result.truncated,
              hash: result.hash,
              ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
            });
          } else if (result.kind === 'binary') {
            send({
              type: 'file_result',
              kind: 'binary',
              path: msg.path,
              size: result.size,
              ...(result.mime ? { mime: result.mime } : {}),
              ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
            });
          } else {
            send({
              type: 'file_result',
              kind: 'too_large',
              path: msg.path,
              size: result.size,
              ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
            });
          }
        } catch (err) {
          sendFsError(send, err, msg.correlationId);
        }
        return;
      }
      case 'write_file': {
        if (typeof msg.path !== 'string' || typeof msg.content !== 'string') {
          sendError(send, 'unsupported_message', 'write_file needs path and content', msg.correlationId);
          return;
        }
        try {
          const result = await fsApi.writeFile(msg.path, msg.content, msg.baseHash);
          send({
            type: 'file_written',
            path: msg.path,
            bytesWritten: result.bytesWritten,
            hash: result.hash,
            ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
          });
        } catch (err) {
          sendFsError(send, err, msg.correlationId);
        }
        return;
      }
      case 'list_history': {
        try {
          const result = await historyScanner.list();
          send({
            type: 'history_list',
            claude: result.claude,
            codex: result.codex,
            correlationId: msg.correlationId,
          });
        } catch (err) {
          send({
            type: 'error',
            code: 'resume_spawn_failed',
            message: (err as Error).message,
            correlationId: msg.correlationId,
          });
        }
        break;
      }
      case 'resume_session': {
        try {
          let webSessionId: string;
          if ('webSessionId' in msg) {
            // Path 1: bridge-known
            webSessionId = msg.webSessionId;
            await mgr.resume(webSessionId);
          } else {
            // Path 2: native history first-resume
            const entry = await historyScanner.findEntry(msg.agent, msg.sessionId);
            if (!entry) {
              send({
                type: 'error',
                code: 'history_session_not_found',
                message: `No history session found for ${msg.agent}:${msg.sessionId}`,
                correlationId: msg.correlationId,
              });
              return;
            }
            const replayFilePath = historyScanner.filePathFor(msg.agent, msg.sessionId);
            webSessionId = await mgr.resumeFromHistoryEntry(
              { ...entry, ...(replayFilePath ? { replayFilePath } : {}) },
              msg.account ?? null,
            );
            historyScanner.invalidateCache();
          }
          send({
            type: 'session_resumed',
            webSessionId,
            alive: true,
            correlationId: msg.correlationId,
          });
        } catch (err) {
          const code = (err as { code?: string }).code ?? 'resume_spawn_failed';
          send({
            type: 'error',
            code: code as never,
            message: (err as Error).message,
            correlationId: msg.correlationId,
            ...('webSessionId' in msg ? { sessionId: msg.webSessionId } : {}),
          });
        }
        break;
      }
      case 'list_profiles': {
        const profiles = profileStore.list();
        send({ type: 'profile_list', profiles, correlationId: msg.correlationId });
        break;
      }
      case 'save_profile': {
        try {
          const existing = profileStore.get(msg.profile.name, msg.profile.agent);
          if (existing) {
            await profileStore.update(msg.profile.name, msg.profile.agent, msg.profile);
          } else {
            await profileStore.add(msg.profile);
          }
          send({ type: 'profile_saved', profile: msg.profile, correlationId: msg.correlationId });
        } catch (err) {
          const code = (err as { code?: string }).code ?? 'profile_invalid_name';
          send({
            type: 'error',
            code: code as never,
            message: (err as Error).message,
            correlationId: msg.correlationId,
          });
        }
        break;
      }
      case 'delete_profile': {
        try {
          await profileStore.remove(msg.name, msg.agent);
          send({
            type: 'profile_deleted',
            name: msg.name,
            agent: msg.agent,
            correlationId: msg.correlationId,
          });
        } catch (err) {
          send({
            type: 'error',
            code: 'profile_not_found',
            message: (err as Error).message,
            correlationId: msg.correlationId,
          });
        }
        break;
      }
      case 'set_default_profile': {
        try {
          await profileStore.setDefault(msg.name, msg.agent);
          send({
            type: 'profile_default_set',
            name: msg.name,
            agent: msg.agent,
            correlationId: msg.correlationId,
          });
        } catch (err) {
          send({
            type: 'error',
            code: 'profile_not_found',
            message: (err as Error).message,
            correlationId: msg.correlationId,
          });
        }
        break;
      }
      case 'list_slash_commands': {
        try {
          // SessionManager has no single-id getter; use listSessions() and
          // find by id. Reuses the P5 history_session_not_found code for the
          // unknown-session case (rather than minting a new error code).
          const session = sessionManager
            .listSessions()
            .find((s) => s.sessionId === msg.sessionId);
          if (!session) {
            send({
              type: 'error',
              code: 'history_session_not_found',
              message: `Unknown session ${msg.sessionId}`,
              correlationId: msg.correlationId,
            });
            return;
          }
          const commands = await slashCommands.listForSession({
            sessionId: msg.sessionId,
            agent: session.agent,
            primaryCwd: session.projectPath,
          });
          send({ type: 'slash_commands_list', commands, correlationId: msg.correlationId });
        } catch (err) {
          send({
            type: 'error',
            code: 'slash_commands_failed',
            message: (err as Error).message,
            correlationId: msg.correlationId,
          });
        }
        break;
      }
      case 'search_files': {
        try {
          const result = await fileSearch.search(msg.sessionId, msg.query);
          send({
            type: 'file_search_results',
            hits: result.hits,
            truncated: result.truncated,
            correlationId: msg.correlationId,
          });
        } catch (err) {
          send({
            type: 'error',
            code: 'file_search_failed',
            message: (err as Error).message,
            correlationId: msg.correlationId,
          });
        }
        break;
      }
      case 'rename_session': {
        try {
          await sessionManager.renameSession(msg.sessionId, msg.name);
          send({
            type: 'session_renamed',
            sessionId: msg.sessionId,
            name: msg.name,
            correlationId: msg.correlationId,
          });
        } catch (err) {
          const code = (err as { code?: string }).code ?? 'session_name_invalid';
          send({
            type: 'error',
            code: code as never,
            message: (err as Error).message,
            correlationId: msg.correlationId,
          });
        }
        break;
      }
      case 'term_start': {
        if (!capabilities.terminal) {
          sendError(send, 'pty_not_available', 'node-pty is not installed in this bridge build', msg.correlationId);
          return;
        }
        if (!isValidPtyDim(msg.cols) || !isValidPtyDim(msg.rows)) {
          sendError(send, 'unsupported_message', 'cols/rows must be positive integers ≤ 65535', msg.correlationId);
          return;
        }
        try {
          const session = await terminalManager.spawn(wsId, msg.cwd, msg.cols, msg.rows);
          termOwner.set(session.termId, wsId);
          send({
            type: 'term_started',
            termId: session.termId,
            cwd: session.cwd,
            createdAt: session.createdAt,
            correlationId: msg.correlationId,
          });
        } catch (err) {
          const code = err instanceof PathOutsideAllowlistError
            ? 'path_outside_allowlist'
            : 'terminal_spawn_failed';
          const message = err instanceof Error ? err.message : String(err);
          sendError(send, code, message, msg.correlationId);
        }
        return;
      }
      case 'term_input': {
        terminalManager.sendInput(wsId, msg.termId, msg.data);
        return;
      }
      case 'term_resize': {
        if (!isValidPtyDim(msg.cols) || !isValidPtyDim(msg.rows)) {
          // Silently drop malformed resize — best-effort, no correlationId.
          return;
        }
        terminalManager.resize(wsId, msg.termId, msg.cols, msg.rows);
        return;
      }
      case 'term_kill': {
        terminalManager.kill(wsId, msg.termId);
        // Reply is the eventual term_exit broadcast; ack here is implicit.
        return;
      }
      default:
        sendError(send, 'unsupported_message', `unknown type ${(msg as { type: string }).type}`, (msg as { correlationId?: string }).correlationId);
    }
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const correlationId = (msg as { correlationId?: string }).correlationId;
    if (e.code === 'path_outside_allowlist') {
      sendError(send, 'path_outside_allowlist', e.message ?? 'path outside allowlist', correlationId);
      return;
    }
    if (e.code === 'unknown_account') {
      sendError(send, 'unknown_account', e.message ?? 'unknown account', correlationId);
      return;
    }
    if (e.code === 'session_dead') {
      const sessionId = (msg as { sessionId?: string }).sessionId;
      sendError(send, 'session_dead', e.message ?? 'session dead', correlationId, sessionId);
      return;
    }
    sendError(send, 'unsupported_message', e.message ?? 'internal error', correlationId);
  }
}

/**
 * Run a board mutation, replying only on failure.
 *
 * Success is already announced to every connected client by the manager's
 * `broadcast` fan-out, so a direct reply would just duplicate it. Errors do
 * need a targeted reply, since only the requesting client has an optimistic
 * update to roll back — hence the correlationId.
 */
async function runBoardMutation(
  send: (m: ServerMsg) => void,
  correlationId: string | undefined,
  fallbackCode: ServerErrorMsg['code'],
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    const code = ((err as { code?: string }).code ?? fallbackCode) as ServerErrorMsg['code'];
    sendError(send, code, (err as Error).message, correlationId);
  }
}

function sendError(
  send: (m: ServerMsg) => void,
  code: ServerErrorMsg['code'],
  message: string,
  correlationId?: string,
  sessionId?: string,
): void {
  send({
    type: 'error',
    code,
    message,
    ...(correlationId ? { correlationId } : {}),
    ...(sessionId ? { sessionId } : {}),
  });
}

const FS_ERROR_CODES: ReadonlySet<string> = new Set<FsErrorCode>([
  'path_outside_allowlist',
  'path_denied',
  'file_too_large',
  'file_conflict',
  'file_write_failed',
]);

/**
 * Forward an `FsAccessError` code straight to the client, so the UI can tell a
 * conflict apart from a denial. Anything else is an unexpected throw and stays
 * generic rather than leaking an internal message shape as a typed code.
 */
function sendFsError(
  send: (m: ServerMsg) => void,
  err: unknown,
  correlationId?: string,
): void {
  const code = (err as { code?: string }).code;
  if (code && FS_ERROR_CODES.has(code)) {
    sendError(send, code as ServerErrorMsg['code'], (err as Error).message, correlationId);
  } else {
    sendError(send, 'unsupported_message', (err as Error).message, correlationId);
  }
}

function errorMessageFor(code: ServerErrorMsg['code']): string {
  switch (code) {
    case 'images_not_supported_for_agent':
      return 'This agent does not accept images.';
    case 'interrupt_not_supported':
      return 'This session cannot be interrupted; stop it instead.';
    case 'too_many_images':
      return 'At most 4 images per message.';
    case 'image_too_large':
      return 'Each image must be ≤ 10 MB after decoding.';
    case 'image_invalid_mime':
      return 'Allowed image MIME types: image/png, image/jpeg, image/webp, image/gif.';
    default:
      return code;
  }
}
