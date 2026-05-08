import { describe, it, expect } from 'vitest';
import {
  tokensMatch,
  parseCookie,
  buildSessionCookie,
  isOriginAllowed,
  extractTokenFromRequest,
} from '../auth.js';
import type { IncomingMessage } from 'node:http';

const T = 'a'.repeat(32);

function fakeReq(headers: Record<string, string>, url = '/'): IncomingMessage {
  return { headers, url } as unknown as IncomingMessage;
}

describe('tokensMatch', () => {
  it('returns true for equal tokens', () => {
    expect(tokensMatch('abc123', 'abc123')).toBe(true);
  });
  it('returns false for different tokens', () => {
    expect(tokensMatch('abc123', 'abc124')).toBe(false);
  });
  it('returns false for different-length tokens', () => {
    expect(tokensMatch('abc', 'abcd')).toBe(false);
  });
  it('returns false (does not throw) when buffer byte-lengths differ despite equal string-length', () => {
    // 'aa' is 2 bytes in UTF-8; '€€' is 6 bytes (each U+20AC encodes to 3 bytes)
    // but both are length 2 in UTF-16 code units.
    expect(() => tokensMatch('aa', '€€')).not.toThrow();
    expect(tokensMatch('aa', '€€')).toBe(false);
  });
});

describe('parseCookie', () => {
  it('returns empty record for undefined header', () => {
    expect(parseCookie(undefined)).toEqual({});
  });
  it('parses a single cookie', () => {
    expect(parseCookie('bridge_session=abc')).toEqual({ bridge_session: 'abc' });
  });
  it('parses multiple cookies', () => {
    expect(parseCookie('a=1; b=2; c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });
  it('ignores malformed entries', () => {
    expect(parseCookie('a=1; broken; b=2')).toEqual({ a: '1', b: '2' });
  });
});

describe('buildSessionCookie', () => {
  it('returns persistent cookie with HttpOnly, SameSite=Strict, Path=/', () => {
    const c = buildSessionCookie(T);
    expect(c).toContain(`bridge_session=${T}`);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Path=/');
    expect(c).toContain('Max-Age=2592000');
    expect(c).not.toContain('Secure');
  });
});

describe('isOriginAllowed', () => {
  it('returns true when Origin is missing', () => {
    expect(isOriginAllowed(undefined, '100.64.1.5:8765')).toBe(true);
  });
  it('returns true when Origin host matches Host', () => {
    expect(isOriginAllowed('http://100.64.1.5:8765', '100.64.1.5:8765')).toBe(true);
  });
  it('returns false when Origin host differs', () => {
    expect(isOriginAllowed('http://evil.com', '100.64.1.5:8765')).toBe(false);
  });
  it('returns false when Origin is malformed', () => {
    expect(isOriginAllowed('not-a-url', '100.64.1.5:8765')).toBe(false);
  });
});

describe('extractTokenFromRequest', () => {
  it('returns query token when present', () => {
    const req = fakeReq({}, '/?token=' + T);
    expect(extractTokenFromRequest(req)).toBe(T);
  });
  it('returns cookie token when present and no query', () => {
    const req = fakeReq({ cookie: `bridge_session=${T}` });
    expect(extractTokenFromRequest(req)).toBe(T);
  });
  it('prefers query over cookie', () => {
    const req = fakeReq({ cookie: 'bridge_session=cookie-tok' }, '/?token=query-tok');
    expect(extractTokenFromRequest(req)).toBe('query-tok');
  });
  it('returns undefined when neither is present', () => {
    const req = fakeReq({});
    expect(extractTokenFromRequest(req)).toBeUndefined();
  });
});
