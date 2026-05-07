import { useEffect, useState } from 'react';
import { useAccountsStore } from '../../store/accounts';
import type { AgentKind } from '../../types/protocol';
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
  projectPath: string;
  account?: string;
}

interface ProjectPickerProps {
  onPick(selection: ProjectPickerSelection): void;
  onCancel(): void;
}

export function ProjectPicker({ onPick, onCancel }: ProjectPickerProps): JSX.Element {
  const [path, setPath] = useState('');
  const [agent, setAgent] = useState<AgentKind>('claude');
  const accounts = useAccountsStore((s) => s.accounts);
  const selectedAccount = useAccountsStore((s) => s.selectedAccount);
  const setSelectedAccount = useAccountsStore((s) => s.setSelectedAccount);
  const [recents, setRecents] = useState<string[]>([]);

  useEffect(() => {
    setRecents(loadRecents());
  }, []);

  const submit = (chosen: string): void => {
    const trimmed = chosen.trim();
    if (trimmed.length === 0) return;
    rememberRecentProject(trimmed);
    onPick({
      agent,
      projectPath: trimmed,
      ...(agent === 'codex' && selectedAccount ? { account: selectedAccount } : {}),
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
              onChange={() => setAgent('claude')}
            />
            Claude
          </label>
          <label>
            <input
              type="radio"
              name="agent"
              value="codex"
              checked={agent === 'codex'}
              onChange={() => setAgent('codex')}
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
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(path);
          }}
        >
          <input
            type="text"
            placeholder="/Users/you/code/some-project"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            autoFocus
          />
          <div className="picker-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit">Open</button>
          </div>
        </form>
        {recents.length > 0 && (
          <>
            <h3>Recent</h3>
            <ul className="picker-recents">
              {recents.map((p) => (
                <li key={p}>
                  <button type="button" onClick={() => submit(p)}>
                    {p}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
