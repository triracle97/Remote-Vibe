import type { JSX } from 'react';
import { ChevronsRight, Radar, Users } from 'lucide-react';
import type { RunningWork } from './runningWork';

/**
 * "▶▶ 1 shell" in the session header.
 *
 * Mirrors what Claude Code shows in its own status line, because the question
 * is the same one: the turn looks idle, so is anything actually still running?
 * Renders nothing when there is nothing open — a zero here is noise, and this
 * row is already crowded.
 *
 * Agents lead when there are any. A workflow can have a dozen of them running
 * at once, which is the most expensive thing this badge ever reports and the
 * one most worth noticing from the header.
 */
export function RunningWorkBadge({
  work,
  /** Drop the words and show just the count. For a phone header, where the
      full "13 shells · 2 monitors" is most of the row. */
  compact = false,
}: {
  work: RunningWork;
  compact?: boolean;
}): JSX.Element | null {
  const total = work.shells + work.monitors + work.subagents + work.workflows;
  if (total === 0) return null;

  const parts: string[] = [];
  if (work.workflows > 0) {
    parts.push(`${work.workflows} workflow${work.workflows === 1 ? '' : 's'}`);
  }
  if (work.subagents > 0) parts.push(`${work.subagents} agent${work.subagents === 1 ? '' : 's'}`);
  if (work.shells > 0) parts.push(`${work.shells} shell${work.shells === 1 ? '' : 's'}`);
  if (work.monitors > 0) parts.push(`${work.monitors} monitor${work.monitors === 1 ? '' : 's'}`);
  const label = parts.join(' · ');
  const shown = compact ? String(total) : label;
  const agents = work.subagents + work.workflows > 0;

  return (
    <span
      data-testid="running-work-badge"
      title={`Still running in the background: ${label}`}
      aria-label={`Background work: ${label}`}
      className="flex items-center gap-1 px-2 py-1 shrink-0 rounded-lg border border-[var(--color-state-running)] text-[11px] tabular-nums text-[var(--color-state-running)] whitespace-nowrap"
    >
      {agents ? (
        <Users size={13} aria-hidden="true" className="shrink-0" />
      ) : work.shells > 0 ? (
        <ChevronsRight size={13} aria-hidden="true" className="shrink-0" />
      ) : (
        <Radar size={13} aria-hidden="true" className="shrink-0" />
      )}
      {shown}
    </span>
  );
}
