import { useState, type JSX, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ToolCallMessage, ToolStatus, ViewMessage } from './projection';
import { DiffViewer } from './DiffViewer';
import { useElapsedTimeRef } from './useElapsedTime';
import { formatElapsed, formatToolName, outputToText, summarizeToolInput } from './utils';

/**
 * Collapsible card for one tool call.
 *
 * Modelled on nimbalyst's `CustomToolWidgets/BashWidget.tsx` +
 * `EditToolResultCard.tsx`: a one-line header that says what the tool is
 * doing, a status dot, a live elapsed timer while running, and the details
 * behind a disclosure.
 *
 * Body rendering is picked by tool name — the registry is the small map below
 * rather than nimbalyst's `CUSTOM_TOOL_WIDGETS`, because we render far fewer
 * tool types and a lookup table of three entries is not worth the indirection.
 */

interface Props {
  message: ToolCallMessage;
  projectPath?: string;
  onOpenFile?: (filePath: string) => void;
  /** Expand tool cards by default. */
  defaultOpen?: boolean;
  /**
   * Renders a subagent's own transcript, when this call started one.
   *
   * Injected rather than imported so the card does not have to reach back into
   * `TranscriptView` for the renderer that renders the card.
   */
  renderSubagent?: (messages: ViewMessage[]) => ReactNode;
}

const STATUS_COLOR: Record<ToolStatus, string> = {
  running: 'var(--color-state-running)',
  ok: 'var(--color-success)',
  error: 'var(--color-danger)',
};

export function ToolCallCard({
  message,
  projectPath = '',
  onOpenFile,
  defaultOpen = false,
  renderSubagent,
}: Props): JSX.Element {
  // Errors are what you want to see; open them without being asked.
  const [open, setOpen] = useState(defaultOpen || message.status === 'error');
  const elapsedRef = useElapsedTimeRef(message.startedAt);

  const running = message.status === 'running';
  const summary = summarizeToolInput(message.toolName, message.input);
  const color = STATUS_COLOR[message.status];

  return (
    <div className="my-1.5 mr-auto w-full max-w-full" data-testid="tool-call">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={[
          'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left',
          'border border-[var(--color-border)] bg-[var(--color-surface)]',
          'hover:bg-[var(--color-surface-2)] transition-colors font-mono text-xs',
        ].join(' ')}
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-[var(--color-text-dim)]" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-[var(--color-text-dim)]" />
        )}
        <span
          aria-hidden
          className={`shrink-0 w-2 h-2 rounded-full ${running ? 'animate-pulse' : ''}`}
          style={{ background: color }}
        />
        <span className="shrink-0 font-semibold" style={{ color }}>
          {formatToolName(message.toolName)}
        </span>
        {summary.length > 0 && (
          <span className="flex-1 min-w-0 truncate text-[var(--color-text-mute)]" title={summary}>
            {summary}
          </span>
        )}
        <span className="ml-auto shrink-0 tabular-nums text-[10px] text-[var(--color-text-dim)]">
          {running ? (
            // Ticks via rAF against the DOM — no re-render, so it can't keep
            // running after the tool finishes.
            <span ref={elapsedRef} />
          ) : message.durationMs !== undefined ? (
            formatElapsed(message.durationMs)
          ) : null}
        </span>
      </button>

      {open && (
        <div className="mt-1 ml-4 flex flex-col gap-1.5">
          <ToolBody message={message} projectPath={projectPath} {...(onOpenFile ? { onOpenFile } : {})} />
        </div>
      )}

      {/* Outside the disclosure above: a subagent's output is the thing you
          actually want to watch while it runs, not an argument dump you went
          looking for. */}
      {message.subagent !== undefined && message.subagent.length > 0 && renderSubagent && (
        <SubagentPanel running={running}>{renderSubagent(message.subagent)}</SubagentPanel>
      )}
    </div>
  );
}

/**
 * A subagent's transcript, nested under the call that started it.
 *
 * Open while the agent is working and collapsed once it returns: the result
 * the parent gets is the summary, and by then the working-out is reference
 * material. The rule is one click either way.
 */
function SubagentPanel({
  running,
  children,
}: {
  running: boolean;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(running);

  return (
    <div className="mt-1 ml-4" data-testid="subagent-panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        subagent
        {running && (
          <span
            aria-hidden
            className="w-1.5 h-1.5 rounded-full animate-pulse"
            style={{ background: 'var(--color-state-running)' }}
          />
        )}
      </button>
      {open && (
        <div className="mt-1 pl-3 border-l-2 border-[var(--color-border)]">{children}</div>
      )}
    </div>
  );
}

function ToolBody({
  message,
  projectPath,
  onOpenFile,
}: {
  message: ToolCallMessage;
  projectPath: string;
  onOpenFile?: (filePath: string) => void;
}): JSX.Element {
  const output = outputToText(message.output);

  return (
    <>
      {/* File mutations render as a real diff rather than raw arguments. */}
      {message.fileDiffs !== undefined && message.fileDiffs.length > 0 ? (
        <DiffViewer
          diffs={message.fileDiffs}
          projectPath={projectPath}
          {...(onOpenFile ? { onOpenFile } : {})}
        />
      ) : (
        <Pre label="input" text={argsText(message)} tone="var(--color-text-mute)" />
      )}

      {output.length > 0 && (
        <Pre
          label={message.status === 'error' ? 'error' : 'output'}
          text={output}
          tone={message.status === 'error' ? 'var(--color-danger)' : 'var(--color-text-mute)'}
        />
      )}
    </>
  );
}

/** Bash shows its command verbatim; everything else shows pretty JSON. */
function argsText(message: ToolCallMessage): string {
  if (message.toolName === 'Bash') {
    return summarizeToolInput('Bash', message.input);
  }
  if (message.input === undefined) return '';
  try {
    return JSON.stringify(message.input, null, 2);
  } catch {
    return String(message.input);
  }
}

const MAX_INLINE_CHARS = 4000;

function Pre({ label, text, tone }: { label: string; text: string; tone: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  if (text.length === 0) return <></>;
  const truncated = !expanded && text.length > MAX_INLINE_CHARS;
  const shown = truncated ? text.slice(0, MAX_INLINE_CHARS) : text;

  return (
    <div className="rounded-md border border-[var(--color-border)] overflow-hidden">
      <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide bg-[var(--color-surface-2)] text-[var(--color-text-dim)]">
        {label}
      </div>
      <pre
        className="px-2.5 py-2 overflow-x-auto text-[11px] leading-relaxed whitespace-pre-wrap break-words max-h-80"
        style={{ color: tone }}
      >
        {shown}
        {truncated && '\n…'}
      </pre>
      {text.length > MAX_INLINE_CHARS && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="w-full px-2.5 py-1 text-[10px] text-[var(--color-text-dim)] hover:text-[var(--color-text)] bg-[var(--color-surface-2)] border-t border-[var(--color-border)]"
        >
          {expanded ? 'Show less' : `Show all ${text.length.toLocaleString()} chars`}
        </button>
      )}
    </div>
  );
}
