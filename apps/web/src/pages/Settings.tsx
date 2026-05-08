import { useConnectionStore } from '../store/connection';
import { useThemeStore, type ThemeMode } from '../shell/themeStore';

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
    </div>
  );
}
