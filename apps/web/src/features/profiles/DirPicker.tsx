import { useState } from 'react';
import { ArrowUp, ArrowDown, X, Plus } from 'lucide-react';

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
    <div
      className="dir-picker bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg overflow-hidden"
      data-testid="dir-picker"
    >
      {dirs.length === 0 ? (
        <div className="dir-picker-empty px-3 py-2 text-[var(--color-text-mute)] text-sm italic">
          No working dirs added yet.
        </div>
      ) : (
        dirs.map((d, i) => {
          const invalid = validity && validity[i] === false;
          const rowCls = `dir-picker-row${invalid ? ' is-invalid' : ''}`;
          return (
            <div
              key={`${d}:${i}`}
              className={`${rowCls} flex items-center gap-2 px-3 min-h-[44px] border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-surface)]`}
              data-testid="dir-picker-row"
            >
              <span
                className="dir-picker-primary inline-flex items-center justify-center min-w-[1.5rem] text-yellow-400 font-bold"
                title={i === 0 ? 'primary cwd' : ''}
                aria-label={i === 0 ? 'primary cwd' : undefined}
              >
                {i === 0 ? '★' : ''}
              </span>
              <span
                className={`dir-picker-path flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm text-[var(--color-text)]${invalid ? ' text-[var(--color-text-mute)] line-through' : ''}`}
                title={d}
              >
                {d}
              </span>
              <button
                type="button"
                className="dir-picker-action min-w-[44px] min-h-[44px] flex items-center justify-center bg-transparent border border-[var(--color-border)] rounded text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => moveUp(i)}
                disabled={i === 0}
                aria-label={`move ${d} up`}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                className="dir-picker-action min-w-[44px] min-h-[44px] flex items-center justify-center bg-transparent border border-[var(--color-border)] rounded text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => moveDown(i)}
                disabled={i === dirs.length - 1}
                aria-label={`move ${d} down`}
              >
                <ArrowDown size={14} />
              </button>
              <button
                type="button"
                className="dir-picker-action min-w-[44px] min-h-[44px] flex items-center justify-center bg-transparent border border-[var(--color-border)] rounded text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-danger)] disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => removeAt(i)}
                aria-label={`remove ${d}`}
              >
                <X size={14} />
              </button>
            </div>
          );
        })
      )}
      <div className="dir-picker-add flex gap-2 p-2 mt-0">
        <input
          type="text"
          className="dir-picker-add-input flex-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg px-3 py-2 min-h-[44px] text-sm font-mono text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
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
          className="dir-picker-add-button min-w-[44px] min-h-[44px] flex items-center justify-center bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] hover:bg-[var(--color-surface)] disabled:opacity-40 disabled:cursor-not-allowed"
          onClick={addDir}
          disabled={adding.trim().length === 0}
          aria-label="add directory"
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  );
}
