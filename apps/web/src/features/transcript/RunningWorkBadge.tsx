import type { JSX } from 'react';
import { ChevronsRight, Radar } from 'lucide-react';
import type { RunningWork } from './runningWork';

/**
 * "▶▶ 1 shell" in the session header.
 *
 * Mirrors what Claude Code shows in its own status line, because the question
 * is the same one: the turn looks idle, so is anything actually still running?
 * Renders nothing when there is nothing open — a zero here is noise, and this
 * row is already crowded.
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
  if (work.shells === 0 && work.monitors === 0) return null;

  const parts: string[] = [];
  if (work.shells > 0) parts.push(`${work.shells} shell${work.shells === 1 ? '' : 's'}`);
  if (work.monitors > 0) parts.push(`${work.monitors} monitor${work.monitors === 1 ? '' : 's'}`);
  const label = parts.join(' · ');
  const shown = compact ? String(work.shells + work.monitors) : label;

  return (
    <span
      data-testid="running-work-badge"
      title={`Still running in the background: ${label}`}
      aria-label={`Background work: ${label}`}
      className="flex items-center gap-1 px-2 py-1 shrink-0 rounded-lg border border-[var(--color-state-running)] text-[11px] tabular-nums text-[var(--color-state-running)] whitespace-nowrap"
    >
      {work.shells > 0 ? (
        <ChevronsRight size={13} aria-hidden="true" className="shrink-0" />
      ) : (
        <Radar size={13} aria-hidden="true" className="shrink-0" />
      )}
      {shown}
    </span>
  );
}
