import { useEffect } from 'react';
import { useProfileStore } from './profileStore';
import type { Profile } from '../../types/protocol';

interface ProfilePickerProps {
  agent: 'claude' | 'codex';
  onSelect: (profile: Profile) => void;
  onManage?: () => void;
}

/**
 * Native <select> dropdown for choosing a saved profile of `agent`.
 * Native control = best mobile UX (OS picker).
 * Renders nothing if no profiles for `agent` exist (and the optional Manage link).
 */
export function ProfilePicker({ agent, onSelect, onManage }: ProfilePickerProps): JSX.Element {
  const profiles = useProfileStore((s) => s.profiles);
  const fetch = useProfileStore((s) => s.fetch);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const filtered = profiles.filter((p) => p.agent === agent);

  if (filtered.length === 0) {
    return onManage ? (
      <div className="profile-picker flex flex-col gap-1">
        <button
          type="button"
          className="profile-picker-manage bg-transparent border border-[var(--color-border)] rounded-lg text-[var(--color-accent)] px-3 py-2 min-h-[44px] text-sm self-start hover:bg-[var(--color-surface-2)]"
          onClick={onManage}
        >
          Manage profiles…
        </button>
      </div>
    ) : (
      <></>
    );
  }

  return (
    <div className="profile-picker flex flex-col gap-1">
      <select
        className="profile-picker-select w-full bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg px-3 py-2 min-h-[44px] text-sm text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
        defaultValue=""
        aria-label="select a profile"
        onChange={(e) => {
          const name = e.target.value;
          if (!name) return;
          const p = filtered.find((p) => p.name === name);
          if (p) onSelect(p);
          e.target.value = ''; // reset to placeholder
        }}
      >
        <option value="">— Pick a profile —</option>
        {filtered.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
            {p.default ? ' (default)' : ''} — {p.dirs.length} dir
            {p.dirs.length !== 1 ? 's' : ''}
          </option>
        ))}
      </select>
      {onManage && (
        <button
          type="button"
          className="profile-picker-manage bg-transparent border border-[var(--color-border)] rounded-lg text-[var(--color-accent)] px-3 py-2 min-h-[44px] text-sm self-start hover:bg-[var(--color-surface-2)]"
          onClick={onManage}
        >
          Manage profiles…
        </button>
      )}
    </div>
  );
}
