import { useEffect, useMemo } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { BridgeClient } from './services/bridge-client';
import { setBridgeClient } from './services/bridge-client-singleton';
import { useConnectionStore } from './store/connection';
import { useSessionsStore } from './store/sessions';
import { useAccountsStore } from './store/accounts';
import { usePromptHistoryStore } from './store/prompt-history';
import { useFileExplorerStore } from './store/file-explorer';
import { useHistoryStore } from './features/history/historyStore';
import { Home } from './pages/Home';
import { Session } from './pages/Session';

export function App(): JSX.Element {
  const setStatus = useConnectionStore((s) => s.setStatus);
  const setError = useConnectionStore((s) => s.setError);
  const apply = useSessionsStore((s) => s.applyServerMsg);
  const markTranscriptOnly = useSessionsStore((s) => s.markTranscriptOnly);
  const applyAccountList = useAccountsStore((s) => s.applyAccountList);

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
      if (m.type === 'error') {
        if (m.code === 'session_dead' && m.sessionId) {
          markTranscriptOnly(m.sessionId);
          // Per-session-only: do NOT raise the global error banner. The
          // sessions store's apply(m) below flips alive=false; <ResumePrompt />
          // (or the transcript-unavailable notice) renders in Session.tsx.
        } else {
          setError(`${m.code}: ${m.message}`);
        }
      } else {
        setError(null);
      }
      if (m.type === 'user') {
        client.send({ type: 'list_prompts', limit: 200 });
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

  return (
    <Routes>
      <Route path="/" element={<Home client={client} />} />
      <Route path="/session/:id" element={<Session client={client} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
