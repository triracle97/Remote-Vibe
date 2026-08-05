import { useEffect, useState, type JSX } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { Board as BoardGrid } from '../features/board/Board';
import { CardDetailSheet } from '../features/board/CardDetailSheet';
import { JobEditor } from '../features/board/JobEditor';
import { TagFilterBar } from '../features/board/TagFilterBar';
import { useBoardStore } from '../features/board/boardStore';
import { useJobsStore } from '../features/board/jobsStore';
import { useDefaultWorkspacesStore } from '../features/project-picker/defaultWorkspacesStore';
import { useNewSession } from '../features/project-picker/useNewSession';
import type { AppShellOutletContext } from '../shell/AppShell';
import { useIsDesktop } from '../shell/useIsDesktop';
import type { BoardSession, JobSummary } from '../types/protocol';


/**
 * Board view: every session the bridge knows about, live or historical,
 * arranged by phase.
 */
export function BoardPage(): JSX.Element {
  const loaded = useBoardStore((s) => s.loaded);
  const cards = useBoardStore((s) => s.cards);
  const refresh = useBoardStore((s) => s.refresh);
  const error = useBoardStore((s) => s.error);
  const clearError = useBoardStore((s) => s.clearError);

  const { client } = useOutletContext<AppShellOutletContext>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<BoardSession | null>(null);
  const [jobTarget, setJobTarget] = useState<JobSummary | 'new' | null>(null);
  // Exact complement of the shared desktop breakpoint — two definitions of
  // the same 768px boundary is how a sheet ends up open behind a docked panel.
  const mobile = !useIsDesktop();
  const { open: openNewSession, pickerNode } = useNewSession(client);

  const workspaces = useDefaultWorkspacesStore((s) => s.paths);
  const jobs = useJobsStore((s) => s.jobs);
  const refreshJobs = useJobsStore((s) => s.refresh);
  const jobError = useJobsStore((s) => s.error);
  const clearJobError = useJobsStore((s) => s.clearError);
  const lastStarted = useJobsStore((s) => s.lastStarted);
  const clearLastStarted = useJobsStore((s) => s.clearLastStarted);

  useEffect(() => {
    refresh();
    refreshJobs();
  }, [refresh, refreshJobs]);

  // Starting a job spawns a session — go straight to it, the way clicking
  // Start implies.
  useEffect(() => {
    if (lastStarted === null) return;
    clearLastStarted();
    navigate(`/session/${lastStarted.sessionId}`);
  }, [lastStarted, clearLastStarted, navigate]);

  // The overlay holds a snapshot; keep it in step with live updates so a card
  // that starts running doesn't show stale state behind the sheet.
  /**
   * Seed a new job's directory so the form is savable on open. Most recent
   * work first — that is almost always what the next job is about — falling
   * back to a configured workspace.
   */
  const defaultProjectPath =
    Object.values(cards).sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.projectPath ??
    workspaces[0] ??
    '';

  const detailLive = detail ? (cards[detail.sessionId] ?? null) : null;
  useEffect(() => {
    if (detail !== null && detailLive === null) setDetail(null);
  }, [detail, detailLive]);

  return (
    <div className="flex flex-col h-full min-h-0 p-3 md:p-4 gap-3">
      <header className="flex items-center gap-3 shrink-0">
        <h1 className="text-lg font-bold text-[var(--color-text)]">Board</h1>
        <span className="text-xs text-[var(--color-text-dim)] tabular-nums">
          {Object.keys(jobs).length} job{Object.keys(jobs).length === 1 ? '' : 's'} ·{' '}
          {Object.keys(cards).length} session{Object.keys(cards).length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={() => setJobTarget('new')}
          className="ml-auto text-sm px-3 py-1.5 rounded-lg border border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] text-[var(--color-text)]"
        >
          New job
        </button>
        <button
          type="button"
          onClick={openNewSession}
          className="text-sm px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-mute)] hover:text-[var(--color-text)]"
        >
          New session
        </button>
      </header>

      <div className="shrink-0">
        <TagFilterBar />
      </div>

      {(error ?? jobError) !== null && (
        <div
          role="alert"
          className="shrink-0 flex items-center gap-2 text-xs px-3 py-2 rounded-lg border border-[var(--color-danger)] text-[var(--color-danger)] bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)]"
        >
          <span className="flex-1">{error ?? jobError}</span>
          <button
            type="button"
            onClick={() => {
              clearError();
              clearJobError();
            }}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {!loaded ? (
          <p className="text-sm text-[var(--color-text-dim)]">Loading sessions…</p>
        ) : (
          <BoardGrid
            onDetails={setDetail}
            onNewJob={() => setJobTarget('new')}
            onEditJob={setJobTarget}
          />
        )}
      </div>

      <CardDetailSheet card={detailLive} onClose={() => setDetail(null)} mobile={mobile} />
      <JobEditor
        target={jobTarget}
        onClose={() => setJobTarget(null)}
        mobile={mobile}
        defaultProjectPath={defaultProjectPath}
      />
      {pickerNode}
    </div>
  );
}
