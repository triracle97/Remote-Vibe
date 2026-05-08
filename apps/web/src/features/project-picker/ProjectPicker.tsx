import { useEffect, useMemo, useState } from 'react';
import { useAccountsStore } from '../../store/accounts';
import { useProfileStore } from '../profiles/profileStore';
import { DirPicker } from '../profiles/DirPicker';
import { ProfilePicker } from '../profiles/ProfilePicker';
import { ProfileEditor } from '../profiles/ProfileEditor';
import type { AgentKind, Profile } from '../../types/protocol';
import './ProjectPicker.css';

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
    if (!autoLoaded && dirs.length === 0 && defaultProfile && defaultProfile.dirs.length > 0) {
      setDirs(defaultProfile.dirs.slice());
      if (agent === 'codex' && defaultProfile.account) {
        setSelectedAccount(defaultProfile.account);
      }
      setAutoLoaded(true);
    }
  }, [autoLoaded, dirs.length, defaultProfile, agent, setSelectedAccount]);

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
    <div className="picker-backdrop">
      <div className="picker">
        <h2>Pick a project</h2>
        <div className="picker-agent">
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
            Claude
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
            Codex
          </label>
        </div>
        {agent === 'codex' && accounts.length > 0 && (
          <div className="picker-account">
            <label>
              Account:&nbsp;
              <select
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
        <div className="picker-profile">
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
          <div className="picker-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" disabled={dirs.length === 0}>
              Open
            </button>
          </div>
        </form>
        {recents.length > 0 && (
          <>
            <h3>Recent</h3>
            <ul className="picker-recents">
              {recents.map((p) => (
                <li key={p}>
                  <button type="button" onClick={() => useRecent(p)}>
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
    </div>
  );
}
