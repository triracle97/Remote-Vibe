import { useState, type JSX } from 'react';
import { Menu, Folder, Search, PanelRight, MoreHorizontal, Pencil } from 'lucide-react';
import type { SessionView } from '../../store/sessions';
import { SessionRenameInline } from '../session-list/SessionRenameInline';
import { SessionUsageBadge } from '../usage/SessionUsageBadge';
import { SpawnedSessionsBadge } from '../board/SpawnedSessionsBadge';
import { SessionModelSwitch } from '../model-picker/SessionModelSwitch';
import { RunningWorkBadge } from '../transcript/RunningWorkBadge';
import type { RunningWork } from '../transcript/runningWork';
import { BottomSheet } from '../../shell/BottomSheet';
import { useIsDesktop } from '../../shell/useIsDesktop';

/**
 * The session header.
 *
 * It had grown to eleven controls in a single non-wrapping row — hamburger,
 * project path, name, rename, running-work, model, spawned, usage, search,
 * outline, files — which fits a laptop and runs straight off the side of a
 * phone. The controls on the right simply became unreachable.
 *
 * So the two widths get different structures rather than the same row squeezed:
 *
 * - **Desktop** keeps everything inline. There is room, and one click beats two.
 * - **Mobile** shows only what you need at a glance — where you are, and
 *   whether anything is still running — and moves the rest behind an overflow
 *   sheet. The name doubles as the rename control there, since a 44px pencil
 *   next to it is a target competing for the same space it is labelling.
 */

export interface SessionHeaderProps {
  session: SessionView;
  background: RunningWork;
  searchOpen: boolean;
  onToggleSearch(): void;
  sidebarOpen: boolean;
  onToggleSidebar(): void;
  drawerOpen?: boolean | undefined;
  onToggleDrawer?: (() => void) | undefined;
  onOpenMobileNav?: ((opener?: HTMLElement) => void) | undefined;
}

export function SessionHeader({
  session,
  background,
  searchOpen,
  onToggleSearch,
  sidebarOpen,
  onToggleSidebar,
  drawerOpen,
  onToggleDrawer,
  onOpenMobileNav,
}: SessionHeaderProps): JSX.Element {
  const isDesktop = useIsDesktop();
  const [renaming, setRenaming] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const title = session.name ?? session.sessionId.slice(0, 8);

  if (isDesktop) {
    return (
      <header className="chat-header flex items-center gap-2 px-3 py-2 min-h-[3rem] bg-[var(--color-surface)] border-b border-[var(--color-border)]">
        <code className="text-xs text-[var(--color-text-dim)] font-mono truncate min-w-0 flex-1">
          {session.projectPath}
        </code>
        {renaming ? (
          <SessionRenameInline
            sessionId={session.sessionId}
            initialName={session.name ?? ''}
            onClose={() => setRenaming(false)}
          />
        ) : (
          <>
            <span className="session-header-name text-[var(--color-text-mute)] text-xs whitespace-nowrap overflow-hidden text-ellipsis max-w-[14rem]">
              {title}
            </span>
            <button
              type="button"
              className="session-rename-pencil session-header-pencil min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] rounded"
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(true);
              }}
              aria-label="Rename session"
            >
              <Pencil size={15} aria-hidden="true" />
            </button>
          </>
        )}
        <RunningWorkBadge work={background} />
        <SessionModelSwitch sessionId={session.sessionId} agent={session.agent} />
        <SpawnedSessionsBadge sessionId={session.sessionId} />
        <SessionUsageBadge sessionId={session.sessionId} />
        <IconButton
          label="Find in transcript"
          pressed={searchOpen}
          onClick={onToggleSearch}
          icon={<Search size={18} aria-hidden="true" />}
        />
        <IconButton
          label="Toggle transcript outline"
          pressed={sidebarOpen}
          onClick={onToggleSidebar}
          icon={<PanelRight size={18} aria-hidden="true" />}
        />
        {onToggleDrawer && (
          <IconButton
            label="Toggle file explorer"
            className="chat-drawer-toggle"
            pressed={drawerOpen ?? false}
            onClick={onToggleDrawer}
            icon={<Folder size={18} aria-hidden="true" />}
          />
        )}
      </header>
    );
  }

  return (
    <>
      <header className="chat-header flex items-center gap-1 px-2 py-2 min-h-[3rem] bg-[var(--color-surface)] border-b border-[var(--color-border)]">
        {onOpenMobileNav && (
          <button
            type="button"
            className="chat-mobile-menu inline-flex items-center justify-center min-w-[44px] min-h-[44px] shrink-0 text-[var(--color-text-dim)] hover:text-[var(--color-text)] rounded"
            onClick={(event) => onOpenMobileNav(event.currentTarget)}
            aria-label="Open sessions and history"
          >
            <Menu size={20} aria-hidden="true" />
          </button>
        )}

        {renaming ? (
          <div className="flex-1 min-w-0">
            <SessionRenameInline
              sessionId={session.sessionId}
              initialName={session.name ?? ''}
              onClose={() => setRenaming(false)}
            />
          </div>
        ) : (
          // The title is the rename affordance. A separate pencil would cost
          // another 44px of a row that has none to give.
          <button
            type="button"
            onClick={() => setRenaming(true)}
            className="session-header-name flex-1 min-w-0 text-left px-1 py-1 rounded hover:bg-[var(--color-surface-2)]"
            aria-label={`Rename session: ${title}`}
          >
            <span className="block text-sm text-[var(--color-text)] truncate">{title}</span>
            <span className="block text-[10px] font-mono text-[var(--color-text-dim)] truncate">
              {session.projectPath}
            </span>
          </button>
        )}

        {/* Compact, because "is anything still running" is the one status worth
            a permanent slot — everything else can live one tap away. */}
        <RunningWorkBadge work={background} compact />

        <button
          type="button"
          onClick={() => setOverflowOpen(true)}
          aria-label="More session actions"
          data-testid="session-overflow-trigger"
          className="min-w-[44px] min-h-[44px] shrink-0 flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] rounded"
        >
          <MoreHorizontal size={20} aria-hidden="true" />
        </button>
      </header>

      <BottomSheet
        open={overflowOpen}
        onClose={() => setOverflowOpen(false)}
        ariaLabel="Session actions"
        maxHeight="70dvh"
      >
        <div className="p-3 flex flex-col gap-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)] truncate">{title}</div>
            <code className="block text-[11px] font-mono text-[var(--color-text-dim)] truncate">
              {session.projectPath}
            </code>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <SessionModelSwitch sessionId={session.sessionId} agent={session.agent} />
            <SpawnedSessionsBadge sessionId={session.sessionId} />
            <SessionUsageBadge sessionId={session.sessionId} />
          </div>

          <ul className="list-none p-0 m-0 flex flex-col gap-1">
            <SheetAction
              label="Rename session"
              icon={<Pencil size={16} aria-hidden="true" />}
              onClick={() => {
                setOverflowOpen(false);
                setRenaming(true);
              }}
            />
            <SheetAction
              label="Find in transcript"
              icon={<Search size={16} aria-hidden="true" />}
              pressed={searchOpen}
              onClick={() => {
                setOverflowOpen(false);
                onToggleSearch();
              }}
            />
            <SheetAction
              label="Toggle transcript outline"
              icon={<PanelRight size={16} aria-hidden="true" />}
              pressed={sidebarOpen}
              onClick={() => {
                setOverflowOpen(false);
                onToggleSidebar();
              }}
            />
            {onToggleDrawer && (
              <SheetAction
                label="Toggle file explorer"
                icon={<Folder size={16} aria-hidden="true" />}
                pressed={drawerOpen ?? false}
                onClick={() => {
                  setOverflowOpen(false);
                  onToggleDrawer();
                }}
              />
            )}
          </ul>
        </div>
      </BottomSheet>
    </>
  );
}

function IconButton({
  label,
  icon,
  onClick,
  pressed,
  className = '',
}: {
  label: string;
  icon: JSX.Element;
  onClick(): void;
  pressed?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`min-w-[44px] min-h-[44px] shrink-0 flex items-center justify-center rounded text-[var(--color-text-dim)] hover:text-[var(--color-text)] ${
        pressed ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]' : ''
      } ${className}`}
      onClick={onClick}
      aria-label={label}
      {...(pressed !== undefined ? { 'aria-pressed': pressed ? 'true' : 'false' } : {})}
    >
      {icon}
    </button>
  );
}

function SheetAction({
  label,
  icon,
  onClick,
  pressed,
}: {
  label: string;
  icon: JSX.Element;
  onClick(): void;
  pressed?: boolean;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        {...(pressed !== undefined ? { 'aria-pressed': pressed ? 'true' : 'false' } : {})}
        className="w-full min-h-[48px] px-3 flex items-center gap-3 rounded-lg text-left text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
      >
        <span className="text-[var(--color-text-dim)] shrink-0">{icon}</span>
        <span className="flex-1">{label}</span>
        {pressed && <span className="text-[10px] text-[var(--color-accent)]">on</span>}
      </button>
    </li>
  );
}
