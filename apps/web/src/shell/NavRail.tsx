import { NavLink } from 'react-router-dom';
import { UsageIndicator } from '../features/usage/UsageIndicator';
import {
  Home as HomeIcon,
  FolderIcon,
  KanbanSquare,
  Settings as SettingsIcon,
} from 'lucide-react';

/**
 * The primary navigation.
 *
 * Exported because the session page's mobile sheet renders the same set — on a
 * phone the rail is hidden inside a session, and a second hand-maintained copy
 * of this list is exactly how a route goes missing from one of them.
 *
 * `/sessions` is deliberately absent. Board is a strict superset of it — every
 * session grouped by phase, with filters and jobs, rather than a flat
 * alive-only list — and Home already previews the live ones. The route still
 * resolves and is reached from Home's "See all"; it just does not earn a tab,
 * and four tabs give each roughly a quarter more width on a phone.
 */
export const NAV_TABS = [
  { to: '/', label: 'Home', icon: HomeIcon },
  { to: '/board', label: 'Board', icon: KanbanSquare },
  { to: '/projects', label: 'Projects', icon: FolderIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

export function NavRail(): JSX.Element {
  return (
    <nav
      aria-label="Primary"
      className="
        w-full shrink-0
        bg-[var(--color-surface)] border-t border-[var(--color-border)]
        py-1 px-1 pb-[max(env(safe-area-inset-bottom),0.25rem)]
        grid grid-cols-[repeat(4,minmax(0,1fr))_2.5rem] items-center
        md:flex md:flex-col md:justify-start md:items-stretch
        md:py-3 md:px-0 md:border-t-0 md:border-r md:gap-1 md:w-16 md:h-screen
      "
    >
      {NAV_TABS.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) =>
            [
              'flex flex-col items-center justify-center gap-0.5 transition-colors',
              // Equal grid tracks already size these; `min-w-0` is what lets the
              // label truncate instead of forcing the track wider than 1fr.
              'min-w-0 px-0.5 min-h-[52px] md:min-h-[60px] md:gap-1 md:py-1',
              isActive
                ? 'text-[var(--color-accent)]'
                : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]',
            ].join(' ')
          }
          aria-label={label}
        >
          <Icon size={20} aria-hidden="true" className="shrink-0 md:w-[22px] md:h-[22px]" />
          <span className="text-[10px] font-medium leading-none truncate max-w-full">{label}</span>
        </NavLink>
      ))}
      {/*
        Quota ring. Given its own fixed track rather than sharing the routes'
        `1fr` columns: it renders nothing until a turn reports usage, and a cell
        that collapses would resize every tab the first time a turn lands. The
        track is reserved whether or not the ring is there.
      */}
      <div className="flex items-center justify-center md:mt-auto md:pb-1">
        <UsageIndicator />
      </div>
    </nav>
  );
}
