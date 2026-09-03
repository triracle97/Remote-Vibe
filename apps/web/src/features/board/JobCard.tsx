import { useState, type JSX } from 'react';
import { Flag, Play, Trash2 } from 'lucide-react';
import type { JobPriority, JobSummary } from '../../types/protocol';
import { projectLabel, timeAgo } from './cardState';

interface Props {
  job: JobSummary;
  starting: boolean;
  onStart: (job: JobSummary) => void;
  onEdit: (job: JobSummary) => void;
  onDelete: (job: JobSummary) => void;
  onSetPriority: (job: JobSummary, priority: JobPriority) => void;
}

/**
 * A Backlog card: work not yet started.
 *
 * Deliberately distinct from a session card — dashed border, no live-state
 * dot, and a Start button instead of a status badge. The two never mean the
 * same thing, so they should not look the same.
 */
export function JobCard({
  job,
  starting,
  onStart,
  onEdit,
  onDelete,
  onSetPriority,
}: Props): JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const high = job.priority === 'high';

  return (
    <article
      data-testid="job-card"
      data-job-id={job.id}
      data-priority={job.priority}
      className={[
        'group rounded-lg border border-dashed bg-[var(--color-surface)] p-3 transition-colors hover:bg-[var(--color-surface-2)]',
        // A high-priority job earns a solid edge in the warn colour: the one
        // card in a column of dashed ones that is already spoken for.
        high
          ? 'border-l-2 [border-left-style:solid] border-l-[var(--color-warn)] border-[color-mix(in_srgb,var(--color-warn)_45%,var(--color-border))]'
          : 'border-[var(--color-border)]',
      ].join(' ')}
    >
      <button type="button" onClick={() => onEdit(job)} className="w-full text-left">
        <span className="block font-semibold text-[var(--color-text)] text-sm leading-snug line-clamp-2">
          {job.title}
        </span>
        {job.notes.trim().length > 0 && (
          <span className="mt-1 block text-[11px] text-[var(--color-text-dim)] line-clamp-2">
            {job.notes}
          </span>
        )}
        <span
          className="mt-1.5 block text-[11px] font-mono text-[var(--color-text-dim)] truncate"
          title={job.projectPath}
        >
          {projectLabel(job.projectPath)}
        </span>
      </button>

      <div className="mt-2 flex items-center gap-1 flex-wrap">
        {high && (
          <span
            data-testid="job-priority"
            className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded text-[var(--color-warn)] bg-[color-mix(in_srgb,var(--color-warn)_15%,transparent)]"
          >
            <Flag size={10} aria-hidden />
            high
          </span>
        )}
        <span
          className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
            job.agent === 'codex' ? 'bg-[#2a1c44] text-[#ffaaee]' : 'bg-[#1c2a44] text-[#aaeeff]'
          }`}
        >
          {job.agent}
        </span>
        {job.tags.map((t) => (
          <span
            key={t}
            className="text-[10px] px-1.5 py-0.5 rounded border"
            style={{
              color: 'var(--color-text-mute)',
              background: 'color-mix(in srgb, var(--color-text-mute) 12%, transparent)',
              borderColor: 'color-mix(in srgb, var(--color-text-mute) 30%, transparent)',
            }}
          >
            {t}
          </span>
        ))}
        <span className="ml-auto text-[10px] text-[var(--color-text-dim)] tabular-nums">
          {timeAgo(job.createdAt)}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onStart(job)}
          disabled={starting}
          className="flex-1 flex items-center justify-center gap-1.5 text-xs px-2 py-1.5 rounded-lg border border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] text-[var(--color-text)] disabled:opacity-50"
        >
          <Play size={12} aria-hidden />
          {starting ? 'Starting…' : 'Start'}
        </button>
        <button
          type="button"
          onClick={() => onSetPriority(job, high ? 'normal' : 'high')}
          aria-pressed={high}
          aria-label={high ? 'Set normal priority' : 'Mark high priority'}
          title={high ? 'Back to normal priority' : 'Do this before the rest of the Backlog'}
          className={`shrink-0 px-2 py-1.5 rounded-lg border text-xs transition-colors ${
            high
              ? 'border-[var(--color-warn)] text-[var(--color-warn)] bg-[color-mix(in_srgb,var(--color-warn)_15%,transparent)]'
              : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
          }`}
        >
          <Flag size={12} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            onDelete(job);
          }}
          aria-label={confirmDelete ? 'Confirm delete job' : 'Delete job'}
          className={`shrink-0 px-2 py-1.5 rounded-lg border text-xs transition-colors ${
            confirmDelete
              ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
              : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
          }`}
        >
          {confirmDelete ? 'Sure?' : <Trash2 size={12} aria-hidden />}
        </button>
      </div>
    </article>
  );
}
