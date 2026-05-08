import type { HistoryEntry } from '../../types/protocol';

interface HistoryRowProps {
  entry: HistoryEntry;
  onClick: () => void;
}

function relativeTime(mtime: number): string {
  const ms = Date.now() - mtime;
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(mtime).toLocaleDateString();
}

function basenameSafe(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function HistoryRow({ entry, onClick }: HistoryRowProps): JSX.Element {
  const tooltip = `${entry.projectPath}\n${entry.firstPrompt}\n${new Date(entry.mtime).toISOString()}`;
  return (
    <button
      type="button"
      className="history-row flex flex-col gap-0.5 w-full px-3 py-2 min-h-[44px] md:min-h-[36px] mb-0.5 bg-transparent text-[var(--color-text)] border border-transparent rounded text-[13px] text-left cursor-pointer hover:bg-[var(--color-surface)] hover:border-[var(--color-border)]"
      onClick={onClick}
      title={tooltip}
    >
      <span className="history-row-project text-[var(--color-accent)] font-medium">{basenameSafe(entry.projectPath)}</span>
      <span className="history-row-prompt text-[var(--color-text-mute)] overflow-hidden text-ellipsis whitespace-nowrap">{entry.firstPrompt || '(no prompt)'}</span>
      <span className="history-row-time text-[var(--color-text-dim)] text-xs">{relativeTime(entry.mtime)}</span>
    </button>
  );
}
