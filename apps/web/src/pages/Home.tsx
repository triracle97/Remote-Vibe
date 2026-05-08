import { useNavigate, useOutletContext, Link } from 'react-router-dom';
import { Plus, ChevronRight } from 'lucide-react';
import { useSessionsStore } from '../store/sessions';
import { useConnectionStore } from '../store/connection';
import type { AppShellOutletContext } from '../shell/AppShell';
import { useNewSession } from '../features/project-picker/useNewSession';
import { HistoryPanel } from '../features/history/HistoryPanel';

export function Home(): JSX.Element {
  const { client } = useOutletContext<AppShellOutletContext>();
  const order = useSessionsStore((s) => s.order);
  const sessionsMap = useSessionsStore((s) => s.sessions);
  const status = useConnectionStore((s) => s.status);
  const lastError = useConnectionStore((s) => s.lastError);
  const navigate = useNavigate();
  const newSession = useNewSession(client);

  const sessions = order
    .map((id) => sessionsMap[id]!)
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  const aliveSessions = sessions.filter((s) => s.alive).slice(0, 3);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 max-w-screen-md w-full mx-auto">
      {lastError && (
        <div
          role="alert"
          className="mb-3 px-3 py-2 rounded-lg text-sm bg-[color-mix(in_srgb,var(--color-danger)_20%,var(--color-surface))] text-[var(--color-danger)] border border-[var(--color-danger)]"
        >
          error: {lastError}
        </div>
      )}
      {status !== 'open' && (
        <div className="mb-3 px-3 py-2 rounded-lg text-xs text-[var(--color-text-dim)] bg-[var(--color-surface)] border border-[var(--color-border)]">
          connection: {status}
        </div>
      )}

      <button
        type="button"
        onClick={newSession.open}
        className="w-full bg-[var(--color-accent)] text-white font-semibold py-4 rounded-2xl text-xl mb-10 shadow-lg shadow-[color-mix(in_srgb,var(--color-accent)_30%,transparent)] hover:scale-[1.02] active:scale-[0.98] transition flex items-center justify-center gap-2"
      >
        <Plus size={22} aria-hidden="true" />
        New Session
      </button>

      <section className="mb-8">
        <div className="flex items-center justify-between mb-3 px-1">
          <h3 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase">
            Active Sessions
          </h3>
          <Link to="/sessions" className="text-[var(--color-text-dim)] hover:text-[var(--color-text)] flex items-center gap-1 text-xs">
            See all
            <ChevronRight size={14} aria-hidden="true" />
          </Link>
        </div>
        {aliveSessions.length === 0 ? (
          <div className="bg-[color-mix(in_srgb,var(--color-surface-2)_50%,transparent)] border border-[var(--color-border)] rounded-xl py-4 px-6 text-[var(--color-text-dim)] text-center font-medium">
            No active sessions
          </div>
        ) : (
          <ul className="list-none p-0 m-0 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl divide-y divide-[var(--color-border)] overflow-hidden">
            {aliveSessions.map((s) => {
              const label = s.projectPath.split('/').filter(Boolean).pop() ?? s.projectPath;
              return (
                <li key={s.sessionId}>
                  <button
                    type="button"
                    className="w-full text-left p-4 min-h-[56px] flex items-center justify-between hover:bg-[var(--color-surface-2)] transition-colors"
                    onClick={() => navigate(`/session/${s.sessionId}`)}
                  >
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-[var(--color-text)] font-bold truncate">{label}</span>
                      <span className="text-[var(--color-text-dim)] text-xs font-mono truncate">{s.projectPath}</span>
                    </div>
                    <div className="w-2.5 h-2.5 bg-[var(--color-success)] rounded-full shadow-[0_0_8px_color-mix(in_srgb,var(--color-success)_60%,transparent)] shrink-0" aria-label="alive" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <h3 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase">History</h3>
        </div>
        <HistoryPanel />
      </section>

      {newSession.pickerNode}
    </div>
  );
}
