import { useState } from 'react';

interface DirPickerProps {
  dirs: string[];
  onChange: (dirs: string[]) => void;
  /** Optional per-index validity map; renders invalid rows greyed/strikethrough. */
  validity?: boolean[];
}

/**
 * Mobile-friendly multi-dir picker.
 * - Index 0 is the primary cwd (★).
 * - Reorder via ▲ / ▼ buttons (no drag-only patterns).
 * - All tap targets ≥ 44 × 44 px.
 */
export function DirPicker({ dirs, onChange, validity }: DirPickerProps): JSX.Element {
  const [adding, setAdding] = useState('');

  const addDir = (): void => {
    const v = adding.trim();
    if (!v) return;
    if (dirs.includes(v)) {
      setAdding('');
      return;
    }
    onChange([...dirs, v]);
    setAdding('');
  };

  const removeAt = (i: number): void => {
    onChange(dirs.filter((_, idx) => idx !== i));
  };

  const moveUp = (i: number): void => {
    if (i <= 0) return;
    const next = dirs.slice();
    const a = next[i - 1];
    const b = next[i];
    if (a === undefined || b === undefined) return;
    next[i - 1] = b;
    next[i] = a;
    onChange(next);
  };

  const moveDown = (i: number): void => {
    if (i >= dirs.length - 1) return;
    const next = dirs.slice();
    const a = next[i];
    const b = next[i + 1];
    if (a === undefined || b === undefined) return;
    next[i] = b;
    next[i + 1] = a;
    onChange(next);
  };

  return (
    <div className="dir-picker" data-testid="dir-picker">
      {dirs.length === 0 ? (
        <div className="dir-picker-empty">No working dirs added yet.</div>
      ) : (
        dirs.map((d, i) => {
          const invalid = validity && validity[i] === false;
          const className = `dir-picker-row${invalid ? ' is-invalid' : ''}`;
          return (
            <div key={`${d}:${i}`} className={className} data-testid="dir-picker-row">
              <span
                className="dir-picker-primary"
                title={i === 0 ? 'primary cwd' : ''}
                aria-label={i === 0 ? 'primary cwd' : undefined}
              >
                {i === 0 ? '★' : ''}
              </span>
              <span className="dir-picker-path" title={d}>
                {d}
              </span>
              <button
                type="button"
                className="dir-picker-action"
                onClick={() => moveUp(i)}
                disabled={i === 0}
                aria-label={`move ${d} up`}
              >
                ▲
              </button>
              <button
                type="button"
                className="dir-picker-action"
                onClick={() => moveDown(i)}
                disabled={i === dirs.length - 1}
                aria-label={`move ${d} down`}
              >
                ▼
              </button>
              <button
                type="button"
                className="dir-picker-action"
                onClick={() => removeAt(i)}
                aria-label={`remove ${d}`}
              >
                ✕
              </button>
            </div>
          );
        })
      )}
      <div className="dir-picker-add">
        <input
          type="text"
          className="dir-picker-add-input"
          placeholder="Add a working dir (absolute path)"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addDir();
            }
          }}
          aria-label="add a working directory"
        />
        <button
          type="button"
          className="dir-picker-add-button"
          onClick={addDir}
          disabled={adding.trim().length === 0}
          aria-label="add directory"
        >
          +
        </button>
      </div>
    </div>
  );
}
