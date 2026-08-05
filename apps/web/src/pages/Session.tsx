import { useEffect, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { useSessionsStore } from '../store/sessions';
import { useConnectionStore } from '../store/connection';
import { useFileExplorerStore } from '../store/file-explorer';
import type { AppShellOutletContext } from '../shell/AppShell';
import { Chat } from '../features/chat/Chat';
import { useNewSession } from '../features/project-picker/useNewSession';
import { streamTranscript } from '../services/transcript-fetcher';
import { FileExplorer } from '../features/file-explorer/FileExplorer';
import { SessionList } from '../features/session-list/SessionList';
import { HistoryPanel } from '../features/history/HistoryPanel';
import { BottomSheet } from '../shell/BottomSheet';
import { NAV_TABS } from '../shell/NavRail';

type MobileNavTab = 'sessions' | 'history';

export function Session(): JSX.Element {
  const { client } = useOutletContext<AppShellOutletContext>();
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileNavTab, setMobileNavTab] = useState<MobileNavTab>('sessions');
  const mobileNavReturnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (id) setActive(id);
  }, [id, setActive]);

  useEffect(() => {
    document.title = session?.name
      ? `${session.name} — mac-remote-terminal`
      : 'mac-remote-terminal';
    return () => {
      document.title = 'mac-remote-terminal';
    };
  }, [session?.name]);

  useEffect(() => {
    resetExplorer();
    setDrawerOpen(false);
  }, [id, resetExplorer]);

  // The drawer lives here but the shortcut is registered globally, so the
  // shell announces the intent and whichever session page is mounted acts on
  // it. Cheaper than threading a setter up through the router context.
  useEffect(() => {
    const toggle = (): void => setDrawerOpen((o) => !o);
    window.addEventListener('mrt:toggle-file-drawer', toggle);
    return () => window.removeEventListener('mrt:toggle-file-drawer', toggle);
  }, []);

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

  const sessions = order
    .map((sid) => sessionsMap[sid]!)
    .filter((s): s is NonNullable<typeof s> => s !== undefined);

  const closeMobileNav = (): void => {
    setMobileNavOpen(false);
    const returnTarget = mobileNavReturnFocusRef.current;
    if (returnTarget && document.contains(returnTarget)) returnTarget.focus();
  };
  const openMobileNav = (opener?: HTMLElement): void => {
    mobileNavReturnFocusRef.current = opener ?? null;
    setMobileNavTab('sessions');
    setMobileNavOpen(true);
  };

  if (!session && !transcriptOnly) {
    return (
      <main className="flex-1 flex items-center justify-center p-4 text-[var(--color-text-dim)]">
        <div className="flex flex-col gap-3 items-center">
          <p>Session not found.</p>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="px-4 py-2 min-h-[44px] bg-[var(--color-accent)] text-white rounded-lg"
          >
            Home
          </button>
        </div>
      </main>
    );
  }

  return (
    <>
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
          onOpenMobileNav={openMobileNav}
          banner={transcriptOnly ? 'transcript-only view (session no longer live)' : null}
          errorBanner={lastError}
          inputDisabled={transcriptOnly}
        />
      )}

      <BottomSheet
        open={mobileNavOpen}
        onClose={closeMobileNav}
        ariaLabel="Sessions and history"
      >
        <div className="flex border-b border-[var(--color-border)]">
          <button
            type="button"
            onClick={() => setMobileNavTab('sessions')}
            className={[
              'flex-1 min-h-[44px] py-2 text-sm transition-colors',
              mobileNavTab === 'sessions'
                ? 'text-[var(--color-accent)] border-b-2 border-[var(--color-accent)]'
                : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]',
            ].join(' ')}
          >
            Sessions
          </button>
          <button
            type="button"
            onClick={() => setMobileNavTab('history')}
            className={[
              'flex-1 min-h-[44px] py-2 text-sm transition-colors',
              mobileNavTab === 'history'
                ? 'text-[var(--color-accent)] border-b-2 border-[var(--color-accent)]'
                : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]',
            ].join(' ')}
          >
            History
          </button>
        </div>
        {/*
          The nav rail is hidden on a phone inside a session — a bottom bar
          under the composer would fight the keyboard. This row is how every
          other route stays reachable from here. Driven off NAV_TABS so it
          cannot drift out of sync with the rail.
        */}
        <nav
          aria-label="Go to"
          className="flex items-stretch gap-1 px-2 py-2 border-b border-[var(--color-border)] overflow-x-auto"
        >
          {NAV_TABS.map(({ to, label, icon: Icon }) => (
            <button
              key={to}
              type="button"
              onClick={() => {
                closeMobileNav();
                navigate(to);
              }}
              className="flex-1 min-w-[4.5rem] min-h-[52px] flex flex-col items-center justify-center gap-1 rounded-lg text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
            >
              <Icon size={18} aria-hidden="true" />
              <span className="text-[10px] font-medium leading-none">{label}</span>
            </button>
          ))}
        </nav>
        <div className="p-2">
          {mobileNavTab === 'sessions' ? (
            <SessionList
              sessions={sessions}
              activeId={id ?? null}
              onSelect={(nid) => {
                navigate(`/session/${nid}`);
                closeMobileNav();
              }}
              onNewSession={newSession.open}
            />
          ) : (
            <HistoryPanel defaultOpen onAfterResume={closeMobileNav} />
          )}
        </div>
      </BottomSheet>

      {!session && transcriptOnly && (
        <main className="flex-1 flex items-center justify-center text-[var(--color-text-dim)]">
          Loading transcript…
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
