import { describe, it, expect } from 'vitest';
import { loadEnv } from '../env.js';

describe('loadEnv', () => {
  it('returns config when BRIDGE_TOKEN is at least 24 chars', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      BRIDGE_PORT: '8765',
      BRIDGE_ALLOWED_DIRS: '/Users/test/code',
    });
    expect(cfg.token).toBe('a'.repeat(24));
    expect(cfg.port).toBe(8765);
    expect(cfg.allowedDirs).toEqual(['/Users/test/code']);
    expect(cfg.bindHost).toBeUndefined();
  });

  it('throws when BRIDGE_TOKEN is missing', () => {
    expect(() => loadEnv({})).toThrow(/BRIDGE_TOKEN/);
  });

  it('throws when BRIDGE_TOKEN is shorter than 24 chars', () => {
    expect(() => loadEnv({ BRIDGE_TOKEN: 'short' })).toThrow(/24/);
  });

  it('defaults port to 8765', () => {
    const cfg = loadEnv({ BRIDGE_TOKEN: 'a'.repeat(24) });
    expect(cfg.port).toBe(8765);
  });

  it('defaults allowedDirs to $HOME', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      HOME: '/Users/test',
    });
    expect(cfg.allowedDirs).toEqual(['/Users/test']);
  });

  it('parses comma-separated allowedDirs', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      BRIDGE_ALLOWED_DIRS: '/a,/b,/c',
    });
    expect(cfg.allowedDirs).toEqual(['/a', '/b', '/c']);
  });

  it('passes through BRIDGE_BIND_HOST override', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      BRIDGE_BIND_HOST: '127.0.0.1',
    });
    expect(cfg.bindHost).toBe('127.0.0.1');
  });
});
