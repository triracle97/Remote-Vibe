import type { SessionView } from '../../store/sessions';
import './SessionList.css';

interface SessionListProps {
  sessions: SessionView[];
  activeId: string | null;
  onSelect(id: string): void;
  onNewSession(): void;
}

export function SessionList({ sessions, activeId, onSelect, onNewSession }: SessionListProps): JSX.Element {
  return (
    <aside className="session-list">
      <button className="session-new" type="button" onClick={onNewSession}>
        + New session
      </button>
      <ul>
        {sessions.length === 0 && <li className="session-empty">No active sessions</li>}
        {sessions.map((s) => {
          const label = s.projectPath.split('/').filter(Boolean).pop() ?? s.projectPath;
          const badge =
            s.agent === 'codex'
              ? `codex${s.account ? `:${s.account}` : ''}`
              : 'claude';
          return (
            <li
              key={s.sessionId}
              className={`session-row${s.sessionId === activeId ? ' active' : ''}${!s.alive ? ' ended' : ''}`}
            >
              <button type="button" onClick={() => onSelect(s.sessionId)}>
                <div className="session-label">
                  {label} <span className={`session-badge agent-${s.agent}`}>{badge}</span>
                </div>
                <div className="session-path">{s.projectPath}</div>
                {!s.alive && <div className="session-ended">ended</div>}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
