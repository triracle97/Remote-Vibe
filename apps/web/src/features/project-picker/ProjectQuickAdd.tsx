import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Plus, Search } from 'lucide-react';
import { getBridgeClient } from '../../services/bridge-client-singleton';
import { useConnectionStore } from '../../store/connection';
import { useFileExplorerStore } from '../../store/file-explorer';

/**
 * Type-to-filter picker over the projects that actually exist under the
 * bridge's allowed roots.
 *
 * Replaces a hard-coded suggestion list that named three sample directories —
 * the README shipped a warning about it. The roots come from the bridge's own
 * `BRIDGE_ALLOWED_DIRS`, so this is correct for whoever is running it without
 * anyone editing a constant.
 *
 * The filter is not a nicety: a single root can hold hundreds of repos, so a
 * flat list is unusable. Whatever you type is also accepted verbatim, which
 * makes this a paste-a-path box as well as a browser.
 */

interface Props {
  /** Already-selected dirs; excluded from results and used to disable re-adds. */
  selected: string[];
  onAdd: (path: string) => void;
  /** Skip the roots themselves — a job usually wants a project, not the tree. */
  includeRoots?: boolean;
  maxResults?: number;
}

export function ProjectQuickAdd({
  selected,
  onAdd,
  includeRoots = true,
  maxResults = 40,
}: Props): JSX.Element {
  const allowedDirs = useConnectionStore((s) => s.allowedDirs);
  const dirs = useFileExplorerStore((s) => s.dirs);
  const [query, setQuery] = useState('');
  const requested = useRef<Set<string>>(new Set());

  // List each root once. The file-explorer store already owns dir listings and
  // caches them, so this reuses that rather than adding a second cache.
  useEffect(() => {
    const pending = allowedDirs.filter((d) => !requested.current.has(d));
    if (pending.length === 0) return;
    // `allowedDirs` only arrives on the `init` frame, so the client is
    // registered by now — but resolve it lazily anyway, since it throws when
    // it isn't and a picker that crashes is worse than one with no suggestions.
    let client;
    try {
      client = getBridgeClient();
    } catch {
      return;
    }
    for (const root of pending) {
      requested.current.add(root);
      useFileExplorerStore.getState().requestDirs(client, root);
    }
  }, [allowedDirs]);

  /** Every immediate subdirectory of every root, plus the roots themselves. */
  const candidates = useMemo(() => {
    const out: string[] = [];
    for (const root of allowedDirs) {
      if (includeRoots) out.push(root);
      for (const entry of dirs[root] ?? []) {
        if (entry.kind !== 'dir') continue;
        out.push(`${root.replace(/\/$/, '')}/${entry.name}`);
      }
    }
    return out;
  }, [allowedDirs, dirs, includeRoots]);

  const trimmed = query.trim();
  const results = useMemo(() => {
    const q = trimmed.toLowerCase();
    const pool = candidates.filter((p) => !selected.includes(p));
    if (q.length === 0) return pool.slice(0, maxResults);
    // Rank a match on the final segment above one buried in the path — typing
    // "admin" should surface `…/admin-panel` before `…/admin/legacy-thing`.
    const scored = pool
      .filter((p) => p.toLowerCase().includes(q))
      .map((p) => {
        const base = p.split('/').pop()?.toLowerCase() ?? '';
        const rank = base.startsWith(q) ? 0 : base.includes(q) ? 1 : 2;
        return { p, rank };
      })
      .sort((a, b) => a.rank - b.rank || a.p.localeCompare(b.p));
    return scored.slice(0, maxResults).map((s) => s.p);
  }, [candidates, selected, trimmed, maxResults]);

  /** An absolute path that is not in the list is still a legitimate answer. */
  const literal =
    trimmed.startsWith('/') && !selected.includes(trimmed) && !results.includes(trimmed)
      ? trimmed
      : null;

  const add = (path: string): void => {
    onAdd(path);
    setQuery('');
  };

  // Key presence, not entry count — a root that really is empty must read as
  // "no projects", not as a listing that never arrives.
  const loading = allowedDirs.length > 0 && allowedDirs.some((r) => dirs[r] === undefined);

  return (
    <div className="mt-3" data-testid="project-quick-add">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Search size={13} aria-hidden className="text-[var(--color-text-dim)] shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const first = literal ?? results[0];
            if (first) add(first);
          }}
          placeholder="Filter projects, or paste a path…"
          aria-label="Filter projects or paste a path"
          className="flex-1 min-w-0 px-2 py-1.5 rounded-lg text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:outline-none focus:border-[var(--color-accent)]"
        />
      </div>

      {loading ? (
        <p className="text-xs text-[var(--color-text-dim)] px-1 py-2">Loading projects…</p>
      ) : results.length === 0 && literal === null ? (
        <p className="text-xs text-[var(--color-text-dim)] px-1 py-2">
          {trimmed.length > 0 ? 'No match. Paste an absolute path to use it anyway.' : 'No projects found.'}
        </p>
      ) : (
        <ul className="list-none p-0 m-0 max-h-52 overflow-y-auto bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg">
          {literal !== null && (
            <QuickAddRow path={literal} onAdd={add} label={`Use "${literal}"`} />
          )}
          {results.map((p) => (
            <QuickAddRow key={p} path={p} onAdd={add} />
          ))}
        </ul>
      )}
    </div>
  );
}

function QuickAddRow({
  path,
  onAdd,
  label,
}: {
  path: string;
  onAdd: (p: string) => void;
  label?: string;
}): JSX.Element {
  // The last segment is how people refer to a project; the parent is context.
  const parts = path.split('/').filter(Boolean);
  const base = parts[parts.length - 1] ?? path;
  const parent = parts.slice(0, -1).join('/');

  return (
    <li className="border-b border-[var(--color-border)] last:border-b-0">
      <button
        type="button"
        onClick={() => onAdd(path)}
        aria-label={label ?? `Add ${path}`}
        className="w-full text-left px-3 py-2 min-h-[44px] flex items-center gap-2 hover:bg-[var(--color-surface)] transition-colors"
      >
        <Plus size={13} aria-hidden className="shrink-0 text-[var(--color-accent)]" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-mono text-[var(--color-text)] truncate">{base}</span>
          {parent.length > 0 && (
            <span className="block text-[10px] font-mono text-[var(--color-text-dim)] truncate">
              /{parent}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
