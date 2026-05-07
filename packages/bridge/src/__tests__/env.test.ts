import { describe, it, expect } from 'vitest';
import { loadEnv } from '../env.js';

describe('loadEnv', () => {
  it('returns config when BRIDGE_TOKEN is at least 24 chars', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      BRIDGE_PORT: '8765',
      BRIDGE_ALLOWED_DIRS: '/Users/test/code',
      HOME: '/Users/test',
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
    const cfg = loadEnv({ BRIDGE_TOKEN: 'a'.repeat(24), HOME: '/Users/test' });
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
      HOME: '/Users/test',
    });
    expect(cfg.allowedDirs).toEqual(['/a', '/b', '/c']);
  });

  it('passes through BRIDGE_BIND_HOST override', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      BRIDGE_BIND_HOST: '127.0.0.1',
      HOME: '/Users/test',
    });
    expect(cfg.bindHost).toBe('127.0.0.1');
  });

  it('throws when neither BRIDGE_ALLOWED_DIRS nor HOME is set', () => {
    expect(() => loadEnv({ BRIDGE_TOKEN: 'a'.repeat(24) })).toThrow(/BRIDGE_ALLOWED_DIRS or HOME/);
  });

  it('defaults dataDir to $HOME/.config/mac-remote-terminal', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      HOME: '/Users/test',
    });
    expect(cfg.dataDir).toBe('/Users/test/.config/mac-remote-terminal');
  });

  it('allows BRIDGE_DATA_DIR to override the default', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      BRIDGE_DATA_DIR: '/var/mrt',
      HOME: '/Users/test',
    });
    expect(cfg.dataDir).toBe('/var/mrt');
  });

  it('defaults transcriptRetentionDays to 30', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      HOME: '/Users/test',
    });
    expect(cfg.transcriptRetentionDays).toBe(30);
  });

  it('parses BRIDGE_TRANSCRIPT_RETENTION_DAYS as integer', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      HOME: '/Users/test',
      BRIDGE_TRANSCRIPT_RETENTION_DAYS: '7',
    });
    expect(cfg.transcriptRetentionDays).toBe(7);
  });

  it('treats BRIDGE_TRANSCRIPT_RETENTION_DAYS=0 as disabled', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      HOME: '/Users/test',
      BRIDGE_TRANSCRIPT_RETENTION_DAYS: '0',
    });
    expect(cfg.transcriptRetentionDays).toBe(0);
  });

  it('throws on negative or non-integer BRIDGE_TRANSCRIPT_RETENTION_DAYS', () => {
    expect(() =>
      loadEnv({
        BRIDGE_TOKEN: 'a'.repeat(24),
        HOME: '/Users/test',
        BRIDGE_TRANSCRIPT_RETENTION_DAYS: '-1',
      }),
    ).toThrow(/non-negative/);
    expect(() =>
      loadEnv({
        BRIDGE_TOKEN: 'a'.repeat(24),
        HOME: '/Users/test',
        BRIDGE_TRANSCRIPT_RETENTION_DAYS: 'abc',
      }),
    ).toThrow(/non-negative/);
  });
});
