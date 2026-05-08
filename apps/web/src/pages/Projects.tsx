import { useOutletContext } from 'react-router-dom';
import { Plus, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import type { AppShellOutletContext } from '../shell/AppShell';
import { useProjectsStore } from '../features/projects/projectsStore';
import { useNewSession } from '../features/project-picker/useNewSession';

export function Projects(): JSX.Element {
  const { client } = useOutletContext<AppShellOutletContext>();
  const paths = useProjectsStore((s) => s.paths);
  const remove = useProjectsStore((s) => s.remove);
  const move = useProjectsStore((s) => s.move);
  const newSession = useNewSession(client);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 max-w-screen-md w-full mx-auto">
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase">Projects</h2>
        <button
          type="button"
          onClick={newSession.open}
          className="flex items-center gap-1 text-xs px-3 py-2 min-h-[36px] rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90"
        >
          <Plus size={14} aria-hidden="true" />
          Add Project
        </button>
      </div>

      {paths.length === 0 ? (
        <div className="bg-[color-mix(in_srgb,var(--color-surface-2)_50%,transparent)] border border-[var(--color-border)] rounded-xl py-6 px-6 text-[var(--color-text-dim)] text-center">
          No projects yet. Tap &ldquo;Add Project&rdquo; to start a new session.
        </div>
      ) : (
        <ul className="list-none p-0 m-0 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl divide-y divide-[var(--color-border)] overflow-hidden">
          {paths.map((path, i) => {
            const label = path.split('/').filter(Boolean).pop() ?? path;
            return (
              <li key={path} className="p-3 flex items-center justify-between min-h-[56px] gap-2">
                <button
                  type="button"
                  onClick={newSession.open}
                  className="flex-1 text-left flex flex-col gap-0.5 min-w-0"
                >
                  <span className="text-[var(--color-text)] font-semibold truncate">{label}</span>
                  <span className="text-[var(--color-text-dim)] text-xs font-mono truncate">{path}</span>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => move(i, Math.max(0, i - 1))}
                    disabled={i === 0}
                    aria-label={`Move ${path} up`}
                    className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ArrowUp size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, Math.min(paths.length - 1, i + 1))}
                    disabled={i === paths.length - 1}
                    aria-label={`Move ${path} down`}
                    className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ArrowDown size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(path)}
                    aria-label={`Remove ${path}`}
                    className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-danger)]"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {newSession.pickerNode}
    </div>
  );
}
