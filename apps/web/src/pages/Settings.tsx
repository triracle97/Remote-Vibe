import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useConnectionStore } from '../store/connection';
import { useThemeStore, type ThemeMode } from '../shell/themeStore';
import { useDefaultWorkspacesStore } from '../features/project-picker/defaultWorkspacesStore';
import { useAccountsStore } from '../store/accounts';
import { ProfileEditor } from '../features/profiles/ProfileEditor';
import { ShortcutList } from '../shell/CommandPalette';

const themes: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function Settings(): JSX.Element {
  const status = useConnectionStore((s) => s.status);
  const lastError = useConnectionStore((s) => s.lastError);
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  const workspaces = useDefaultWorkspacesStore((s) => s.paths);
  const addWorkspace = useDefaultWorkspacesStore((s) => s.add);
  const removeWorkspace = useDefaultWorkspacesStore((s) => s.remove);
  const accounts = useAccountsStore((s) => s.accounts);
  const claudeConfigs = useAccountsStore((s) => s.claudeConfigs);
  const saveClaudeConfig = useAccountsStore((s) => s.saveClaudeConfig);
  const deleteClaudeConfig = useAccountsStore((s) => s.deleteClaudeConfig);
  const [profileName, setProfileName] = useState('');
  const [profileDir, setProfileDir] = useState('');
  const [draft, setDraft] = useState('');
  const [profilesOpen, setProfilesOpen] = useState(false);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 max-w-screen-md w-full mx-auto space-y-8">
      <h1 className="text-[var(--color-text)] text-xl font-semibold">Settings</h1>

      <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
        <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3">Connection</h2>
        <div className="text-sm space-y-1">
          <div className="text-[var(--color-text)]">Status: {status}</div>
          {lastError && <div className="text-[var(--color-danger)]">{lastError}</div>}
        </div>
      </section>

      <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
        <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3">Appearance</h2>
        <fieldset>
          <legend className="sr-only">Theme</legend>
          <div className="flex gap-2">
            {themes.map((t) => (
              <label
                key={t.value}
                className={`flex-1 cursor-pointer text-center rounded-lg px-3 py-2 min-h-[44px] flex items-center justify-center text-sm transition-colors ${
                  mode === t.value
                    ? 'bg-[var(--color-accent)] text-white'
                    : 'bg-[var(--color-surface-2)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
                }`}
              >
                <input
                  type="radio"
                  name="theme"
                  value={t.value}
                  checked={mode === t.value}
                  onChange={() => setMode(t.value)}
                  className="sr-only"
                />
                {t.label}
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
        <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3">
          Claude profiles
        </h2>
        <p className="mt-0 mb-3 text-sm text-[var(--color-text-dim)]">
          Each profile is a <code className="font-mono">CLAUDE_CONFIG_DIR</code> — its own
          settings, plugins, slash commands, and session history. Add a second one and a
          picker appears in New Session. Existing sessions keep the profile they were
          created under, because that is where their history lives.
        </p>
        <ul className="list-none p-0 m-0 divide-y divide-[var(--color-border)]">
          {claudeConfigs.map((c) => (
            <li key={c.name} className="py-2 flex items-center gap-3">
              <span className="flex flex-col min-w-0 flex-1">
                <span className="text-sm text-[var(--color-text)]">
                  {c.name}
                  {c.isDefault && (
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--color-text-dim)]">
                      default
                    </span>
                  )}
                </span>
                <span className="text-xs font-mono text-[var(--color-text-dim)] truncate">
                  {c.configDir ?? 'set by the bridge environment'}
                </span>
              </span>
              {!c.isDefault && (
                <button
                  type="button"
                  onClick={() => deleteClaudeConfig(c.name)}
                  aria-label={`Remove profile ${c.name}`}
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-danger)] rounded"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!profileName.trim() || !profileDir.trim()) return;
            saveClaudeConfig(profileName.trim(), profileDir.trim());
            setProfileName('');
            setProfileDir('');
          }}
        >
          <input
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            placeholder="name"
            aria-label="Profile name"
            className="w-28 px-2 py-1.5 min-h-[40px] rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border)] text-sm text-[var(--color-text)] outline-none"
          />
          <input
            value={profileDir}
            onChange={(e) => setProfileDir(e.target.value)}
            placeholder="~/.claude"
            aria-label="Profile config dir"
            className="flex-1 min-w-[12rem] px-2 py-1.5 min-h-[40px] rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border)] text-sm font-mono text-[var(--color-text)] outline-none"
          />
          <button
            type="submit"
            className="px-3 py-1.5 min-h-[40px] flex items-center gap-1 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
          >
            <Plus size={14} />
            Add
          </button>
        </form>
        <p className="mt-2 mb-0 text-[11px] text-[var(--color-text-dim)] leading-snug">
          Naming a profile <code className="font-mono">default</code> repoints the default
          one — the only way to change it without editing{' '}
          <code className="font-mono">BRIDGE_CLAUDE_CONFIG_DIR</code>. Paths with spaces are
          rejected: the directory is passed on the CLI's command line.
        </p>
      </section>

      <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
        <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3">
          Keyboard shortcuts
        </h2>
        <p className="mt-0 mb-3 text-sm text-[var(--color-text-dim)]">
          Press <kbd className="px-1 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[11px] font-mono text-[var(--color-text)]">?</kbd>{' '}
          anywhere outside a text box to bring this up without leaving what you
          are doing.
        </p>
        <ShortcutList />
      </section>

      <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
        <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3">Default agent</h2>
        <p className="text-[var(--color-text-dim)] text-sm">Default agent selection is applied when starting a new session via Home or Projects. (Persisted per-session inside ProjectPicker for v1.)</p>
      </section>

      <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
        <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3">Default workspaces</h2>
        <div className="flex gap-2 mb-3">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="/Volumes/.../my-project"
            className="flex-1 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
          />
          <button
            type="button"
            onClick={() => {
              const v = draft.trim();
              if (!v) return;
              addWorkspace(v);
              setDraft('');
            }}
            aria-label="Add default workspace"
            className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90"
          >
            <Plus size={18} />
          </button>
        </div>
        {workspaces.length === 0 ? (
          <div className="text-sm text-[var(--color-text-dim)]">No default workspaces.</div>
        ) : (
          <ul className="list-none p-0 m-0 divide-y divide-[var(--color-border)]">
            {workspaces.map((p) => (
              <li key={p} className="flex items-center justify-between py-2">
                <span className="text-[var(--color-text)] text-sm font-mono truncate min-w-0">{p}</span>
                <button
                  type="button"
                  onClick={() => removeWorkspace(p)}
                  aria-label={`Remove ${p}`}
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-danger)]"
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
        <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3">Profiles</h2>
        <p className="text-[var(--color-text-dim)] text-sm mb-3">Saved combinations of agent + working directories. Use them to start sessions faster.</p>
        <button
          type="button"
          onClick={() => setProfilesOpen(true)}
          className="bg-[var(--color-accent)] text-white rounded-lg px-3 py-2 min-h-[44px] hover:opacity-90"
        >
          Manage profiles
        </button>
        <ProfileEditor open={profilesOpen} onClose={() => setProfilesOpen(false)} />
      </section>

      <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
        <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3">Accounts</h2>
        {accounts.length === 0 ? (
          <div className="text-sm text-[var(--color-text-dim)]">No accounts.</div>
        ) : (
          <ul className="list-none p-0 m-0 divide-y divide-[var(--color-border)]">
            {accounts.map((a) => (
              <li key={a.name} className="py-2 flex items-center justify-between">
                <span className="text-[var(--color-text)] text-sm">{a.name}</span>
                <span className="text-[var(--color-text-dim)] text-xs flex items-center gap-2">
                  {a.agent}
                  {a.isDefault && <span className="text-[var(--color-accent)]">(default)</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
