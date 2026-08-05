import { useEffect, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { BottomSheet } from '../../shell/BottomSheet';
import { Modal } from '../../shell/Modal';
import { SESSION_PHASE_COLUMNS, type BoardSession } from '../../types/protocol';
import { useBoardStore } from './boardStore';
import { projectLabel, timeAgo } from './cardState';
import { useSessionsStore } from '../../store/sessions';
import { SessionRenameInline } from '../session-list/SessionRenameInline';

interface Props {
  card: BoardSession | null;
  onClose: () => void;
  /** True on narrow viewports; picks sheet vs modal. */
  mobile: boolean;
}

/**
 * Everything about one card that doesn't fit on it: full paths, tag editing,
 * phase picker, and the destructive actions.
 *
 * Bottom sheet on mobile, centred modal on desktop — reusing the shell
 * primitives rather than inventing a third overlay.
 */
export function CardDetailSheet({ card, onClose, mobile }: Props): JSX.Element {
  const body = card ? <Body card={card} onClose={onClose} /> : null;
  const label = card ? `Session ${card.name ?? card.sessionId}` : 'Session details';

  return mobile ? (
    <BottomSheet open={card !== null} onClose={onClose} ariaLabel={label}>
      {body}
    </BottomSheet>
  ) : (
    <Modal open={card !== null} onClose={onClose} ariaLabel={label} maxWidthClass="max-w-lg">
      {body}
    </Modal>
  );
}

function Body({ card, onClose }: { card: BoardSession; onClose: () => void }): JSX.Element {
  const navigate = useNavigate();
  const setPhase = useBoardStore((s) => s.setPhase);
  const setTags = useBoardStore((s) => s.setTags);
  const setArchived = useBoardStore((s) => s.setArchived);
  const remove = useBoardStore((s) => s.remove);
  const resume = useSessionsStore((s) => s.resume);

  const [tagDraft, setTagDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);

  // A different card in the same overlay must not inherit the previous draft.
  useEffect(() => {
    setTagDraft('');
    setConfirmDelete(false);
    setRenaming(false);
  }, [card.sessionId]);

  const commitTag = (): void => {
    const t = tagDraft.trim();
    if (t.length === 0) return;
    if (!card.tags.includes(t)) setTags(card.sessionId, [...card.tags, t]);
    setTagDraft('');
  };

  return (
    <div className="p-4 flex flex-col gap-4">
      <header>
        {renaming ? (
          <SessionRenameInline
            sessionId={card.sessionId}
            initialName={card.name ?? ''}
            onClose={() => setRenaming(false)}
          />
        ) : (
          <div className="flex items-start gap-2">
            <h2 className="flex-1 text-base font-semibold text-[var(--color-text)] break-words">
              {card.name ?? projectLabel(card.projectPath)}
            </h2>
            <button
              type="button"
              onClick={() => setRenaming(true)}
              aria-label="Rename session"
              className="shrink-0 text-[var(--color-text-dim)] hover:text-[var(--color-text)] text-sm leading-none px-1 py-0.5"
            >
              ✏️
            </button>
          </div>
        )}
        <p className="mt-0.5 text-xs font-mono text-[var(--color-text-dim)] break-all">
          {card.projectPath}
        </p>
        <p className="mt-1 text-[11px] text-[var(--color-text-dim)]">
          {card.namePinned
            ? 'Named by you — the agent will not rename it.'
            : 'Named by the agent from its first turn. Rename to pin it.'}
        </p>
        {card.additionalDirs.length > 0 && (
          <ul className="mt-1 text-[11px] font-mono text-[var(--color-text-dim)]">
            {card.additionalDirs.map((d) => (
              <li key={d} className="break-all">
                + {d}
              </li>
            ))}
          </ul>
        )}
      </header>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <Row label="Agent" value={card.agent + (card.account ? `:${card.account}` : '')} />
        <Row label="Status" value={card.alive ? 'live' : 'ended'} />
        <Row label="Last active" value={timeAgo(card.lastActiveAt)} />
        <Row label="Created" value={new Date(card.createdAt).toLocaleString()} />
        <Row label="Headroom" value={card.headroom ? 'on' : 'off'} />
        <Row
          label="Claude config"
          value={card.claudeConfigDir ?? 'default'}
          mono
        />
      </dl>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-mute)] mb-1.5">
          Phase
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {SESSION_PHASE_COLUMNS.map((col) => {
            const on = card.phase === col.value;
            return (
              <button
                key={col.value}
                type="button"
                aria-pressed={on}
                onClick={() => setPhase(card.sessionId, col.value)}
                className="text-xs px-2.5 py-1 rounded-full border transition-colors"
                style={
                  on
                    ? {
                        color: `var(${col.token})`,
                        borderColor: `var(${col.token})`,
                        background: `color-mix(in srgb, var(${col.token}) 15%, transparent)`,
                      }
                    : { borderColor: 'var(--color-border)', color: 'var(--color-text-mute)' }
                }
              >
                {col.label}
              </button>
            );
          })}
        </div>
        {card.phasePinned && (
          <p className="mt-1.5 text-[11px] text-[var(--color-text-dim)]">
            Pinned — automatic phase detection is off for this session.
          </p>
        )}
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-mute)] mb-1.5">
          Tags
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {card.tags.map((t) => (
            <span
              key={t}
              className="text-[11px] pl-2 pr-1 py-0.5 rounded-full border border-[var(--color-border)] text-[var(--color-text-mute)] flex items-center gap-1"
            >
              {t}
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                onClick={() => setTags(card.sessionId, card.tags.filter((x) => x !== t))}
                className="hover:text-[var(--color-danger)] px-0.5 leading-none"
              >
                ×
              </button>
            </span>
          ))}
          <input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitTag();
              }
            }}
            onBlur={commitTag}
            placeholder="add tag…"
            aria-label="Add tag"
            maxLength={40}
            className="text-[11px] px-2 py-0.5 w-24 rounded-full bg-transparent border border-dashed border-[var(--color-border)] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>
      </section>

      <footer className="flex flex-wrap gap-2 pt-1">
        <Action
          primary
          onClick={() => {
            navigate(`/session/${card.sessionId}`);
            onClose();
          }}
        >
          Open
        </Action>
        {!card.alive && card.resumable && (
          <Action
            onClick={() => {
              // Resume may mint a new webSessionId (native-history path), so
              // navigate to whatever the bridge hands back, not the old id.
              void resume(card.sessionId).then(
                (id) => navigate(`/session/${id}`),
                () => {
                  /* store surfaces the error */
                },
              );
              onClose();
            }}
          >
            Resume
          </Action>
        )}
        <Action onClick={() => setArchived(card.sessionId, !card.archived)}>
          {card.archived ? 'Unarchive' : 'Archive'}
        </Action>
        <Action
          danger
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            remove(card.sessionId);
            onClose();
          }}
        >
          {confirmDelete ? 'Really delete?' : 'Delete'}
        </Action>
      </footer>
      {confirmDelete && (
        <p className="text-[11px] text-[var(--color-danger)]">
          Deletes the registry entry and its transcript. This cannot be undone.
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <>
      <dt className="text-[var(--color-text-dim)]">{label}</dt>
      <dd className={`text-[var(--color-text)] break-all ${mono ? 'font-mono text-[11px]' : ''}`}>
        {value}
      </dd>
    </>
  );
}

function Action({
  children,
  onClick,
  primary,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
}): JSX.Element {
  const tone = danger
    ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
    : primary
      ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] text-[var(--color-text)]'
      : 'border-[var(--color-border)] text-[var(--color-text-mute)]';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-sm px-3 py-1.5 rounded-lg border transition-colors hover:bg-[var(--color-surface-2)] ${tone}`}
    >
      {children}
    </button>
  );
}
