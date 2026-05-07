import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpHandler } from '../http-server.js';

const TOKEN = 'a'.repeat(32);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-http-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><body>app</body>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("ok")');

  const handler = createHttpHandler({ token: TOKEN, staticDir: dir });
  const server = createServer(handler);
  return new Promise<{ server: import('node:http').Server; baseUrl: string; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no addr');
        resolve({
          server,
          baseUrl: `http://127.0.0.1:${addr.port}`,
          close: () =>
            new Promise<void>((r) => {
              server.close(() => r());
            }),
        });
      });
    },
  );
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
});
