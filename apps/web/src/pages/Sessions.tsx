import { useNavigate, useOutletContext } from 'react-router-dom';
import { useSessionsStore } from '../store/sessions';
import { useTerminalsStore } from '../store/terminals';
import type { AppShellOutletContext } from '../shell/AppShell';
import { SessionList } from '../features/session-list/SessionList';
import { useNewSession } from '../features/project-picker/useNewSession';

export function Sessions(): JSX.Element {
  const { client } = useOutletContext<AppShellOutletContext>();
  const order = useSessionsStore((s) => s.order);
  const sessionsMap = useSessionsStore((s) => s.sessions);
  const navigate = useNavigate();
  const newSession = useNewSession(client);

  const aliveSessions = order
    .map((id) => sessionsMap[id]!)
    .filter((s): s is NonNullable<typeof s> => s !== undefined && s.alive);

  const terminalsMap = useTerminalsStore((s) => s.terminals);
  const terminalsOrder = useTerminalsStore((s) => s.order);

  const aliveTerminals = terminalsOrder
    .map((id) => terminalsMap[id]!)
    .filter((t): t is NonNullable<typeof t> => Boolean(t?.alive));

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 max-w-screen-md w-full mx-auto">
      <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3 px-1">Active Sessions</h2>
      {aliveSessions.length === 0 && aliveTerminals.length === 0 ? (
        <div className="bg-[color-mix(in_srgb,var(--color-surface-2)_50%,transparent)] border border-[var(--color-border)] rounded-xl py-6 px-6 text-[var(--color-text-dim)] text-center">
          No active sessions. Start one from Home or Projects.
        </div>
      ) : (
        <>
          {aliveSessions.length > 0 && (
            <SessionList
              sessions={aliveSessions}
              activeId={null}
              onSelect={(id) => navigate(`/session/${id}`)}
              onNewSession={newSession.open}
            />
          )}
          {aliveTerminals.length > 0 && (
            <ul className="list-none p-0 m-0 mt-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl divide-y divide-[var(--color-border)] overflow-hidden">
              {aliveTerminals.map((t) => {
                const label = t.cwd.split('/').filter(Boolean).pop() ?? t.cwd;
                return (
                  <li key={t.termId}>
                    <button
                      type="button"
                      className="w-full text-left p-4 min-h-[56px] flex items-center justify-between hover:bg-[var(--color-surface-2)] transition-colors"
                      onClick={() => navigate(`/terminal/${t.termId}`)}
                    >
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-[var(--color-text)] font-bold truncate">
                          <span className="text-[var(--color-text-dim)] text-xs mr-1">[term]</span>
                          {label}
                        </span>
                        <span className="text-[var(--color-text-dim)] text-xs font-mono truncate">{t.cwd}</span>
                      </div>
                      <div className="w-2.5 h-2.5 bg-[var(--color-success)] rounded-full shrink-0" aria-label="alive" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {newSession.pickerNode}
    </div>
  );
}
