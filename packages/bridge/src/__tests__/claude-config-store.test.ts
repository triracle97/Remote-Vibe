import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeConfigStore } from '../claude-config-store.js';
import type { ClaudeConfigProfile } from '../accounts.js';

describe('ClaudeConfigStore', () => {
  let dataDir: string;
  let profiles: Map<string, ClaudeConfigProfile>;
  let store: ClaudeConfigStore;

  const accountsPath = (): string => join(dataDir, 'accounts.json');
  const readFile = (): Record<string, unknown> =>
    JSON.parse(readFileSync(accountsPath(), 'utf8')) as Record<string, unknown>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mrt-ccfg-'));
    profiles = new Map([
      [
        'default',
        { name: 'default', configDir: '/Users/me/.claude', isDefault: true, inheritEnv: true },
      ],
    ]);
    store = new ClaudeConfigStore({ dataDir, profiles, home: '/Users/me' });
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('adds a profile to the live map the rest of the bridge holds', async () => {
    // Mutating in place, not replacing: SessionManager captured this exact Map
    // at construction, so a fresh one would leave it reading a stale copy.
    await store.save('alt', '/Users/me/.claude1');

    expect(profiles.get('alt')).toEqual({
      name: 'alt',
      configDir: '/Users/me/.claude1',
      isDefault: false,
      inheritEnv: false,
    });
    expect(readFile().claude_config_dirs).toEqual([
      { name: 'alt', configDir: '/Users/me/.claude1' },
    ]);
  });

  it('expands a leading ~', async () => {
    await store.save('alt', '~/.claude1');
    expect(profiles.get('alt')!.configDir).toBe('/Users/me/.claude1');
  });

  it('repoints an existing profile rather than duplicating it', async () => {
    await store.save('alt', '/Users/me/.claude1');
    await store.save('alt', '/Users/me/.claude2');
    expect(profiles.get('alt')!.configDir).toBe('/Users/me/.claude2');
    expect(readFile().claude_config_dirs).toHaveLength(1);
  });

  it('leaves the synthesized default out of the file until it is pinned', async () => {
    // Writing it would freeze today's environment-derived value into the file
    // and silently override BRIDGE_CLAUDE_CONFIG_DIR on the next boot.
    await store.save('alt', '/Users/me/.claude1');
    const names = (readFile().claude_config_dirs as Array<{ name: string }>).map((e) => e.name);
    expect(names).toEqual(['alt']);
  });

  it('persists the default once it is pointed somewhere explicitly', async () => {
    await store.save('default', '/Users/me/.claude9');
    const entries = readFile().claude_config_dirs as Array<{ name: string; configDir: string }>;
    expect(entries).toContainEqual({ name: 'default', configDir: '/Users/me/.claude9' });
    expect(profiles.get('default')!.isDefault).toBe(true);
    // Pinned on purpose, so spawns export it instead of inheriting whatever
    // CLAUDE_CONFIG_DIR the bridge happens to have.
    expect(profiles.get('default')!.inheritEnv).toBe(false);
  });

  it('preserves the Codex accounts sharing the file', async () => {
    writeFileSync(
      accountsPath(),
      JSON.stringify({ accounts: [{ name: 'work', codexHome: '/Users/me/.codex-work' }] }),
    );
    const fresh = new ClaudeConfigStore({ dataDir, profiles, home: '/Users/me' });
    await fresh.save('alt', '/Users/me/.claude1');

    // Editing a Claude profile from the UI must not drop somebody's Codex setup.
    expect(readFile().accounts).toEqual([{ name: 'work', codexHome: '/Users/me/.codex-work' }]);
  });

  it('rejects a relative path', async () => {
    await expect(store.save('alt', '.claude1')).rejects.toMatchObject({
      code: 'claude_config_invalid',
    });
    expect(profiles.has('alt')).toBe(false);
  });

  it('rejects a path the spawn path could not carry', async () => {
    // The dir lands on a `zsh -lic` command line, so this would otherwise fail
    // later as an opaque "unsafe resume arg token" when a session spawns.
    await expect(store.save('alt', '/Users/me/my claude')).rejects.toMatchObject({
      code: 'claude_config_invalid',
    });
    await expect(store.save('alt', '/Users/me/$(whoami)')).rejects.toMatchObject({
      code: 'claude_config_invalid',
    });
  });

  it('rejects an unusable name', async () => {
    await expect(store.save('', '/Users/me/.claude1')).rejects.toMatchObject({
      code: 'claude_config_invalid',
    });
    await expect(store.save('a b', '/Users/me/.claude1')).rejects.toMatchObject({
      code: 'claude_config_invalid',
    });
  });

  it('removes a named profile', async () => {
    await store.save('alt', '/Users/me/.claude1');
    await store.remove('alt');
    expect(profiles.has('alt')).toBe(false);
    expect(readFile().claude_config_dirs).toEqual([]);
  });

  it('refuses to remove the default', async () => {
    // There would be nothing for the picker to fall back to.
    await expect(store.remove('default')).rejects.toMatchObject({
      code: 'claude_config_invalid',
    });
    expect(profiles.has('default')).toBe(true);
  });

  it('reports an unknown profile rather than silently succeeding', async () => {
    await expect(store.remove('nope')).rejects.toMatchObject({
      code: 'claude_config_not_found',
    });
  });

  it('survives a malformed accounts.json', async () => {
    writeFileSync(accountsPath(), '{ not json');
    const fresh = new ClaudeConfigStore({ dataDir, profiles, home: '/Users/me' });
    await fresh.save('alt', '/Users/me/.claude1');
    expect(existsSync(accountsPath())).toBe(true);
    expect(readFile().claude_config_dirs).toEqual([
      { name: 'alt', configDir: '/Users/me/.claude1' },
    ]);
  });
});
