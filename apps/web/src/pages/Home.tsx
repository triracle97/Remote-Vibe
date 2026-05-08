import { useNavigate } from 'react-router-dom';
import { useSessionsStore } from '../store/sessions';
import { useConnectionStore } from '../store/connection';
import type { BridgeClient } from '../services/bridge-client';
import { SessionList } from '../features/session-list/SessionList';
import { useNewSession } from '../features/project-picker/useNewSession';
import { HistoryPanel } from '../features/history/HistoryPanel';

interface HomeProps {
  client: BridgeClient;
}

export function Home({ client }: HomeProps): JSX.Element {
  const order = useSessionsStore((s) => s.order);
  const sessionsMap = useSessionsStore((s) => s.sessions);
  const status = useConnectionStore((s) => s.status);
  const lastError = useConnectionStore((s) => s.lastError);
  const navigate = useNavigate();
  const newSession = useNewSession(client);

  const sessions = order.map((id) => sessionsMap[id]!).filter((s) => s !== undefined);

  return (
    <>
      <SessionList
        sessions={sessions}
        activeId={null}
        onSelect={(id) => navigate(`/session/${id}`)}
        onNewSession={newSession.open}
      />
      <HistoryPanel />
      <main className="home-main">
        <h1>mac-remote-terminal</h1>
        <p>connection: {status}</p>
        {lastError && <p className="error-banner">error: {lastError}</p>}
        <p>{sessions.length === 0 ? 'No sessions yet. Click + New Claude session.' : 'Pick a session from the sidebar.'}</p>
      </main>
      {newSession.pickerNode}
    </>
  );
}
