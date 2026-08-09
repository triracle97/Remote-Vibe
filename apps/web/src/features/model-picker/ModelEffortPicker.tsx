import type { JSX } from 'react';
import {
  EFFORT_LEVELS,
  modelsFor,
  supportsUltracode,
  WORKFLOW_SIZES,
  type AgentKind,
  type EffortLevel,
  type WorkflowSize,
} from '../../types/protocol';

/**
 * Model and reasoning-effort selects, shared by the project picker, the job
 * editor and the in-session switcher.
 *
 * Both default to "(default)" meaning *omit the flag* — the CLI then applies
 * its own default. That is deliberately not the same as picking `high`: this
 * app should not silently pin a value the user never chose.
 *
 * Ultracode sits at the end of the effort list because that is where Claude
 * Code itself puts it. It is not an effort level: the bridge turns it into
 * xhigh plus a session settings file, and the CLI refuses it outright on Codex
 * or on a model that cannot reach xhigh — so it is hidden rather than offered
 * and then quietly downgraded. Choosing it reveals the workflow knobs, because
 * fleet size is the only thing standing between "a workflow" and fifty agents.
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
  /**
   * Workflow settings. Omit the handlers to hide the row entirely — the
   * session header switches a running session's model and effort, and these
   * two only take effect at spawn.
   */
  workflowSize?: WorkflowSize | null;
  onWorkflowSizeChange?: (s: WorkflowSize | null) => void;
  workflowKeywordTrigger?: boolean | null;
  onWorkflowKeywordTriggerChange?: (v: boolean | null) => void;
  /**
   * Offer ultracode at all.
   *
   * False for the in-session switcher: the mode rides in a `--settings` file
   * the CLI reads once at launch, so it is a choice about starting a session,
   * not a dial on a running one.
   */
  allowUltracode?: boolean;
}

export function ModelEffortPicker({
  agent,
  model,
  effort,
  onModelChange,
  onEffortChange,
  compact = false,
  disabled = false,
  workflowSize = null,
  onWorkflowSizeChange,
  workflowKeywordTrigger = null,
  onWorkflowKeywordTriggerChange,
  allowUltracode = true,
}: Props): JSX.Element {
  const selectClass = compact
    ? 'bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-50'
    : 'w-full bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-50';

  // Still shown when it is the session's current value, so the switcher reads
  // as "this is what it is running" rather than blanking the field.
  const ultracodeAvailable =
    (allowUltracode || effort === 'ultracode') && agent === 'claude' && supportsUltracode(model);
  const levels = EFFORT_LEVELS.filter((l) => !l.claudeOnly || ultracodeAvailable);
  const showWorkflowRow = effort === 'ultracode' && onWorkflowSizeChange !== undefined;

  return (
    <div className={compact ? 'contents' : 'flex flex-col gap-2'}>
      <div
        className={compact ? 'flex items-center gap-1.5' : 'flex gap-2'}
        data-testid="model-effort-picker"
      >
        <label className={compact ? 'contents' : 'flex-1 min-w-0'}>
          {!compact && (
            <span className="block text-xs text-[var(--color-text-dim)] mb-1">Model</span>
          )}
          <select
            aria-label="Model"
            className={selectClass}
            value={model ?? ''}
            disabled={disabled}
            onChange={(e) => {
              const next = e.target.value === '' ? null : e.target.value;
              onModelChange(next);
              // Switching to a model that cannot reach xhigh has to take the
              // mode with it, or the picker would show a choice the spawn is
              // about to overrule.
              if (effort === 'ultracode' && !supportsUltracode(next)) onEffortChange('xhigh');
            }}
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
            {levels.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {showWorkflowRow && (
        <div className="flex flex-col gap-2" data-testid="workflow-settings">
          <p className="text-xs text-[var(--color-text-dim)] leading-snug">
            Ultracode runs at xHigh and orchestrates multi-agent workflows by default. Fleet size is
            advisory — it shapes what the agent writes, it does not cap what it spends.
          </p>
          <label className="flex-1 min-w-0">
            <span className="block text-xs text-[var(--color-text-dim)] mb-1">Workflow size</span>
            <select
              aria-label="Workflow size"
              className={selectClass}
              value={workflowSize ?? ''}
              disabled={disabled}
              onChange={(e) =>
                onWorkflowSizeChange(
                  e.target.value === '' ? null : (e.target.value as WorkflowSize),
                )
              }
            >
              <option value="">Size: CLI default</option>
              {WORKFLOW_SIZES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          {onWorkflowKeywordTriggerChange !== undefined && (
            <label className="flex items-center gap-2 text-xs text-[var(--color-text-mute)]">
              <input
                type="checkbox"
                aria-label="Ultracode keyword trigger"
                disabled={disabled}
                checked={workflowKeywordTrigger !== false}
                onChange={(e) => onWorkflowKeywordTriggerChange(e.target.checked ? null : false)}
              />
              Let the word “ultracode” in a prompt trigger orchestration
            </label>
          )}
        </div>
      )}
    </div>
  );
}
