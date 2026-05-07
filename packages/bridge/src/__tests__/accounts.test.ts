import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCodexAccounts } from '../accounts.js';

describe('loadCodexAccounts', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mrt-accounts-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('synthesizes a default account when accounts.json is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'mrt-home-'));
    mkdirSync(join(home, '.codex'));
    const accounts = loadCodexAccounts({ dataDir, env: { HOME: home } });
    expect(accounts.size).toBe(1);
    const def = accounts.get('default')!;
    expect(def.codexHome).toBe(join(home, '.codex'));
    expect(def.isDefault).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it('synthesizes a default account from CODEX_HOME when set', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'mrt-codex-'));
    const accounts = loadCodexAccounts({ dataDir, env: { CODEX_HOME: codexHome, HOME: '/nope' } });
    expect(accounts.get('default')!.codexHome).toBe(codexHome);
    rmSync(codexHome, { recursive: true, force: true });
  });

  it('parses a valid accounts.json with multiple entries', () => {
    const work = mkdtempSync(join(tmpdir(), 'mrt-codex-work-'));
    const personal = mkdtempSync(join(tmpdir(), 'mrt-codex-personal-'));
    writeFileSync(
      join(dataDir, 'accounts.json'),
      JSON.stringify({
        codex_accounts: [
          { name: 'work', codexHome: work },
          { name: 'personal', codexHome: personal },
        ],
      }),
    );
    const accounts = loadCodexAccounts({ dataDir, env: {} });
    expect(accounts.size).toBe(2);
    expect(accounts.get('work')!.codexHome).toBe(work);
    expect(accounts.get('personal')!.codexHome).toBe(personal);
    expect(accounts.get('work')!.isDefault).toBe(false);
    rmSync(work, { recursive: true, force: true });
    rmSync(personal, { recursive: true, force: true });
  });

  it('drops accounts whose codexHome does not exist, falls back to default if all dropped', () => {
    const home = mkdtempSync(join(tmpdir(), 'mrt-home-'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(
      join(dataDir, 'accounts.json'),
      JSON.stringify({ codex_accounts: [{ name: 'broken', codexHome: '/no/such/path' }] }),
    );
    const accounts = loadCodexAccounts({ dataDir, env: { HOME: home } });
    expect(accounts.size).toBe(1);
    expect(accounts.has('default')).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it('falls back to default on malformed JSON', () => {
    const home = mkdtempSync(join(tmpdir(), 'mrt-home-'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(dataDir, 'accounts.json'), '{not json');
    const accounts = loadCodexAccounts({ dataDir, env: { HOME: home } });
    expect(accounts.size).toBe(1);
    expect(accounts.has('default')).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it('falls back to default on empty codex_accounts array', () => {
    const home = mkdtempSync(join(tmpdir(), 'mrt-home-'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify({ codex_accounts: [] }));
    const accounts = loadCodexAccounts({ dataDir, env: { HOME: home } });
    expect(accounts.size).toBe(1);
    expect(accounts.has('default')).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});
