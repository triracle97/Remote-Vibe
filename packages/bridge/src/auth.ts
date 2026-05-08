import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function tokensMatch(a: string, b: string): boolean {
  // JS string length is in UTF-16 code units, but timingSafeEqual requires
  // equal byte lengths. Compare on Buffer length so a non-ASCII candidate
  // cannot throw RangeError. The string-length short-circuit is kept as a
  // cheap fast path; the buffer-length check is the authoritative gate.
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function parseCookie(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k.length > 0) out[k] = v;
  }
  return out;
}

export function buildSessionCookie(token: string): string {
  return `bridge_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`;
}

export function isOriginAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (!host) return false;
  return originUrl.host === host;
}

export function extractTokenFromRequest(req: IncomingMessage): string | undefined {
  if (req.url) {
    const parsed = new URL(req.url, 'http://placeholder');
    const q = parsed.searchParams.get('token');
    if (q) return q;
  }
  const cookies = parseCookie(req.headers.cookie);
  const fromCookie = cookies.bridge_session;
  return fromCookie ?? undefined;
}
