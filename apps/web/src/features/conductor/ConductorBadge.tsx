import { AlertTriangle, GitBranchPlus } from 'lucide-react';
import type { PipelineSummary } from '../../types/protocol';
import { pipelineBadgeLabel } from '../../store/conductor';

interface ConductorBadgeProps {
  pipeline: PipelineSummary;
  /** Navigates to the conductor page. */
  onClick(): void;
  /** Phone variant: icon only, no label. Space is scarce there. */
  compact?: boolean;
}

/**
 * "This session is driving a conductor pipeline, and here is where it has got
 * to." Appears on its own once the bridge finds a pipeline in the session's
 * dirs — nobody has to connect anything.
 *
 * `blocked` is the one state worth shouting about: it means a loop stopped and
 * is waiting on a human, which is exactly the thing you want to learn from a
 * phone rather than discover hours later at a desk.
 */
export function ConductorBadge({
  pipeline,
  onClick,
  compact = false,
}: ConductorBadgeProps): JSX.Element {
  const label = pipelineBadgeLabel(pipeline);
  // Name the worktree when the pipeline is not this session's own, so a
  // sibling worktree's work is never mistaken for what this session is doing.
  const where = pipeline.inSessionDir
    ? ''
    : ` — in worktree ${pipeline.worktree.split('/').filter(Boolean).pop() ?? pipeline.worktree}`;
  const title = `Conductor: ${pipeline.slug} — ${label}${where}${pipeline.blocked ? ' (BLOCKED)' : ''}`;

  if (compact) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={title}
        data-testid="conductor-badge"
        className="relative min-w-[44px] min-h-[44px] shrink-0 flex items-center justify-center rounded text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
      >
        {pipeline.blocked ? (
          <AlertTriangle size={18} className="text-[var(--color-danger)]" aria-hidden="true" />
        ) : (
          <GitBranchPlus size={18} aria-hidden="true" />
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      data-testid="conductor-badge"
      className="shrink-0 flex items-center gap-1.5 min-h-[44px] px-2 rounded text-xs font-mono text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
    >
      {pipeline.blocked ? (
        <AlertTriangle size={14} className="text-[var(--color-danger)] shrink-0" aria-hidden="true" />
      ) : (
        <GitBranchPlus size={14} className="shrink-0" aria-hidden="true" />
      )}
      <span className="max-w-[12rem] truncate">{label}</span>
    </button>
  );
}
