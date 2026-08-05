import { useCallback, useMemo, useState, type DragEvent, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Archive } from 'lucide-react';
import {
  SESSION_PHASE_COLUMNS,
  type BoardSession,
  type JobSummary,
  type SessionPhase,
} from '../../types/protocol';
import { groupByPhase, useBoardStore } from './boardStore';
import { jobMatchesFilter, sortedJobs, useJobsStore } from './jobsStore';
import { SessionCard } from './SessionCard';
import { JobCard } from './JobCard';

interface Props {
  onDetails: (card: BoardSession) => void;
  onNewJob: () => void;
  onEditJob: (job: JobSummary) => void;
}

/**
 * Five phase columns of session cards.
 *
 * Native HTML5 drag events, no DnD library — the same choice nimbalyst's own
 * tracker boards make. Column drop targets are whole columns rather than
 * inter-card gaps: order within a column is derived (live first, then
 * recency), so there is nothing meaningful to drop *between*.
 */
export function Board({ onDetails, onNewJob, onEditJob }: Props): JSX.Element {
  const navigate = useNavigate();
  const cards = useBoardStore((s) => s.cards);
  const archivePhase = useBoardStore((s) => s.archivePhase);
  const [confirmClear, setConfirmClear] = useState(false);
  const filter = useBoardStore((s) => s.filter);
  const setPhase = useBoardStore((s) => s.setPhase);
  const jobs = useJobsStore((s) => s.jobs);
  const starting = useJobsStore((s) => s.starting);
  const startJob = useJobsStore((s) => s.startJob);
  const deleteJob = useJobsStore((s) => s.deleteJob);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overPhase, setOverPhase] = useState<SessionPhase | null>(null);

  const byPhase = useMemo(() => groupByPhase(cards, filter), [cards, filter]);
  const backlogJobs = useMemo(
    () => sortedJobs(jobs).filter((j) => jobMatchesFilter(j, filter)),
    [jobs, filter],
  );

  const handleDragStart = useCallback((card: BoardSession, e: DragEvent<HTMLElement>) => {
    setDraggingId(card.sessionId);
    e.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to start a drag without payload on the transfer.
    e.dataTransfer.setData('text/plain', card.sessionId);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggingId(null);
    setOverPhase(null);
  }, []);

  const handleDrop = useCallback(
    (phase: SessionPhase, e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      // Prefer React state over dataTransfer: Safari clears the payload on
      // some drops, but our own state survives.
      const id = draggingId ?? e.dataTransfer.getData('text/plain');
      setDraggingId(null);
      setOverPhase(null);
      if (id) setPhase(id, phase);
    },
    [draggingId, setPhase],
  );

  return (
    <div
      data-testid="board"
      className={[
        'flex gap-3 h-full',
        // Mobile: one column at a time, snapped. Desktop: all five side by side.
        'overflow-x-auto snap-x snap-mandatory md:snap-none',
        'pb-2',
      ].join(' ')}
    >
      {SESSION_PHASE_COLUMNS.map((col) => {
        const list = byPhase.get(col.value) ?? [];
        const isBacklog = col.value === 'backlog';
        // Backlog is the job queue. Sessions only appear there if one is
        // dragged back, which stays possible rather than silently vanishing.
        const count = isBacklog ? backlogJobs.length + list.length : list.length;
        const isOver = overPhase === col.value;
        return (
          <section
            key={col.value}
            data-testid={`board-column-${col.value}`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (overPhase !== col.value) setOverPhase(col.value);
            }}
            onDragLeave={(e) => {
              // Ignore bubbling from children, or the highlight flickers.
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              if (overPhase === col.value) setOverPhase(null);
            }}
            onDrop={(e) => handleDrop(col.value, e)}
            className={[
              'flex flex-col shrink-0 snap-center',
              'w-[85vw] sm:w-72 md:w-full md:min-w-0 md:flex-1',
              'rounded-xl border transition-colors',
              isOver
                ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]'
                : 'border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface)_50%,transparent)]',
            ].join(' ')}
          >
            <header className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)]">
              <span
                aria-hidden
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: `var(${col.token})` }}
              />
              <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-mute)]">
                {col.label}
              </h2>
              <span className="ml-auto text-xs tabular-nums text-[var(--color-text-dim)]">
                {count}
              </span>
              {isBacklog && (
                <button
                  type="button"
                  onClick={onNewJob}
                  aria-label="New job"
                  title="New job"
                  className="shrink-0 p-1 -my-1 rounded text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                >
                  <Plus size={14} aria-hidden />
                </button>
              )}
              {col.value === 'done' && list.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    // Two presses, like the editor's save: this touches every
                    // card in the column at once, and a stray tap on a phone
                    // should not clear the lot.
                    if (confirmClear) {
                      archivePhase('done');
                      setConfirmClear(false);
                    } else {
                      setConfirmClear(true);
                    }
                  }}
                  onBlur={() => setConfirmClear(false)}
                  aria-label={
                    confirmClear
                      ? `Confirm archiving ${list.length} done session${list.length === 1 ? '' : 's'}`
                      : 'Clear the Done column'
                  }
                  title="Archive every session in Done. They stay in the registry — turn on “archived” in the filter bar to see them again."
                  className={[
                    'shrink-0 flex items-center gap-1 px-1.5 py-1 -my-1 rounded text-[11px]',
                    confirmClear
                      ? 'text-[var(--color-warn)] bg-[color-mix(in_srgb,var(--color-warn)_15%,transparent)]'
                      : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]',
                  ].join(' ')}
                >
                  <Archive size={14} aria-hidden />
                  {confirmClear && <span>Archive {list.length}?</span>}
                </button>
              )}
            </header>

            <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2 min-h-[6rem]">
              {isBacklog &&
                backlogJobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    starting={starting[job.id] === true}
                    onStart={(j) => startJob(j.id)}
                    onEdit={onEditJob}
                    onDelete={(j) => deleteJob(j.id)}
                  />
                ))}

              {list.map((card) => (
                <SessionCard
                  key={card.sessionId}
                  card={card}
                  dragging={draggingId === card.sessionId}
                  onOpen={(c) => navigate(`/session/${c.sessionId}`)}
                  onDetails={onDetails}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                />
              ))}

              {count === 0 &&
                (isBacklog ? (
                  <button
                    type="button"
                    onClick={onNewJob}
                    className="text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)] text-center py-6 rounded-lg border border-dashed border-[var(--color-border)]"
                  >
                    {isOver ? 'Drop here' : '+ Add a job'}
                  </button>
                ) : (
                  <p className="text-xs text-[var(--color-text-dim)] text-center py-6 select-none">
                    {isOver ? 'Drop here' : 'Nothing here'}
                  </p>
                ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
