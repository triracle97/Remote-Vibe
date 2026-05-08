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
    <div className="history-panel border-t border-[var(--color-border)] px-2 py-1.5 max-md:border-t-0 max-md:border-b max-md:px-2 max-md:py-2 max-md:w-full max-md:box-border">
      <button
        type="button"
        className="history-toggle bg-transparent text-[var(--color-text-mute)] border-0 px-0 py-1 text-xs cursor-pointer uppercase tracking-wider hover:text-[var(--color-text)] max-md:min-h-[36px] max-md:w-full max-md:text-left"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '▾' : '▸'} History
      </button>
      {open && (
        <div className="history-body mt-1.5">
          <div className="history-tabs flex gap-1 mb-1.5">
            <button
              type="button"
              className={`history-tab flex-1 px-2 py-1.5 text-xs cursor-pointer rounded border max-md:min-h-[36px] ${
                tab === 'claude'
                  ? 'active bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]'
                  : 'bg-[var(--color-surface)] text-[var(--color-text-mute)] border-[var(--color-border)] hover:bg-[var(--color-surface-2)]'
              }`}
              onClick={() => setTab('claude')}
            >
              Claude ({claude.length})
            </button>
            <button
              type="button"
              className={`history-tab flex-1 px-2 py-1.5 text-xs cursor-pointer rounded border max-md:min-h-[36px] ${
                tab === 'codex'
                  ? 'active bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]'
                  : 'bg-[var(--color-surface)] text-[var(--color-text-mute)] border-[var(--color-border)] hover:bg-[var(--color-surface-2)]'
              }`}
              onClick={() => setTab('codex')}
            >
              Codex ({codex.length})
            </button>
          </div>
          {resumeError !== null && (
            <div className="history-error text-[var(--color-danger)] bg-[color-mix(in_srgb,var(--color-danger)_18%,var(--color-surface))] border border-[color-mix(in_srgb,var(--color-danger)_30%,var(--color-border))] rounded px-2 py-1 mb-1.5 text-xs">{resumeError}</div>
          )}
          <div className="history-list max-h-[40vh] overflow-y-auto max-md:max-h-[28dvh]">
            {loading && <div className="history-loading text-[var(--color-text-dim)] px-1 py-2 text-xs text-center">Loading…</div>}
            {!loading && visible.length === 0 && (
              <div className="history-empty text-[var(--color-text-dim)] px-1 py-2 text-xs text-center">No past sessions for {tab}.</div>
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
