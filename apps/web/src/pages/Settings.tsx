import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useConnectionStore } from '../store/connection';
import { useThemeStore, type ThemeMode } from '../shell/themeStore';
import { useDefaultWorkspacesStore } from '../features/project-picker/defaultWorkspacesStore';
import { ProfileEditor } from '../features/profiles/ProfileEditor';

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
    </div>
  );
}
