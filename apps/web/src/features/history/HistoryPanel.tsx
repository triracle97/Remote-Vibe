import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHistoryStore } from './historyStore';
import { useSessionsStore } from '../../store/sessions';
import { HistoryRow } from './HistoryRow';
import type { HistoryEntry } from '../../types/protocol';

type Tab = 'claude' | 'codex';

interface HistoryPanelProps {
  defaultOpen?: boolean;
  onAfterResume?(): void;
}

export function HistoryPanel({
  defaultOpen = false,
  onAfterResume,
}: HistoryPanelProps = {}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const [tab, setTab] = useState<Tab>('claude');
  const [resumeError, setResumeError] = useState<string | null>(null);
  const navigate = useNavigate();
  const claude = useHistoryStore((s) => s.claude);
  const codex = useHistoryStore((s) => s.codex);
  const loading = useHistoryStore((s) => s.loading);
  const fetch = useHistoryStore((s) => s.fetch);

  useEffect(() => {
    if (open) fetch();
  }, [open, fetch]);

  const onRowClick = async (entry: HistoryEntry): Promise<void> => {
    setResumeError(null);
    try {
      const webSessionId = await useSessionsStore.getState().resumeFromHistory(entry);
      navigate(`/session/${webSessionId}`);
      onAfterResume?.();
    } catch (err) {
      const e = err as { code?: string; message?: string };
      setResumeError(e.message ?? 'Resume failed');
      if (e.code === 'history_session_not_found') {
        useHistoryStore.getState().invalidate();
        useHistoryStore.getState().fetch();
      }
    }
  };

  const list = tab === 'claude' ? claude : codex;
  const visible = list.slice(0, 50);

  return (
    <div className="history-panel">
      <button
        type="button"
        className="history-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '▾' : '▸'} History
      </button>
      {open && (
        <div className="history-body">
          <div className="history-tabs">
            <button
              type="button"
              className={`history-tab ${tab === 'claude' ? 'active' : ''}`}
              onClick={() => setTab('claude')}
            >
              Claude ({claude.length})
            </button>
            <button
              type="button"
              className={`history-tab ${tab === 'codex' ? 'active' : ''}`}
              onClick={() => setTab('codex')}
            >
              Codex ({codex.length})
            </button>
          </div>
          {resumeError !== null && (
            <div className="history-error">{resumeError}</div>
          )}
          <div className="history-list">
            {loading && <div className="history-loading">Loading…</div>}
            {!loading && visible.length === 0 && (
              <div className="history-empty">No past sessions for {tab}.</div>
            )}
            {visible.map((entry: HistoryEntry) => (
              <HistoryRow
                key={`${entry.agent}-${entry.sessionId}`}
                entry={entry}
                onClick={() => void onRowClick(entry)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
