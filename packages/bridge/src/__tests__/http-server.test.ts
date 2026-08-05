import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpHandler, type HttpHandlerOpts } from '../http-server.js';

const TOKEN = 'a'.repeat(32);

function setup(opts: { dataDir?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-http-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><body>app</body>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("ok")');
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'bridge-data-'));
  mkdirSync(join(dataDir, 'transcripts'), { recursive: true });

  const handler = createHttpHandler({ token: TOKEN, staticDir: dir, dataDir });
  const server = createServer(handler);
  return new Promise<{
    server: import('node:http').Server;
    baseUrl: string;
    dataDir: string;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no addr');
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        dataDir,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe('http-server', () => {
  it('redirects /?token=<valid> to / with bridge_session cookie', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/?token=${TOKEN}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const sc = res.headers.get('set-cookie') ?? '';
    expect(sc).toContain(`bridge_session=${TOKEN}`);
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Strict');
    await close();
  });

  it('returns 401 with hint when no cookie and no token query', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toMatch(/Token required/);
    await close();
  });

  it('returns 401 for invalid token query', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/?token=wrong`, { redirect: 'manual' });
    expect(res.status).toBe(401);
    await close();
  });

  it('serves index.html when cookie is valid', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<body>app</body>');
    await close();
  });

  it('serves nested assets when cookie is valid', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/assets/app.js`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log("ok")');
    await close();
  });

  it('rejects cookie-authed request when Origin does not match Host', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/`, {
      headers: { cookie: `bridge_session=${TOKEN}`, origin: 'http://evil.com' },
    });
    expect(res.status).toBe(403);
    await close();
  });

  it('attaches security headers to authed responses', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    await close();
  });

  it('falls back to index.html for unknown SPA routes', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/session/abc-123`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<body>app</body>');
    await close();
  });

  it('returns 404 for missing asset-shaped paths instead of falling back', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/missing.png`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    expect(res.status).toBe(404);
    await close();
  });

  it('rejects path traversal attempts', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/../../etc/passwd`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    // Path traversal is prevented by URL normalization and safeResolveStaticPath.
    // /../../etc/passwd gets normalized to /etc/passwd by the URL parser,
    // then safeResolveStaticPath returns <staticDir>/etc/passwd (inside staticDir).
    // Since the file doesn't exist and doesn't look like an asset, it falls back to index.html.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<body>app</body>');
    await close();
  });

  it('GET /transcripts/<id> returns 200 application/x-ndjson with file contents', async () => {
    const { baseUrl, dataDir, close } = await setup();
    const id = '11111111-1111-1111-1111-111111111111';
    const transcript =
      JSON.stringify({ type: 'system', event: 'session_created', sessionId: id, seq: 1 }) +
      '\n' +
      JSON.stringify({ type: 'user', sessionId: id, seq: 2, payload: { text: 'hi' } }) +
      '\n';
    writeFileSync(join(dataDir, 'transcripts', `${id}.jsonl`), transcript);

    const res = await fetch(`${baseUrl}/transcripts/${id}`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(transcript);
    await close();
  });

  it('GET /transcripts/<id> returns 404 when file is missing', async () => {
    const { baseUrl, close } = await setup();
    const id = '22222222-2222-2222-2222-222222222222';
    const res = await fetch(`${baseUrl}/transcripts/${id}`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    expect(res.status).toBe(404);
    await close();
  });

  it('GET /transcripts/<id> returns 400 when sessionId is not a UUID', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/transcripts/not-a-uuid`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    expect(res.status).toBe(400);
    await close();
  });

  it('GET /transcripts/<id> requires auth', async () => {
    const { baseUrl, close } = await setup();
    const id = '33333333-3333-3333-3333-333333333333';
    const res = await fetch(`${baseUrl}/transcripts/${id}`);
    expect(res.status).toBe(401);
    await close();
  });

  it('GET /transcripts/<id> rejects mismatched Origin', async () => {
    const { baseUrl, close } = await setup();
    const id = '44444444-4444-4444-4444-444444444444';
    const res = await fetch(`${baseUrl}/transcripts/${id}`, {
      headers: {
        cookie: `bridge_session=${TOKEN}`,
        origin: 'http://evil.com',
      },
    });
    expect(res.status).toBe(403);
    await close();
  });

  it('CSP includes connect-src with self + ws/wss, frame-ancestors none, img-src data/blob', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("connect-src 'self' ws: wss:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("img-src 'self' data: blob:");
    await close();
  });

  it('Permissions-Policy locks down camera/microphone/geolocation/payment/usb', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    const pp = res.headers.get('permissions-policy') ?? '';
    expect(pp).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    await close();
  });
});

describe('http-server static compression', () => {
  /** A JS asset comfortably over the gzip threshold, and very compressible. */
  function setupWithBigAsset() {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-http-gz-'));
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><body>app</body>');
    writeFileSync(join(dir, 'assets', 'big.js'), 'console.log("x");\n'.repeat(2000));
    writeFileSync(join(dir, 'assets', 'tiny.js'), 'x');
    writeFileSync(join(dir, 'assets', 'logo.png'), Buffer.alloc(4096, 7));
    const dataDir = mkdtempSync(join(tmpdir(), 'bridge-data-gz-'));
    mkdirSync(join(dataDir, 'transcripts'), { recursive: true });
    const server = createServer(createHttpHandler({ token: TOKEN, staticDir: dir, dataDir }));
    return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no addr');
        resolve({
          baseUrl: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    });
  }

  it('gzips a large JS asset and still delivers the original bytes', async () => {
    const { baseUrl, close } = await setupWithBigAsset();
    const res = await fetch(`${baseUrl}/assets/big.js`, {
      headers: { cookie: `bridge_session=${TOKEN}`, 'accept-encoding': 'gzip' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('vary')).toBe('Accept-Encoding');
    // undici transparently decodes, so this is the round-trip check.
    expect(await res.text()).toBe('console.log("x");\n'.repeat(2000));
    await close();
  });

  it('serves plain bytes when the client does not accept gzip', async () => {
    const { baseUrl, close } = await setupWithBigAsset();
    const res = await fetch(`${baseUrl}/assets/big.js`, {
      headers: { cookie: `bridge_session=${TOKEN}`, 'accept-encoding': 'identity' },
    });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBe(String('console.log("x");\n'.repeat(2000).length));
    await close();
  });

  it('leaves tiny files and already-compressed formats alone', async () => {
    const { baseUrl, close } = await setupWithBigAsset();
    const tiny = await fetch(`${baseUrl}/assets/tiny.js`, {
      headers: { cookie: `bridge_session=${TOKEN}`, 'accept-encoding': 'gzip' },
    });
    expect(tiny.headers.get('content-encoding')).toBeNull();

    const png = await fetch(`${baseUrl}/assets/logo.png`, {
      headers: { cookie: `bridge_session=${TOKEN}`, 'accept-encoding': 'gzip' },
    });
    expect(png.headers.get('content-encoding')).toBeNull();
    await close();
  });

  it('never sends a Content-Length that contradicts a gzipped body', async () => {
    const { baseUrl, close } = await setupWithBigAsset();
    const res = await fetch(`${baseUrl}/assets/big.js`, {
      headers: { cookie: `bridge_session=${TOKEN}`, 'accept-encoding': 'gzip' },
    });
    expect(res.headers.get('content-length')).toBeNull();
    await close();
  });

  it('allows Monaco workers in the CSP', async () => {
    const { baseUrl, close } = await setupWithBigAsset();
    const res = await fetch(`${baseUrl}/assets/big.js`, {
      headers: { cookie: `bridge_session=${TOKEN}`, 'accept-encoding': 'gzip' },
    });
    expect(res.headers.get('content-security-policy')).toContain("worker-src 'self' blob:");
    await close();
  });
});

describe('http-server /mcp route', () => {
  function setupMcp(mcp?: HttpHandlerOpts['mcp']) {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-mcp-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><body>app</body>');
    const dataDir = mkdtempSync(join(tmpdir(), 'bridge-mcp-data-'));
    mkdirSync(join(dataDir, 'transcripts'), { recursive: true });
    const server = createServer(
      createHttpHandler({ token: TOKEN, staticDir: dir, dataDir, ...(mcp ? { mcp } : {}) }),
    );
    return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no addr');
        resolve({
          baseUrl: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    });
  }

  const echo: HttpHandlerOpts['mcp'] = async (req, res, body) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ session: req.headers['x-mrt-session'] ?? null, body }));
  };

  it('404s when no MCP handler is wired', async () => {
    const { baseUrl, close } = await setupMcp();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: '{}',
    });
    expect(res.status).toBe(404);
    await close();
  });

  it('authenticates with a Bearer header, not the session cookie', async () => {
    const { baseUrl, close } = await setupMcp(echo);
    // Agents are not browsers: they have no cookie jar and send no Origin.
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mrt-session': 'web-1' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session: 'web-1', body: { hello: 'world' } });
    await close();
  });

  it('rejects a missing or wrong Bearer token', async () => {
    const { baseUrl, close } = await setupMcp(echo);
    const noAuth = await fetch(`${baseUrl}/mcp`, { method: 'POST', body: '{}' });
    expect(noAuth.status).toBe(401);

    const wrong = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'b'.repeat(32)}` },
      body: '{}',
    });
    expect(wrong.status).toBe(401);
    await close();
  });

  it('does not accept the cookie that works for the rest of the app', async () => {
    const { baseUrl, close } = await setupMcp(echo);
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { cookie: `bridge_session=${TOKEN}` },
      body: '{}',
    });
    expect(res.status).toBe(401);
    await close();
  });

  it('rejects non-POST', async () => {
    const { baseUrl, close } = await setupMcp(echo);
    const res = await fetch(`${baseUrl}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
    await close();
  });

  it('rejects malformed JSON before the handler sees it', async () => {
    let called = false;
    const { baseUrl, close } = await setupMcp(async (_req, res) => {
      called = true;
      res.end();
    });
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: '{ not json',
    });
    expect(res.status).toBe(400);
    expect(called).toBe(false);
    await close();
  });

  it('caps the request body', async () => {
    const { baseUrl, close } = await setupMcp(echo);
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
    await close();
  });
});
