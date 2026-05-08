import { useEffect, useMemo } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { BridgeClient } from '../services/bridge-client';
import { setBridgeClient } from '../services/bridge-client-singleton';
import { useConnectionStore } from '../store/connection';
import { useSessionsStore } from '../store/sessions';
import { useAccountsStore } from '../store/accounts';
import { usePromptHistoryStore } from '../store/prompt-history';
import { useFileExplorerStore } from '../store/file-explorer';
import { useHistoryStore } from '../features/history/historyStore';
import { useProfileStore } from '../features/profiles/profileStore';
import { useSlashCommandStore } from '../features/chat/slashCommandStore';
import { useFileSearchStore } from '../features/chat/fileSearchStore';
import { ThemeProvider } from './ThemeProvider';
import { NavRail } from './NavRail';
import { ViewTransition } from './ViewTransition';

export function AppShell(): JSX.Element {
  const setStatus = useConnectionStore((s) => s.setStatus);
  const setError = useConnectionStore((s) => s.setError);
  const apply = useSessionsStore((s) => s.applyServerMsg);
  const markTranscriptOnly = useSessionsStore((s) => s.markTranscriptOnly);
  const applyAccountList = useAccountsStore((s) => s.applyAccountList);
  const location = useLocation();

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
        if (m.code === 'session_dead' && m.sessionId) {
          markTranscriptOnly(m.sessionId);
        } else {
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

  const onSessionPage = location.pathname.startsWith('/session/');

  return (
    <ThemeProvider>
      <div className="flex flex-col md:flex-row h-[100dvh] bg-[var(--color-bg)] text-[var(--color-text)]">
        <div className={onSessionPage ? 'hidden md:flex' : 'order-last md:order-first flex'}>
          <NavRail />
        </div>
        <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <ViewTransition>
            <Outlet context={{ client }} />
          </ViewTransition>
        </main>
      </div>
    </ThemeProvider>
  );
}

export type AppShellOutletContext = { client: BridgeClient };
