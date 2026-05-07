import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, sep, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tokensMatch, parseCookie, buildSessionCookie, isOriginAllowed, extractTokenFromRequest } from './auth.js';

export interface HttpHandlerOpts {
  token: string;
  staticDir: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:",
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function applySecurity(res: ServerResponse): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

function send(res: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  applySecurity(res);
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.end(body);
}

function safeResolveStaticPath(staticDir: string, urlPath: string): string | null {
  const root = resolve(staticDir);
  const target = normalize(join(root, urlPath));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

export function createHttpHandler(opts: HttpHandlerOpts) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method Not Allowed');
      return;
    }

    const parsed = new URL(req.url ?? '/', 'http://placeholder');
    const queryToken = parsed.searchParams.get('token');

    if (queryToken) {
      if (!tokensMatch(queryToken, opts.token)) {
        send(res, 401, 'Invalid token');
        return;
      }
      applySecurity(res);
      res.statusCode = 302;
      res.setHeader('Location', parsed.pathname || '/');
      res.setHeader('Set-Cookie', buildSessionCookie(opts.token));
      res.end();
      return;
    }

    const cookies = parseCookie(req.headers.cookie);
    const cookieToken = cookies.bridge_session;
    if (!cookieToken) {
      send(res, 401, 'Token required. Append ?token=<TOKEN> to the URL.');
      return;
    }
    if (!tokensMatch(cookieToken, opts.token)) {
      send(res, 401, 'Invalid token');
      return;
    }

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isOriginAllowed(origin, host)) {
      send(res, 403, 'Origin mismatch');
      return;
    }

    const urlPath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
    let filePath = safeResolveStaticPath(opts.staticDir, urlPath);
    if (!filePath) {
      send(res, 400, 'Bad path');
      return;
    }

    let st;
    try {
      st = await stat(filePath);
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      // SPA history-mode fallback: any non-asset path falls back to
      // index.html so React Router can handle routes like /session/<id>
      // after a reload.
      const looksLikeAsset = /\.[a-z0-9]{1,5}$/i.test(parsed.pathname);
      if (looksLikeAsset) {
        send(res, 404, 'Not found');
        return;
      }
      const fallbackPath = safeResolveStaticPath(opts.staticDir, '/index.html');
      if (!fallbackPath) {
        send(res, 404, 'Not found');
        return;
      }
      try {
        st = await stat(fallbackPath);
      } catch {
        send(res, 404, 'Not found');
        return;
      }
      filePath = fallbackPath;
    }

    const ext = filePath.slice(filePath.lastIndexOf('.'));
    const ct = MIME[ext] ?? 'application/octet-stream';

    applySecurity(res);
    res.statusCode = 200;
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Length', String(st.size));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  };
}
