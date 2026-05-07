import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSessionsStore } from '../store/sessions';
import { useConnectionStore } from '../store/connection';
import { useFileExplorerStore } from '../store/file-explorer';
import type { BridgeClient } from '../services/bridge-client';
import { SessionList } from '../features/session-list/SessionList';
import { Chat } from '../features/chat/Chat';
import { useNewSession } from '../features/project-picker/useNewSession';
import { streamTranscript } from '../services/transcript-fetcher';
import { FileExplorer } from '../features/file-explorer/FileExplorer';

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
  const resetExplorer = useFileExplorerStore((s) => s.reset);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (id) setActive(id);
  }, [id, setActive]);

  // Reset file-explorer state when switching sessions.
  useEffect(() => {
    resetExplorer();
    setDrawerOpen(false);
  }, [id, resetExplorer]);

  const connStatus = useConnectionStore((s) => s.status);
  const lastError = useConnectionStore((s) => s.lastError);
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
              : (text, images) =>
                  client.send({
                    type: 'input',
                    sessionId: session.sessionId,
                    text,
                    ...(images && images.length > 0
                      ? { images: images.slice(), correlationId: newCorrelationId() }
                      : {}),
                  })
          }
          onStop={
            transcriptOnly
              ? () => {}
              : () => client.send({ type: 'stop_session', sessionId: session.sessionId })
          }
          onToggleDrawer={() => setDrawerOpen((o) => !o)}
          drawerOpen={drawerOpen}
          banner={transcriptOnly ? 'transcript-only view (session no longer live)' : null}
          errorBanner={lastError}
          inputDisabled={transcriptOnly}
        />
      )}
      {!session && transcriptOnly && (
        <main className="home-main">
          <p>Loading transcript…</p>
        </main>
      )}
      {drawerOpen && session && (
        <FileExplorer
          client={client}
          rootPath={session.projectPath}
          onClose={() => setDrawerOpen(false)}
        />
      )}
      {newSession.pickerNode}
    </>
  );
}

function newCorrelationId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
