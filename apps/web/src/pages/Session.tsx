import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSessionsStore } from '../store/sessions';
import { useConnectionStore } from '../store/connection';
import type { BridgeClient } from '../services/bridge-client';
import { SessionList } from '../features/session-list/SessionList';
import { Chat } from '../features/chat/Chat';
import { useNewSession } from '../features/project-picker/useNewSession';

interface SessionProps {
  client: BridgeClient;
}

export function Session({ client }: SessionProps): JSX.Element {
  const { id } = useParams();
  const navigate = useNavigate();
  const order = useSessionsStore((s) => s.order);
  const sessionsMap = useSessionsStore((s) => s.sessions);
  const setActive = useSessionsStore((s) => s.setActive);
  const session = id ? sessionsMap[id] : undefined;
  const newSession = useNewSession(client);

  useEffect(() => {
    if (id) setActive(id);
  }, [id, setActive]);

  const connStatus = useConnectionStore((s) => s.status);
  // sessionExists flips false → true exactly once when the session
  // appears in the store (either from session_list after a reload or
  // from session_created on a fresh start). Using a boolean here, not
  // the whole session object, prevents history-request loops while
  // still firing the effect when the session first becomes known.
  const sessionExists = useSessionsStore((s) => (id ? Boolean(s.sessions[id]) : false));
  useEffect(() => {
    if (!id || connStatus !== 'open' || !sessionExists) return;
    const snapshot = useSessionsStore.getState().sessions[id];
    if (!snapshot) return;
    client.send({ type: 'get_history', sessionId: id, since: snapshot.lastSeq });
  }, [client, id, connStatus, sessionExists]);

  if (!session) {
    return (
      <main className="home-main">
        <p>Session not found.</p>
        <button onClick={() => navigate('/')}>Home</button>
      </main>
    );
  }

  const sessions = order.map((sid) => sessionsMap[sid]!).filter((s) => s !== undefined);

  return (
    <>
      <SessionList
        sessions={sessions}
        activeId={id ?? null}
        onSelect={(nid) => navigate(`/session/${nid}`)}
        onNewSession={newSession.open}
      />
      <Chat
        session={session}
        onSend={(text) => client.send({ type: 'input', sessionId: session.sessionId, text })}
        onStop={() => client.send({ type: 'stop_session', sessionId: session.sessionId })}
      />
      {newSession.pickerNode}
    </>
  );
}
