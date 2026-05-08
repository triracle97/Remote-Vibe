import { useNavigate, useOutletContext } from 'react-router-dom';
import { useSessionsStore } from '../store/sessions';
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

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 max-w-screen-md w-full mx-auto">
      <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3 px-1">Active Sessions</h2>
      {aliveSessions.length === 0 ? (
        <div className="bg-[color-mix(in_srgb,var(--color-surface-2)_50%,transparent)] border border-[var(--color-border)] rounded-xl py-6 px-6 text-[var(--color-text-dim)] text-center">
          No active sessions. Start one from Home or Projects.
        </div>
      ) : (
        <SessionList
          sessions={aliveSessions}
          activeId={null}
          onSelect={(id) => navigate(`/session/${id}`)}
          onNewSession={newSession.open}
        />
      )}
      {newSession.pickerNode}
    </div>
  );
}
