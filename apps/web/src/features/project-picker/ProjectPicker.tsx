import { useEffect, useMemo, useState } from 'react';
import { Plus, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import { useAccountsStore } from '../../store/accounts';
import { useProfileStore } from '../profiles/profileStore';
import { DirPicker } from '../profiles/DirPicker';
import { ProfilePicker } from '../profiles/ProfilePicker';
import { ProfileEditor } from '../profiles/ProfileEditor';
import { Modal } from '../../shell/Modal';
import type { AgentKind, Profile } from '../../types/protocol';
import { DEFAULT_WORKSPACE_DIRS } from './default-workspaces';
import { useDefaultWorkspacesStore } from './defaultWorkspacesStore';

const RECENT_KEY = 'mrt.recentProjects';
const RECENT_MAX = 10;

function loadRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecents(list: string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* ignore */
  }
}

function matchesDefaultWorkspaceDirs(dirs: string[]): boolean {
  return dirs.length === DEFAULT_WORKSPACE_DIRS.length &&
    dirs.every((dir, index) => dir === DEFAULT_WORKSPACE_DIRS[index]);
}

export function rememberRecentProject(path: string): void {
  const current = loadRecents();
  const next = [path, ...current.filter((p) => p !== path)];
  saveRecents(next);
}

export interface ProjectPickerSelection {
  agent: AgentKind;
  /** Working dirs in order; first = primary cwd. Always non-empty when emitted. */
  dirs: string[];
  /** Back-compat alias for dirs[0]. */
  projectPath: string;
  account?: string;
}

interface ProjectPickerProps {
  onPick(selection: ProjectPickerSelection): void;
  onCancel(): void;
}

export function ProjectPicker({ onPick, onCancel }: ProjectPickerProps): JSX.Element {
  const [agent, setAgent] = useState<AgentKind>('claude');
  const [dirs, setDirs] = useState<string[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const accounts = useAccountsStore((s) => s.accounts);
  const selectedAccount = useAccountsStore((s) => s.selectedAccount);
  const setSelectedAccount = useAccountsStore((s) => s.setSelectedAccount);
  const profiles = useProfileStore((s) => s.profiles);
  const fetchProfiles = useProfileStore((s) => s.fetch);
  const defaultWorkspaces = useDefaultWorkspacesStore((s) => s.paths);
  const [recents, setRecents] = useState<string[]>([]);
  const [autoLoaded, setAutoLoaded] = useState(false);

  useEffect(() => {
    setRecents(loadRecents());
    fetchProfiles();
  }, [fetchProfiles]);

  // Auto-load default profile for the chosen agent on first render after profiles arrive.
  const defaultProfile = useMemo(
    () => profiles.find((p) => p.agent === agent && p.default),
    [profiles, agent],
  );
  useEffect(() => {
    if (
      !autoLoaded &&
      (dirs.length === 0 || matchesDefaultWorkspaceDirs(dirs)) &&
      defaultProfile &&
      defaultProfile.dirs.length > 0
    ) {
      setDirs(defaultProfile.dirs.slice());
      if (agent === 'codex' && defaultProfile.account) {
        setSelectedAccount(defaultProfile.account);
      }
      setAutoLoaded(true);
    }
  }, [autoLoaded, dirs.length, defaultProfile, agent, setSelectedAccount]);

  const suggestions = useMemo(
    () => defaultWorkspaces.filter((p) => !dirs.includes(p)),
    [defaultWorkspaces, dirs],
  );

  const addSuggestion = (path: string): void => {
    if (dirs.includes(path)) return;
    setDirs([...dirs, path]);
  };

  const applyProfile = (p: Profile): void => {
    setDirs(p.dirs.slice());
    if (p.agent === 'codex' && p.account) {
      setSelectedAccount(p.account);
    }
  };

  const submit = (): void => {
    const trimmed = dirs.map((d) => d.trim()).filter((d) => d.length > 0);
    if (trimmed.length === 0) return;
    rememberRecentProject(trimmed[0]!);
    const account =
      agent === 'codex' && selectedAccount ? { account: selectedAccount } : undefined;
    onPick({
      agent,
      dirs: trimmed,
      projectPath: trimmed[0]!,
      ...(account ?? {}),
    });
  };

  const useRecent = (path: string): void => {
    rememberRecentProject(path);
    const account =
      agent === 'codex' && selectedAccount ? { account: selectedAccount } : undefined;
    onPick({
      agent,
      dirs: [path],
      projectPath: path,
      ...(account ?? {}),
    });
  };

  return (
    <Modal open={true} onClose={onCancel} ariaLabel="Select Project" maxWidthClass="max-w-lg">
      <div className="picker p-6">
        <h2 className="text-[var(--color-text)] text-xl font-semibold text-center mb-6">Pick a project</h2>
        <div className="picker-agent flex gap-4 mb-3">
          <label>
            <input
              type="radio"
              name="agent"
              value="claude"
              checked={agent === 'claude'}
              onChange={() => {
                setAgent('claude');
                setAutoLoaded(false);
                setDirs([]);
              }}
            />
            {' '}Claude
          </label>
          <label>
            <input
              type="radio"
              name="agent"
              value="codex"
              checked={agent === 'codex'}
              onChange={() => {
                setAgent('codex');
                setAutoLoaded(false);
                setDirs([]);
              }}
            />
            {' '}Codex
          </label>
        </div>
        {agent === 'codex' && accounts.length > 0 && (
          <div className="picker-account mb-3">
            <label>
              Account:&nbsp;
              <select
                className="bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                value={selectedAccount ?? ''}
                onChange={(e) => setSelectedAccount(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                    {a.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className="picker-profile mb-3">
          <ProfilePicker
            agent={agent}
            onSelect={applyProfile}
            onManage={() => setEditorOpen(true)}
          />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DirPicker dirs={dirs} onChange={setDirs} />
          {suggestions.length > 0 && (
            <div className="picker-suggestions mt-3">
              <h3 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-2">Suggestions</h3>
              <ul className="list-none p-0 m-0 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg overflow-hidden">
                {suggestions.map((p) => (
                  <li key={p} className="border-b border-[var(--color-border)] last:border-b-0">
                    <button
                      type="button"
                      onClick={() => addSuggestion(p)}
                      className="w-full text-left px-3 py-2 min-h-[44px] flex items-center gap-2 text-sm font-mono text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors"
                      aria-label={`Add ${p}`}
                    >
                      <Plus size={14} aria-hidden="true" className="shrink-0 text-[var(--color-accent)]" />
                      <span className="flex-1 break-all">{p}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="picker-actions flex p-4 gap-3 bg-[color-mix(in_srgb,var(--color-bg)_50%,var(--color-surface))] border-t border-[var(--color-border)] -mx-6 -mb-6 mt-4">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 py-2.5 min-h-[44px] bg-[var(--color-surface-2)] text-[var(--color-text)] rounded-xl font-medium hover:bg-[var(--color-surface)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={dirs.length === 0}
              className="flex-1 py-2.5 min-h-[44px] bg-[var(--color-accent)] text-white rounded-xl font-medium hover:opacity-90 transition-colors shadow-lg shadow-[color-mix(in_srgb,var(--color-accent)_30%,transparent)] disabled:opacity-50"
            >
              Open
            </button>
          </div>
        </form>
        {recents.length > 0 && (
          <>
            <h3 className="text-[var(--color-text)] font-medium mt-4 mb-2">Recent</h3>
            <ul className="picker-recents list-none p-0 max-h-[200px] overflow-y-auto">
              {recents.map((p) => (
                <li key={p} className="flex items-center justify-between py-2 border-b border-[var(--color-border)] last:border-b-0">
                  <button
                    type="button"
                    onClick={() => useRecent(p)}
                    className="flex-1 text-left text-sm text-[var(--color-text-dim)] hover:text-[var(--color-text)] bg-none border-0 p-0 cursor-pointer"
                  >
                    {p}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <ProfileEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        initialAgent={agent}
      />
    </Modal>
  );
}

// Re-export lucide icons used internally so they are tree-shaken properly.
export { Plus, ArrowUp, ArrowDown, Trash2 };
