import type { JSX } from 'react';
import { EFFORT_LEVELS, modelsFor, type AgentKind, type EffortLevel } from '../../types/protocol';

/**
 * Model and reasoning-effort selects, shared by the project picker, the job
 * editor and the in-session switcher.
 *
 * Both default to "(default)" meaning *omit the flag* — the CLI then applies
 * its own default. That is deliberately not the same as picking `high`: this
 * app should not silently pin a value the user never chose.
 */

interface Props {
  agent: AgentKind;
  model: string | null;
  effort: EffortLevel | null;
  onModelChange: (m: string | null) => void;
  onEffortChange: (e: EffortLevel | null) => void;
  /** Rendered small and inline, for the session header. */
  compact?: boolean;
  disabled?: boolean;
}

export function ModelEffortPicker({
  agent,
  model,
  effort,
  onModelChange,
  onEffortChange,
  compact = false,
  disabled = false,
}: Props): JSX.Element {
  const selectClass = compact
    ? 'bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-50'
    : 'w-full bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-50';

  return (
    <div className={compact ? 'flex items-center gap-1.5' : 'flex gap-2'} data-testid="model-effort-picker">
      <label className={compact ? 'contents' : 'flex-1 min-w-0'}>
        {!compact && (
          <span className="block text-xs text-[var(--color-text-dim)] mb-1">Model</span>
        )}
        <select
          aria-label="Model"
          className={selectClass}
          value={model ?? ''}
          disabled={disabled}
          onChange={(e) => onModelChange(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">Model: default</option>
          {modelsFor(agent).map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <label className={compact ? 'contents' : 'flex-1 min-w-0'}>
        {!compact && (
          <span className="block text-xs text-[var(--color-text-dim)] mb-1">Effort</span>
        )}
        <select
          aria-label="Effort"
          className={selectClass}
          value={effort ?? ''}
          disabled={disabled}
          onChange={(e) =>
            onEffortChange(e.target.value === '' ? null : (e.target.value as EffortLevel))
          }
        >
          <option value="">Effort: default</option>
          {EFFORT_LEVELS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
