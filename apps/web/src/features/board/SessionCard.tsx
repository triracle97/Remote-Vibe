import type { DragEvent, JSX } from 'react';
import { modelLabel } from '../../types/protocol';
import type { BoardSession } from '../../types/protocol';
import { cardTint, cardVisualState, projectLabel, timeAgo } from './cardState';

interface Props {
  card: BoardSession;
  onOpen: (card: BoardSession) => void;
  onDetails: (card: BoardSession) => void;
  onDragStart: (card: BoardSession, e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  dragging: boolean;
}

/**
 * One session on the board.
 *
 * Drag uses native HTML5 events rather than a DnD library — that's what
 * nimbalyst's own tracker boards do, and it keeps the bundle unchanged.
 */
export function SessionCard({
  card,
  onOpen,
  onDetails,
  onDragStart,
  onDragEnd,
  dragging,
}: Props): JSX.Element {
  const state = cardVisualState(card, { processing: card.alive });
  const title = card.name ?? projectLabel(card.projectPath);

  return (
    <article
      data-testid="board-card"
      data-session-id={card.sessionId}
      draggable
      onDragStart={(e) => onDragStart(card, e)}
      onDragEnd={onDragEnd}
      className={[
        'group rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]',
        'p-3 cursor-grab active:cursor-grabbing transition-colors',
        'hover:bg-[var(--color-surface-2)]',
        dragging ? 'opacity-40' : '',
        !card.alive ? 'opacity-75' : '',
      ].join(' ')}
      style={cardTint(state)}
    >
      <button
        type="button"
        onClick={() => onOpen(card)}
        className="w-full text-left"
        title={card.projectPath}
      >
        <div className="flex items-start gap-2">
          <span className="flex-1 min-w-0 font-semibold text-[var(--color-text)] text-sm leading-snug line-clamp-2">
            {title}
          </span>
          {state.badgeLabel !== null && (
            <span
              className="shrink-0 flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full"
              style={{
                color: `var(${state.token})`,
                background: `color-mix(in srgb, var(${state.token}) 15%, transparent)`,
              }}
            >
              <span
                aria-hidden
                className={[
                  'inline-block w-1.5 h-1.5 rounded-full',
                  state.spin ? 'animate-pulse' : '',
                ].join(' ')}
                style={{ background: `var(${state.token})` }}
              />
              {state.badgeLabel}
            </span>
          )}
        </div>

        <div className="mt-1.5 text-[11px] font-mono text-[var(--color-text-dim)] truncate">
          {projectLabel(card.projectPath)}
        </div>

        {/* Agent-spawned cards appear without the user doing anything, so say
            where they came from. Only rendered when there is a parent. */}
        {card.parentSessionId && (
          <div
            className="mt-1 text-[11px] text-[var(--color-text-dim)] truncate"
            title={`Spawned by session ${card.parentSessionId}`}
          >
            ↳ spawned by{' '}
            <span className="text-[var(--color-text-mute)]">
              {card.parentName ?? card.parentSessionId.slice(0, 8)}
            </span>
          </div>
        )}
      </button>

      <div className="mt-2 flex items-center gap-1 flex-wrap">
        <AgentBadge card={card} />
        {card.headroom && (
          <Chip title="Routed through the Headroom proxy" tone="var(--color-success)">
            HR
          </Chip>
        )}
        {card.claudeConfigDir !== null && (
          <Chip title={`CLAUDE_CONFIG_DIR=${card.claudeConfigDir}`} tone="var(--color-accent)">
            {configLabel(card.claudeConfigDir)}
          </Chip>
        )}
        {card.model !== null && (
          <Chip title={`Model: ${card.model}`} tone="var(--color-phase-planning)">
            {modelLabel(card.agent, card.model)}
          </Chip>
        )}
        {card.effort !== null && (
          <Chip title={`Reasoning effort: ${card.effort}`} tone="var(--color-phase-implementing)">
            {card.effort}
          </Chip>
        )}
        {card.tags.map((t) => (
          <Chip key={t} tone="var(--color-text-mute)">
            {t}
          </Chip>
        ))}
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-[10px] text-[var(--color-text-dim)] tabular-nums">
            {timeAgo(card.lastActiveAt)}
          </span>
          <button
            type="button"
            onClick={() => onDetails(card)}
            aria-label={`Details for ${title}`}
            className="text-[var(--color-text-dim)] hover:text-[var(--color-text)] px-1 leading-none text-sm"
          >
            ⋯
          </button>
        </span>
      </div>
    </article>
  );
}

function AgentBadge({ card }: { card: BoardSession }): JSX.Element {
  const text =
    card.agent === 'codex' ? `codex${card.account ? `:${card.account}` : ''}` : 'claude';
  const classes =
    card.agent === 'codex' ? 'bg-[#2a1c44] text-[#ffaaee]' : 'bg-[#1c2a44] text-[#aaeeff]';
  return (
    <span className={`${classes} text-[10px] font-medium px-1.5 py-0.5 rounded`}>{text}</span>
  );
}

function Chip({
  children,
  tone,
  title,
}: {
  children: React.ReactNode;
  tone: string;
  title?: string;
}): JSX.Element {
  return (
    <span
      title={title}
      className="text-[10px] px-1.5 py-0.5 rounded border"
      style={{
        color: tone,
        background: `color-mix(in srgb, ${tone} 12%, transparent)`,
        borderColor: `color-mix(in srgb, ${tone} 30%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

/** `/Users/me/.claude1` → `.claude1`; the tail is the part that distinguishes profiles. */
function configLabel(dir: string): string {
  return dir.split('/').filter(Boolean).pop() ?? dir;
}
