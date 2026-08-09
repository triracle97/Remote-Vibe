import { useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BridgeClient } from '../services/bridge-client';
import { setBridgeClient } from '../services/bridge-client-singleton';
import { useConnectionStore } from '../store/connection';
import { useSessionsStore } from '../store/sessions';
import { useAccountsStore } from '../store/accounts';
import { usePromptHistoryStore } from '../store/prompt-history';
import { useFileExplorerStore } from '../store/file-explorer';
import { useHistoryStore } from '../features/history/historyStore';
import { useProfileStore } from '../features/profiles/profileStore';
import { useProjectsStore } from '../features/projects/projectsStore';
import { useSlashCommandStore } from '../features/chat/slashCommandStore';
import { useFileSearchStore } from '../features/chat/fileSearchStore';
import { useTerminalsStore } from '../store/terminals';
import { useBoardStore } from '../features/board/boardStore';
import { useJobsStore } from '../features/board/jobsStore';
import { useUsageStore } from '../store/usage';
import { ThemeProvider } from './ThemeProvider';
import { NavRail } from './NavRail';
import { ViewTransition } from './ViewTransition';
import { CommandPalette, ShortcutHelp } from './CommandPalette';
import { useGlobalShortcuts, type ShortcutHandlers } from './useGlobalShortcuts';
import { useNewSession } from '../features/project-picker/useNewSession';

export function AppShell(): JSX.Element {
  const setStatus = useConnectionStore((s) => s.setStatus);
  const setError = useConnectionStore((s) => s.setError);
  const apply = useSessionsStore((s) => s.applyServerMsg);
  const markTranscriptOnly = useSessionsStore((s) => s.markTranscriptOnly);
  const applyAccountList = useAccountsStore((s) => s.applyAccountList);
  const location = useLocation();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const client = useMemo(() => new BridgeClient(), []);

  useEffect(() => {
    setBridgeClient(client);
  }, [client]);

  useEffect(() => {
    const offOpen = client.on('open', () => {
      setStatus('open');
      client.send({ type: 'list_sessions' });
      client.send({ type: 'list_accounts' });
      client.send({ type: 'list_prompts', limit: 200 });
      client.send({ type: 'get_rate_limits' });
      // Board cards track turn state from broadcasts, and a disconnected client
      // misses them — so re-fetch the snapshot rather than leave a card frozen
      // in whatever state it was in when the socket dropped.
      if (useBoardStore.getState().loaded) useBoardStore.getState().refresh();
      const { sessions } = useSessionsStore.getState();
      for (const id of Object.keys(sessions)) {
        const s = sessions[id];
        if (s && s.alive) {
          client.send({ type: 'get_history', sessionId: id, since: s.lastSeq });
        }
      }
    });
    const offClose = client.on('close', () => setStatus('closed'));
    const offError = client.on('error', (e) => {
      setStatus('error');
      setError(e.message);
    });
    const offMessage = client.on('message', (m) => {
      if (m.type === 'system' && m.event === 'init') {
        useConnectionStore.getState().setCapabilities(m.capabilities ?? { terminal: false });
        useConnectionStore.getState().setAllowedDirs(m.allowedDirs ?? []);
        // Don't return — fall through to existing handling.
      }
      if (m.type === 'account_list') {
        applyAccountList(m.accounts);
        return;
      }
      if (m.type === 'prompts_result') {
        usePromptHistoryStore.getState().applyPromptsResult(m.prompts);
        return;
      }
      if (m.type === 'dirs_result') {
        useFileExplorerStore.getState().applyDirsResult(m);
        return;
      }
      if (m.type === 'file_result') {
        useFileExplorerStore.getState().applyFileResult(m);
        return;
      }
      if (m.type === 'file_written') {
        useFileExplorerStore.getState().applyFileWritten(m);
        return;
      }
      if (m.type === 'history_list') {
        useHistoryStore.getState().applyServerMsg(m);
        return;
      }
      if (
        m.type === 'profile_list' ||
        m.type === 'profile_saved' ||
        m.type === 'profile_deleted' ||
        m.type === 'profile_default_set'
      ) {
        useProfileStore.getState().applyServerMsg(m);
        return;
      }
      if (m.type === 'slash_commands_list') {
        useSlashCommandStore.getState().applyServerMsg(m);
        return;
      }
      if (m.type === 'file_search_results') {
        useFileSearchStore.getState().applyServerMsg(m);
        return;
      }
      if (m.type === 'error') {
        // A failed save is shown next to the save button, not in the global
        // banner — the user is looking at the editor, not the shell.
        const claimedByEditor = useFileExplorerStore.getState().applyServerError(m);
        if (m.code === 'session_dead' && m.sessionId) {
          markTranscriptOnly(m.sessionId);
        } else if (!claimedByEditor) {
          setError(`${m.code}: ${m.message}`);
        }
      } else {
        setError(null);
      }
      if (m.type === 'user') {
        client.send({ type: 'list_prompts', limit: 200 });
      }
      if (m.type === 'error') {
        useProfileStore.getState().applyServerMsg(m);
      }
      apply(m);
      useTerminalsStore.getState().applyServerMsg(m);
      // Board tracks the same live stream so cards update without a poll.
      useBoardStore.getState().applyServerMsg(m);
      useJobsStore.getState().applyServerMsg(m);
      useUsageStore.getState().applyServerMsg(m);
    });

    client.connect();

    return () => {
      offOpen();
      offClose();
      offError();
      offMessage();
      client.close();
    };
  }, [client, setStatus, setError, apply, markTranscriptOnly, applyAccountList]);

  useEffect(() => {
    const unsub = useSessionsStore.subscribe((state) => {
      const projectStore = useProjectsStore.getState();
      for (const s of Object.values(state.sessions)) {
        if (s && s.projectPath) projectStore.add(s.projectPath);
      }
    });
    return () => unsub();
  }, []);

  const newSession = useNewSession(client);

  /**
   * Live sessions in sidebar order — the list every switching shortcut indexes
   * into, so ⌃1 and the palette agree on what "the first session" means.
   */
  const runningSessionIds = useSessionsStore((s) =>
    s.order.filter((id) => s.sessions[id]?.alive),
  );

  const stepSession = useCallback(
    (delta: number) => {
      if (runningSessionIds.length === 0) return;
      const current = location.pathname.startsWith('/session/')
        ? location.pathname.slice('/session/'.length)
        : null;
      const at = current ? runningSessionIds.indexOf(current) : -1;
      // Wrap, and treat "not currently in a session" as starting before the
      // first one so a single press lands somewhere useful.
      const next =
        (at + delta + runningSessionIds.length) % runningSessionIds.length;
      const target = runningSessionIds[at === -1 && delta < 0 ? runningSessionIds.length - 1 : next];
      if (target) navigate(`/session/${target}`);
    },
    [runningSessionIds, location.pathname, navigate],
  );

  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      palette: () => {
        setHelpOpen(false);
        setPaletteOpen((o) => !o);
      },
      help: () => {
        setPaletteOpen(false);
        setHelpOpen((o) => !o);
      },
      'next-session': () => stepSession(1),
      'prev-session': () => stepSession(-1),
      'jump-session': (index) => {
        const target = runningSessionIds[(index ?? 1) - 1];
        if (target) navigate(`/session/${target}`);
      },
      'new-session': () => newSession.open(),
      'toggle-files': () => {
        // Owned by the session page; broadcast so it can react without the
        // shell needing a handle on it.
        window.dispatchEvent(new CustomEvent('mrt:toggle-file-drawer'));
      },
      'focus-input': () => {
        const el = document.querySelector<HTMLTextAreaElement>('.chat textarea');
        el?.focus();
      },
    }),
    [stepSession, runningSessionIds, navigate, newSession],
  );

  useGlobalShortcuts(shortcutHandlers);

  const onSessionPage = location.pathname.startsWith('/session/');

  return (
    <ThemeProvider>
      <div className="flex flex-col md:flex-row h-full bg-[var(--color-bg)] text-[var(--color-text)]">
        <div className={onSessionPage ? 'hidden md:flex' : 'order-last md:order-first flex'}>
          <NavRail />
        </div>
        <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <ViewTransition>
            <Outlet context={{ client }} />
          </ViewTransition>
        </main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNewSession={() => newSession.open()}
      />
      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      {newSession.pickerNode}
    </ThemeProvider>
  );
}

export type AppShellOutletContext = { client: BridgeClient };
