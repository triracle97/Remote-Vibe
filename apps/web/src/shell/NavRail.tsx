import { NavLink } from 'react-router-dom';
import { Home as HomeIcon, Code, FolderIcon, Settings as SettingsIcon } from 'lucide-react';

const tabs = [
  { to: '/', label: 'Home', icon: HomeIcon },
  { to: '/sessions', label: 'Sessions', icon: Code },
  { to: '/projects', label: 'Projects', icon: FolderIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

export function NavRail(): JSX.Element {
  return (
    <nav
      aria-label="Primary"
      className="
        flex items-center justify-around
        bg-[var(--color-surface)] border-t border-[var(--color-border)]
        py-2 px-4 shrink-0 pb-[max(env(safe-area-inset-bottom),0.5rem)]
        md:flex-col md:justify-start md:items-stretch md:py-3 md:px-0
        md:border-t-0 md:border-r md:gap-1 md:w-16 md:h-screen
      "
    >
      {tabs.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) =>
            [
              'flex flex-col items-center gap-1 transition-colors min-h-[56px] md:min-h-[60px] justify-center md:py-1',
              isActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]',
            ].join(' ')
          }
          aria-label={label}
        >
          <Icon size={22} aria-hidden="true" />
          <span className="text-[10px] font-medium">{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
