import { useState } from 'react';
import type { SessionView } from '../../store/sessions';
import { SessionRenameInline } from './SessionRenameInline';
import './SessionList.css';

interface SessionListProps {
  sessions: SessionView[];
  activeId: string | null;
  onSelect(id: string): void;
  onNewSession(): void;
  onAfterSelect?(): void;
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen)}…`;
}

function SessionRow({
  session,
  activeId,
  onSelect,
  onAfterSelect,
}: {
  session: SessionView;
  activeId: string | null;
  onSelect: (id: string) => void;
  onAfterSelect?: (() => void) | undefined;
}): JSX.Element {
  const [renaming, setRenaming] = useState(false);

  const label = session.projectPath.split('/').filter(Boolean).pop() ?? session.projectPath;
  const badge =
    session.agent === 'codex'
      ? `codex${session.account ? `:${session.account}` : ''}`
      : 'claude';

  return (
    <li
      className={`session-row${session.sessionId === activeId ? ' active' : ''}${!session.alive ? ' ended' : ''}`}
    >
      <button
        type="button"
        onClick={() => {
          onSelect(session.sessionId);
          onAfterSelect?.();
        }}
      >
        <div className="session-label">
          {label} <span className={`session-badge agent-${session.agent}`}>{badge}</span>
        </div>
        <div className="session-path">{session.projectPath}</div>
        {!session.alive && <div className="session-ended">ended</div>}
      </button>
      <div className="session-name-row">
        {renaming ? (
          <SessionRenameInline
            sessionId={session.sessionId}
            initialName={session.name ?? ''}
            onClose={() => setRenaming(false)}
          />
        ) : (
          <>
            <span
              className="session-name"
              title={session.name ?? session.sessionId}
            >
              {session.name
                ? truncate(session.name, 30)
                : session.sessionId.slice(0, 8)}
            </span>
            <button
              type="button"
              className="session-rename-pencil"
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(true);
              }}
              aria-label="Rename session"
            >
              ✏️
            </button>
          </>
        )}
      </div>
    </li>
  );
}

export function SessionList({
  sessions,
  activeId,
  onSelect,
  onNewSession,
  onAfterSelect,
}: SessionListProps): JSX.Element {
  return (
    <aside className="session-list">
      <button className="session-new" type="button" onClick={onNewSession}>
        + New session
      </button>
      <ul>
        {sessions.length === 0 && <li className="session-empty">No active sessions</li>}
        {sessions.map((s) => (
          <SessionRow
            key={s.sessionId}
            session={s}
            activeId={activeId}
            onSelect={onSelect}
            onAfterSelect={onAfterSelect}
          />
        ))}
      </ul>
    </aside>
  );
}
