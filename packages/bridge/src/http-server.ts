import { createReadStream } from 'node:fs';
import { stat, realpath as fsRealpath } from 'node:fs/promises';
import { join, normalize, sep, resolve } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tokensMatch, parseCookie, buildSessionCookie, isOriginAllowed, extractTokenFromRequest } from './auth.js';

export interface HttpHandlerOpts {
  token: string;
  staticDir: string;
  dataDir: string;
  /**
   * Handles POSTs to `/mcp`. Absent in tests and whenever agent-to-agent
   * spawning is not wired, in which case the route 404s like any other.
   */
  mcp?: (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>;
}

const MCP_PATH = '/mcp';
/** Plenty for a JSON-RPC tool call; stops a stuck client buffering forever. */
const MCP_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Read a request body with a hard cap, resolving null once the cap is passed.
 *
 * Written with listeners rather than `for await`, because bailing out of an
 * async iterator leaves the request unconsumed: the client keeps sending, the
 * server never drains, and the response never flushes — the request just hangs
 * instead of failing. Here the overflow case stops buffering immediately and
 * lets the caller decide how to close things down.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let overflowed = false;
    req.on('data', (chunk: Buffer) => {
      if (overflowed) return; // still draining; discard
      total += chunk.length;
      if (total > limit) {
        // Stop buffering — that is the memory protection — but keep reading to
        // the end so the 413 can be delivered on a healthy connection. Killing
        // the socket here instead would surface to the agent as an opaque
        // transport failure rather than a status it can act on, and the body is
        // bounded by a local process that already holds the token.
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () =>
      finish(overflowed ? null : Buffer.concat(chunks).toString('utf8')),
    );
    req.on('error', () => finish(null));
    req.on('aborted', () => finish(null));
  });
}

/** `Authorization: Bearer <token>`, the scheme MCP clients send. */
function bearerToken(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; " +
    "script-src 'self'; " +
    // Monaco runs its language services in web workers. Vite emits them as
    // same-origin bundles, but its fallback path wraps them in a blob: URL,
    // and without this the editor loads with dead completions and a console
    // full of CSP violations.
    "worker-src 'self' blob:; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self' ws: wss:; " +
    "frame-ancestors 'none'",
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
    const parsed = new URL(req.url ?? '/', 'http://placeholder');

    // MCP is handled before the GET-only and cookie gates below: it is a POST
    // API for agent processes, not the browser, so it authenticates with a
    // Bearer header instead of the session cookie and has no Origin to check.
    if (parsed.pathname === MCP_PATH) {
      if (!opts.mcp) {
        send(res, 404, 'Not found');
        return;
      }
      if (req.method !== 'POST') {
        // GET on /mcp is the SSE notification stream, which this server does
        // not offer — it is stateless and never pushes.
        send(res, 405, 'Method Not Allowed');
        return;
      }
      const presented = bearerToken(req);
      if (!presented || !tokensMatch(presented, opts.token)) {
        send(res, 401, 'Invalid token');
        return;
      }
      const raw = await readBody(req, MCP_MAX_BODY_BYTES);
      if (raw === null) {
        send(res, 413, 'Payload too large');
        return;
      }
      let body: unknown;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        send(res, 400, 'Malformed JSON');
        return;
      }
      applySecurity(res);
      await opts.mcp(req, res, body);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method Not Allowed');
      return;
    }

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

    if (parsed.pathname.startsWith('/transcripts/')) {
      const segment = parsed.pathname.slice('/transcripts/'.length);
      if (!UUID_RE.test(segment)) {
        send(res, 400, 'Invalid session id');
        return;
      }
      const transcriptsRoot = join(opts.dataDir, 'transcripts');
      const candidate = join(transcriptsRoot, `${segment}.jsonl`);
      let resolvedRoot: string;
      let resolvedFile: string;
      try {
        resolvedRoot = await fsRealpath(transcriptsRoot);
        resolvedFile = await fsRealpath(candidate);
      } catch {
        send(res, 404, 'Not found');
        return;
      }
      if (!resolvedFile.startsWith(resolvedRoot + sep)) {
        send(res, 404, 'Not found');
        return;
      }
      let st;
      try {
        st = await stat(resolvedFile);
      } catch {
        send(res, 404, 'Not found');
        return;
      }
      if (!st.isFile()) {
        send(res, 404, 'Not found');
        return;
      }
      applySecurity(res);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Length', String(st.size));
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(resolvedFile).pipe(res);
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
    // Same URL, different bytes depending on Accept-Encoding.
    res.setHeader('Vary', 'Accept-Encoding');

    const gzip = shouldGzip(req, ext, st.size);
    if (gzip) {
      res.setHeader('Content-Encoding', 'gzip');
    } else {
      res.setHeader('Content-Length', String(st.size));
    }

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    if (!gzip) {
      createReadStream(filePath).pipe(res);
      return;
    }
    // `pipeline` rather than chained `.pipe`, so a client that disconnects
    // mid-transfer tears the gzip stream down instead of leaking it.
    pipeline(createReadStream(filePath), createGzip(), res, (err) => {
      if (err) res.destroy();
    });
  };
}

/** Text-ish assets worth compressing. Images and fonts are already compressed. */
const COMPRESSIBLE_EXTS: ReadonlySet<string> = new Set([
  '.html',
  '.js',
  '.css',
  '.json',
  '.svg',
]);

/** Below this, the gzip round-trip costs more than the bytes it saves. */
const GZIP_MIN_BYTES = 1024;

/**
 * Whether to gzip this response.
 *
 * Worth having at all because the bridge serves the built SPA itself, and that
 * bundle is measured in megabytes — the Monaco chunk alone is ~3.8 MB raw and
 * its TypeScript worker ~6.7 MB. Over a phone's link those are the difference
 * between the editor opening and the editor appearing to hang.
 */
function shouldGzip(req: IncomingMessage, ext: string, size: number): boolean {
  if (!COMPRESSIBLE_EXTS.has(ext)) return false;
  if (size < GZIP_MIN_BYTES) return false;
  const accept = req.headers['accept-encoding'];
  const header = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  return /\bgzip\b/i.test(header);
}
