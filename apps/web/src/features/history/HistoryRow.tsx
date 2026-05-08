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
      className="history-row"
      onClick={onClick}
      title={tooltip}
    >
      <span className="history-row-project">{basenameSafe(entry.projectPath)}</span>
      <span className="history-row-prompt">{entry.firstPrompt || '(no prompt)'}</span>
      <span className="history-row-time">{relativeTime(entry.mtime)}</span>
    </button>
  );
}
