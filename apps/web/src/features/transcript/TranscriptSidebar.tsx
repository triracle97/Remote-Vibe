import { useMemo, type JSX } from 'react';
import { CheckCircle2, Circle, CircleDot } from 'lucide-react';
import type { ToolCallMessage, ViewMessage } from './projection';

/**
 * Transcript navigation panels.
 *
 * Ported in concept from nimbalyst's `TranscriptSidebar.tsx` (prompt-marker
 * TOC) and `TodosSidebar.tsx` (TodoWrite state), collapsed into one file since
 * both are small and always shown together here.
 */

export interface PromptMarker {
  id: string;
  text: string;
  index: number;
}

/** Each user turn becomes a jump target — that's how people navigate a long run. */
export function promptMarkers(messages: readonly ViewMessage[]): PromptMarker[] {
  const out: PromptMarker[] = [];
  for (const m of messages) {
    if (m.kind !== 'text' || m.role !== 'user') continue;
    const text = m.text.replace(/\s+/g, ' ').trim();
    out.push({ id: m.id, text: text.length > 0 ? text : '(empty)', index: out.length + 1 });
  }
  return out;
}

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Latest TodoWrite state. Only the last call matters — TodoWrite always sends
 * the whole list, so earlier calls are superseded snapshots.
 */
export function latestTodos(messages: readonly ViewMessage[]): Todo[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind !== 'tool_call' || m.toolName !== 'TodoWrite') continue;
    const todos = (m as ToolCallMessage).input as { todos?: unknown } | undefined;
    if (typeof todos !== 'object' || todos === null || !Array.isArray(todos.todos)) continue;
    const out: Todo[] = [];
    for (const t of todos.todos) {
      if (typeof t !== 'object' || t === null) continue;
      const content = (t as { content?: unknown; activeForm?: unknown }).content;
      const status = (t as { status?: unknown }).status;
      if (typeof content !== 'string') continue;
      out.push({
        content,
        status:
          status === 'completed' || status === 'in_progress' || status === 'pending'
            ? status
            : 'pending',
      });
    }
    return out;
  }
  return [];
}

interface Props {
  messages: readonly ViewMessage[];
  onJump: (messageId: string) => void;
}

export function TranscriptSidebar({ messages, onJump }: Props): JSX.Element {
  const markers = useMemo(() => promptMarkers(messages), [messages]);
  const todos = useMemo(() => latestTodos(messages), [messages]);

  return (
    <aside
      className="w-56 shrink-0 flex flex-col gap-4 overflow-y-auto p-3 border-l border-[var(--color-border)]"
      aria-label="Transcript navigation"
    >
      {todos.length > 0 && (
        <section>
          <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-mute)] mb-1.5">
            Todos ({todos.filter((t) => t.status === 'completed').length}/{todos.length})
          </h3>
          <ul className="flex flex-col gap-1">
            {todos.map((t, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug">
                <TodoIcon status={t.status} />
                <span
                  className={
                    t.status === 'completed'
                      ? 'line-through text-[var(--color-text-dim)]'
                      : t.status === 'in_progress'
                        ? 'text-[var(--color-text)]'
                        : 'text-[var(--color-text-mute)]'
                  }
                >
                  {t.content}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-mute)] mb-1.5">
          Prompts ({markers.length})
        </h3>
        {markers.length === 0 ? (
          <p className="text-[11px] text-[var(--color-text-dim)]">No prompts yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {markers.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onJump(m.id)}
                  title={m.text}
                  className="w-full text-left text-[11px] leading-snug px-1.5 py-1 rounded text-[var(--color-text-mute)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] transition-colors line-clamp-2"
                >
                  <span className="text-[var(--color-text-dim)] tabular-nums mr-1">{m.index}.</span>
                  {m.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

function TodoIcon({ status }: { status: Todo['status'] }): JSX.Element {
  const common = 'shrink-0 mt-0.5';
  if (status === 'completed') {
    return <CheckCircle2 size={12} className={common} style={{ color: 'var(--color-success)' }} />;
  }
  if (status === 'in_progress') {
    return <CircleDot size={12} className={common} style={{ color: 'var(--color-state-running)' }} />;
  }
  return <Circle size={12} className={`${common} text-[var(--color-text-dim)]`} />;
}
