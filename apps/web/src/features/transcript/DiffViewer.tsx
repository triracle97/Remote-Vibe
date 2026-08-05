import { useMemo, useState, type JSX } from 'react';
import type { FileDiff } from './projection';
import { shortenPath } from './utils';

/**
 * Unified diff rendering.
 *
 * Ported from nimbalyst's
 * `packages/runtime/src/ui/AgentTranscript/components/DiffViewer.tsx`, with the
 * `--nim-*` tokens swapped for ours. Hand-rolled on purpose — no diff library
 * is needed when the tool already hands us the exact before and after strings.
 */

interface Props {
  diffs: FileDiff[];
  /** Trims the shared prefix off displayed paths. */
  projectPath?: string;
  maxHeight?: string;
  onOpenFile?: (filePath: string) => void;
}

export function DiffViewer({
  diffs,
  projectPath = '',
  maxHeight = '22rem',
  onOpenFile,
}: Props): JSX.Element | null {
  if (diffs.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {diffs.map((d, i) => (
        <SingleDiff
          key={`${d.filePath}-${i}`}
          diff={d}
          index={i}
          total={diffs.length}
          projectPath={projectPath}
          maxHeight={maxHeight}
          {...(onOpenFile ? { onOpenFile } : {})}
        />
      ))}
    </div>
  );
}

function SingleDiff({
  diff,
  index,
  total,
  projectPath,
  maxHeight,
  onOpenFile,
}: {
  diff: FileDiff;
  index: number;
  total: number;
  projectPath: string;
  maxHeight: string;
  onOpenFile?: (filePath: string) => void;
}): JSX.Element {
  const lines = useMemo(() => toLines(diff), [diff]);
  const stats = useMemo(
    () => ({
      added: lines.filter((l) => l.type === 'added').length,
      removed: lines.filter((l) => l.type === 'removed').length,
    }),
    [lines],
  );

  const display = shortenPath(
    projectPath && diff.filePath.startsWith(projectPath)
      ? diff.filePath.slice(projectPath.length).replace(/^\//, '')
      : diff.filePath,
  );
  const label = total > 1 ? `${display} (${index + 1}/${total})` : display;

  return (
    <div
      className="font-mono text-xs leading-normal rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col overflow-hidden"
      style={{ maxHeight }}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--color-surface-2)] border-b border-[var(--color-border)] shrink-0">
        {onOpenFile ? (
          <button
            type="button"
            onClick={() => onOpenFile(diff.filePath)}
            title={`Open ${diff.filePath}`}
            className="text-[var(--color-accent)] hover:underline truncate text-left"
          >
            {label}
          </button>
        ) : (
          <span className="text-[var(--color-text-mute)] truncate" title={diff.filePath}>
            {label}
          </span>
        )}
        <span className="ml-auto shrink-0 flex gap-1.5 tabular-nums">
          {stats.added > 0 && (
            <span style={{ color: 'var(--color-diff-add)' }}>+{stats.added}</span>
          )}
          {stats.removed > 0 && (
            <span style={{ color: 'var(--color-diff-del)' }}>-{stats.removed}</span>
          )}
          {diff.created && <span className="text-[var(--color-text-dim)]">new</span>}
        </span>
      </div>
      <div className="overflow-auto py-1 flex-1 min-h-0">
        <div className="inline-block min-w-full">
          {lines.map((l, i) => (
            <DiffLine key={i} type={l.type} content={l.content} />
          ))}
        </div>
      </div>
    </div>
  );
}

interface Line {
  type: 'added' | 'removed';
  content: string;
}

function toLines(diff: FileDiff): Line[] {
  const out: Line[] = [];
  if (diff.oldString !== undefined && diff.oldString.length > 0) {
    for (const c of diff.oldString.split('\n')) out.push({ type: 'removed', content: c });
  }
  if (diff.newString.length > 0) {
    for (const c of diff.newString.split('\n')) out.push({ type: 'added', content: c });
  }
  return out;
}

/**
 * A real component rather than a render helper, so its hover `useState` is a
 * stable hook. Calling useState from a helper invoked a variable number of
 * times per render violates the Rules of Hooks — this is the same reason
 * nimbalyst's original carries the note.
 */
function DiffLine({ type, content }: Line): JSX.Element {
  const [hover, setHover] = useState(false);
  const color = type === 'added' ? 'var(--color-diff-add)' : 'var(--color-diff-del)';
  return (
    <div
      className="flex items-start px-3 py-0.5 min-h-6 whitespace-pre leading-normal text-[var(--color-text)]"
      style={{ backgroundColor: `color-mix(in srgb, ${color} ${hover ? 18 : 10}%, transparent)` }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span
        className="inline-block w-4 shrink-0 font-semibold select-none text-center"
        style={{ color }}
      >
        {type === 'added' ? '+' : '-'}
      </span>
      <span className="pl-2 leading-normal whitespace-pre">{content || ' '}</span>
    </div>
  );
}
