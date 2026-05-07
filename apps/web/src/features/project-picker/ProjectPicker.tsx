import { useEffect, useState } from 'react';
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

interface ProjectPickerProps {
  onPick(path: string): void;
  onCancel(): void;
}

export function ProjectPicker({ onPick, onCancel }: ProjectPickerProps): JSX.Element {
  const [path, setPath] = useState('');
  const [recents, setRecents] = useState<string[]>([]);

  useEffect(() => {
    setRecents(loadRecents());
  }, []);

  const submit = (chosen: string): void => {
    const trimmed = chosen.trim();
    if (trimmed.length === 0) return;
    rememberRecentProject(trimmed);
    onPick(trimmed);
  };

  return (
    <div className="picker-backdrop">
      <div className="picker">
        <h2>Pick a project</h2>
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
