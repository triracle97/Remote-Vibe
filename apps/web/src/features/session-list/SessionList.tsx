import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { SessionView } from '../../store/sessions';
import { SessionRenameInline } from './SessionRenameInline';

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
  const isActive = session.sessionId === activeId;
  const label = session.projectPath.split('/').filter(Boolean).pop() ?? session.projectPath;
  const badgeText =
    session.agent === 'codex'
      ? `codex${session.account ? `:${session.account}` : ''}`
      : 'claude';
  const badgeClasses =
    session.agent === 'codex'
      ? 'bg-[#2a1c44] text-[#fae]'
      : 'bg-[#1c2a44] text-[#aef]';

  return (
    <li
      className={[
        'session-row',
        isActive ? 'active' : '',
        'rounded-lg border transition-colors',
        isActive
          ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_18%,var(--color-surface))]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]',
        !session.alive ? 'opacity-60' : '',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={() => {
          onSelect(session.sessionId);
          onAfterSelect?.();
        }}
        className="w-full text-left p-3 min-h-[56px] flex flex-col gap-1"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-[var(--color-text)] truncate">{label}</span>
          <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-mono ${badgeClasses}`}>
            {badgeText}
          </span>
        </div>
        <div className="text-xs text-[var(--color-text-dim)] font-mono truncate">
          {session.projectPath}
        </div>
        {!session.alive && (
          <div className="text-[10px] text-[var(--color-warn)]">ended</div>
        )}
      </button>
      <div className="session-name-row flex items-center gap-1 px-3 pb-2">
        {renaming ? (
          <SessionRenameInline
            sessionId={session.sessionId}
            initialName={session.name ?? ''}
            onClose={() => setRenaming(false)}
          />
        ) : (
          <>
            <span
              className="session-name flex-1 text-xs text-[var(--color-text-dim)] truncate"
              title={session.name ?? session.sessionId}
            >
              {session.name
                ? truncate(session.name, 30)
                : session.sessionId.slice(0, 8)}
            </span>
            <button
              type="button"
              className="session-rename-pencil min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] rounded"
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
    <aside className="session-list w-full md:w-60 p-2 box-border flex flex-col gap-2">
      <button
        type="button"
        onClick={onNewSession}
        className="session-new w-full min-h-[44px] py-2.5 px-4 bg-[var(--color-accent)] text-white rounded-xl font-semibold flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.99] transition"
      >
        <Plus size={18} aria-hidden="true" />
        New session
      </button>
      <ul className="list-none p-0 m-0 flex flex-col gap-1.5">
        {sessions.length === 0 && (
          <li className="session-empty text-sm text-[var(--color-text-dim)] p-3 text-center">
            No active sessions
          </li>
        )}
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
