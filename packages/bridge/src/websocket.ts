import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
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

  wss.on('connection', (ws) => {
    const send = (m: ServerMsg) => {
      try {
        ws.send(JSON.stringify(m));
      } catch {
        /* ignore */
      }
    };
    const broadcast = (m: ServerMsg) => send(m);
    opts.sessionManager.on('broadcast', broadcast);
    ws.on('close', () => opts.sessionManager.off('broadcast', broadcast));

    send({ type: 'system', event: 'init' });

    ws.on('message', (raw) => {
      void handleMessage(ws, raw, opts.sessionManager, send, opts.accounts, opts.promptStore, opts.fsApi, opts.imageStore);
    });
  });

  return wss;
}

async function handleMessage(
  _ws: WebSocket,
  raw: import('ws').RawData,
  mgr: SessionManager,
  send: (m: ServerMsg) => void,
  accounts: Map<string, CodexAccount>,
  promptStore: PromptStore | undefined,
  fsApi: FsApi,
  imageStore: ImageStore,
): Promise<void> {
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
        await mgr.create({
          agent: msg.agent,
          projectPath: msg.projectPath,
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
