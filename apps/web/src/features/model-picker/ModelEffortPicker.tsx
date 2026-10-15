import type { JSX } from 'react';
import {
  EFFORT_LEVELS,
  modelLabel,
  modelsFor,
  supportsUltracode,
  WORKFLOW_SIZES,
  type AgentKind,
  type EffortLevel,
  type WorkflowSize,
} from '../../types/protocol';
import { useCodexCatalogStore } from '../../store/codex-models';
import type { CodexCatalogModel } from '../../types/protocol';

/**
 * Efforts the effort row may offer for this Codex selection.
 *
 * A chosen model uses its own list. "Model: default" uses the levels every
 * visible model shares, so picking Ultra against an unnamed default cannot
 * land on a model that rejects it.
 */
function effortsFor(catalog: readonly CodexCatalogModel[], model: string | null): EffortLevel[] | null {
  if (catalog.length === 0) return null;
  if (model === null) {
    return catalog[0]!.efforts.filter((level) => catalog.every((m) => m.efforts.includes(level)));
  }
  // An id the catalog does not list keeps the static effort row. Filtering
  // against nothing would hide every level.
  return catalog.find((m) => m.value === model)?.efforts ?? null;
}

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
  const catalogModels = useCodexCatalogStore((s) => s.models);
  const catalog = agent === 'codex' && catalogModels.length > 0 ? catalogModels : null;
  const selectClass = compact
    ? 'bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-50'
    : 'w-full bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-50';

  // Still shown when it is the session's current value, so the switcher reads
  // as "this is what it is running" rather than blanking the field.
  const ultracodeAvailable =
    (allowUltracode || effort === 'ultracode') && agent === 'claude' && supportsUltracode(model);
  const allowed = catalog ? effortsFor(catalog, model) : null;
  const levels = EFFORT_LEVELS.filter((l) => {
    if (l.claudeOnly && !ultracodeAvailable) return false;
    // `ultra` stays hidden until the selected Codex model lists it. A session
    // already running it still shows the value, so the switcher does not go blank.
    if (l.codexOnly) return effort === l.value || (allowed?.includes(l.value) ?? false);
    if (allowed && !allowed.includes(l.value) && effort !== l.value) return false;
    return true;
  });
  const listed = catalog
    ? catalog.map((m) => ({ value: m.value, label: m.label }))
    : modelsFor(agent);
  // A session can be on an id the current catalog no longer lists. Keep it as
  // an option so the select still shows what is running.
  const models =
    model !== null && !listed.some((m) => m.value === model)
      ? [...listed, { value: model, label: modelLabel(agent, model) }]
      : listed;
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
              if (effort === 'ultracode' && !supportsUltracode(next)) {
                onEffortChange('xhigh');
                return;
              }
              if (agent !== 'codex' || effort === null || !catalog) return;
              const nextAllowed = effortsFor(catalog, next);
              if (!nextAllowed || nextAllowed.includes(effort)) return;
              const picked = next === null ? null : catalog.find((m) => m.value === next);
              const fallback =
                picked?.defaultEffort && nextAllowed.includes(picked.defaultEffort)
                  ? picked.defaultEffort
                  : nextAllowed.includes('high')
                    ? 'high'
                    : (nextAllowed[0] ?? null);
              onEffortChange(fallback);
            }}
          >
            <option value="">Model: default</option>
            {models.map((m) => (
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
