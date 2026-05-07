import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSessionsStore } from '../store/sessions';
import { useConnectionStore } from '../store/connection';
import type { BridgeClient } from '../services/bridge-client';
import { SessionList } from '../features/session-list/SessionList';
import { Chat } from '../features/chat/Chat';
import { useNewSession } from '../features/project-picker/useNewSession';
import { streamTranscript } from '../services/transcript-fetcher';

interface SessionProps {
  client: BridgeClient;
}

export function Session({ client }: SessionProps): JSX.Element {
  const { id } = useParams();
  const navigate = useNavigate();
  const order = useSessionsStore((s) => s.order);
  const sessionsMap = useSessionsStore((s) => s.sessions);
  const setActive = useSessionsStore((s) => s.setActive);
  const apply = useSessionsStore((s) => s.applyServerMsg);
  const transcriptOnly = useSessionsStore((s) => (id ? Boolean(s.transcriptOnly[id]) : false));
  const session = id ? sessionsMap[id] : undefined;
  const newSession = useNewSession(client);

  useEffect(() => {
    if (id) setActive(id);
  }, [id, setActive]);

  const connStatus = useConnectionStore((s) => s.status);
  // Send `get_history` exactly once per (id, connection-open) edge. We do
  // NOT gate on `sessions[id]` existing, because deep-linking after a bridge
  // restart hits this page with the session NOT in the store; the bridge
  // replies with `error: session_dead` (carrying sessionId), which App.tsx
  // routes to `markTranscriptOnly`, which flips `transcriptOnly[id]` and
  // triggers the transcript-fetcher effect below.
  const askedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id || connStatus !== 'open' || transcriptOnly) {
      askedRef.current = null;
      return;
    }
    if (askedRef.current === id) return;
    askedRef.current = id;
    const snapshot = useSessionsStore.getState().sessions[id];
    const since = snapshot?.lastSeq ?? 0;
    client.send({ type: 'get_history', sessionId: id, since });
  }, [client, id, connStatus, transcriptOnly]);

  // Transcript-only fallback: stream the disk transcript and dispatch each line
  // through applyServerMsg. Keep a guard ref so we only do it once per session id.
  const fallbackStartedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !transcriptOnly || fallbackStartedRef.current === id) return;
    fallbackStartedRef.current = id;
    let cancelled = false;
    (async () => {
      try {
        for await (const ev of streamTranscript(id)) {
          if (cancelled) return;
          apply(ev);
        }
      } catch (err) {
        console.warn('[transcript fallback]', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, transcriptOnly, apply]);

  if (!session && !transcriptOnly) {
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
      {session && (
        <Chat
          session={session}
          onSend={
            transcriptOnly
              ? () => {}
              : (text) => client.send({ type: 'input', sessionId: session.sessionId, text })
          }
          onStop={
            transcriptOnly
              ? () => {}
              : () => client.send({ type: 'stop_session', sessionId: session.sessionId })
          }
          banner={
            transcriptOnly
              ? 'transcript-only view (session no longer live)'
              : null
          }
          inputDisabled={transcriptOnly}
        />
      )}
      {!session && transcriptOnly && (
        <main className="home-main">
          <p>Loading transcript…</p>
        </main>
      )}
      {newSession.pickerNode}
    </>
  );
}
