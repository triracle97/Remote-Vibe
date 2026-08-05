import { useEffect, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitBranch } from 'lucide-react';
import { useBoardStore } from './boardStore';
import { hasBridgeClient } from '../../services/bridge-client-singleton';

/**
 * "spawned: N" in the session header, listing the sessions this one started
 * through the `spawn_session` MCP tool.
 *
 * Reads the board store rather than a dedicated message: the board already
 * holds every card with its `parentSessionId`, kept current by the same live
 * stream, so a separate query would be a second source of the same truth.
 */
export function SpawnedSessionsBadge({ sessionId }: { sessionId: string }): JSX.Element | null {
  const cards = useBoardStore((s) => s.cards);
  const loaded = useBoardStore((s) => s.loaded);
  const refresh = useBoardStore((s) => s.refresh);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  // The board may never have been opened in this tab, in which case there are
  // no cards to look through. Guarded on the client existing: this badge is
  // decorative, and a header chip must not be what takes the chat down when it
  // renders before the socket is up.
  useEffect(() => {
    if (!loaded && hasBridgeClient()) refresh();
  }, [loaded, refresh]);

  const children = Object.values(cards).filter((c) => c.parentSessionId === sessionId);
  // Nothing spawned — this is the overwhelmingly common case, so render nothing
  // rather than a zero.
  if (children.length === 0) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${children.length} spawned session${children.length === 1 ? '' : 's'}`}
        data-testid="spawned-sessions-badge"
        title="Sessions this one started"
        className="flex items-center gap-1 px-2 min-h-[44px] text-[11px] tabular-nums text-[var(--color-text-dim)] hover:text-[var(--color-text)] rounded"
      >
        <GitBranch size={14} aria-hidden="true" />
        {children.length}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Spawned sessions"
          data-testid="spawned-sessions-list"
          className="absolute z-50 right-0 top-full mt-1 w-64 p-2 rounded-xl shadow-2xl bg-[var(--color-surface)] border border-[var(--color-border)]"
        >
          <ul className="list-none p-0 m-0 flex flex-col gap-1">
            {children.map((c) => (
              <li key={c.sessionId}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate(`/session/${c.sessionId}`);
                  }}
                  className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] flex flex-col gap-0.5"
                >
                  <span className="text-xs text-[var(--color-text)] truncate">
                    {c.name ?? c.sessionId.slice(0, 8)}
                  </span>
                  <span className="text-[10px] font-mono text-[var(--color-text-dim)]">
                    {c.agent}
                    {c.account ? `:${c.account}` : ''} · {c.alive ? 'live' : 'ended'} · {c.phase}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
