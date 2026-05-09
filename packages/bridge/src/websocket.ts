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
import type { CodexAccount } from './accounts.js';
import type { PromptStore } from './prompt-store.js';
import type { FsApi } from './fs-api.js';
import type { ImageStore } from './image-store.js';
import type { HistoryScanner } from './history-scanner.js';
import type { ProfileStore } from './profile-store.js';
import type { SlashCommandsScanner } from './slash-commands.js';
import type { FileSearch } from './file-search.js';
import type { TerminalManager } from './terminal-manager.js';
import { PathOutsideAllowlistError } from './path-allowlist.js';
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
  promptStore?: PromptStore;
  fsApi: FsApi;
  imageStore: ImageStore;
  historyScanner: HistoryScanner;
  profileStore: ProfileStore;
  slashCommands: SlashCommandsScanner;
  fileSearch: FileSearch;
  terminalManager: TerminalManager;
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

    send({ type: 'system', event: 'init', capabilities: opts.capabilities });

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
        opts.promptStore,
        opts.fsApi,
        opts.imageStore,
        opts.historyScanner,
        opts.profileStore,
        opts.slashCommands,
        opts.fileSearch,
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
  promptStore: PromptStore | undefined,
  fsApi: FsApi,
  imageStore: ImageStore,
  historyScanner: HistoryScanner,
  profileStore: ProfileStore,
  slashCommands: SlashCommandsScanner,
  fileSearch: FileSearch,
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
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
        });
        return;
      }
      case 'input': {
        const session = mgr.knowsSession(msg.sessionId)
          ? mgr.listSessions().find((s) => s.sessionId === msg.sessionId)
          : undefined;
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
        }
        try {
          mgr.sendInput(msg.sessionId, msg.text, msg.images);
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
          accounts: [...accounts.values()].map((a) => ({
            name: a.name,
            agent: 'codex' as const,
            isDefault: a.isDefault,
          })),
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
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
          const e = err as { code?: 'path_outside_allowlist' | 'path_denied' };
          if (e.code === 'path_outside_allowlist' || e.code === 'path_denied') {
            sendError(send, e.code, (err as Error).message, msg.correlationId);
          } else {
            sendError(send, 'unsupported_message', (err as Error).message, msg.correlationId);
          }
        }
        return;
      }
      case 'read_file': {
        try {
          const result = await fsApi.readFile(msg.path, 5 * 1024 * 1024);
          if (result.kind === 'text') {
            send({
              type: 'file_result',
              kind: 'text',
              path: msg.path,
              content: result.content,
              bytesRead: result.bytesRead,
              truncated: result.truncated,
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
          const e = err as { code?: 'path_outside_allowlist' | 'path_denied' };
          if (e.code === 'path_outside_allowlist' || e.code === 'path_denied') {
            sendError(send, e.code, (err as Error).message, msg.correlationId);
          } else {
            sendError(send, 'unsupported_message', (err as Error).message, msg.correlationId);
          }
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

function errorMessageFor(code: ServerErrorMsg['code']): string {
  switch (code) {
    case 'images_not_supported_for_agent':
      return 'Codex sessions do not accept images.';
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
