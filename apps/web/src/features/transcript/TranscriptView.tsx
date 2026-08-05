import { useMemo, useState, type JSX } from 'react';
import { ChevronDown, ChevronRight, Brain } from 'lucide-react';
import { MarkdownRenderer } from '../markdown/MarkdownRenderer';
import { ToolCallCard } from './ToolCallCard';
import { projectEvents, type ViewMessage } from './projection';
import { formatCount, formatElapsed } from './utils';
import type { SessionEvent } from '../../store/sessions';

/**
 * Rich transcript.
 *
 * Structure follows nimbalyst's `RichTranscriptView` + `MessageSegment`
 * (`packages/runtime/src/ui/AgentTranscript/components/`), reduced to the parts
 * this app needs: collapsible tool cards, collapsed thinking blocks, turn
 * accounting, and markdown prose.
 *
 * Deliberately *not* virtualized. Nimbalyst reaches for `virtua` because its
 * sessions run to thousands of messages; here the bridge caps its buffer at
 * 1000 events, and adding a virtualizer would cost a dependency plus the
 * scroll-anchoring bugs that come with it.
 */

export interface TranscriptSettings {
  showToolCalls: boolean;
  showThinking: boolean;
  expandTools: boolean;
}

export const DEFAULT_TRANSCRIPT_SETTINGS: TranscriptSettings = {
  showToolCalls: true,
  showThinking: true,
  expandTools: false,
};

interface Props {
  events: readonly SessionEvent[];
  projectPath?: string;
  settings?: TranscriptSettings;
  onOpenFile?: (filePath: string) => void;
  /** Rendered after the messages — the in-flight streaming tail. */
  footer?: React.ReactNode;
  /** Highlighted when transcript search is active. */
  searchQuery?: string;
}

export function TranscriptView({
  events,
  projectPath = '',
  settings = DEFAULT_TRANSCRIPT_SETTINGS,
  onOpenFile,
  footer,
  searchQuery = '',
}: Props): JSX.Element {
  const messages = useMemo(() => projectEvents(events), [events]);

  const visible = useMemo(
    () =>
      messages.filter((m) => {
        if (m.kind === 'tool_call' && !settings.showToolCalls) return false;
        if (m.kind === 'thinking' && !settings.showThinking) return false;
        return true;
      }),
    [messages, settings.showToolCalls, settings.showThinking],
  );

  return (
    <div className="flex flex-col" data-testid="transcript">
      {visible.map((m) => (
        // Real wrapper, not `display: contents` — that has no box, so
        // scrollIntoView would silently do nothing. Carries the id so the
        // sidebar and search bar can scroll to a message without every leaf
        // component having to thread it through.
        <div key={m.id} data-message-id={m.id}>
          <Message
            message={m}
            projectPath={projectPath}
            expandTools={settings.expandTools}
            searchQuery={searchQuery}
            {...(onOpenFile ? { onOpenFile } : {})}
          />
        </div>
      ))}
      {footer}
    </div>
  );
}

function Message({
  message,
  projectPath,
  expandTools,
  onOpenFile,
  searchQuery,
}: {
  message: ViewMessage;
  projectPath: string;
  expandTools: boolean;
  onOpenFile?: (filePath: string) => void;
  searchQuery: string;
}): JSX.Element | null {
  switch (message.kind) {
    case 'text':
      return message.role === 'user' ? (
        <UserBubble text={message.text} imageCount={message.imageCount} />
      ) : (
        <AssistantBubble
          text={message.text}
          searchQuery={searchQuery}
          {...(onOpenFile ? { onOpenFile } : {})}
        />
      );
    case 'thinking':
      return <ThinkingBlock text={message.text} />;
    case 'tool_call':
      return (
        <ToolCallCard
          message={message}
          projectPath={projectPath}
          defaultOpen={expandTools}
          {...(onOpenFile ? { onOpenFile } : {})}
        />
      );
    case 'turn_end':
      return <TurnFooter message={message} />;
    case 'notice':
      return (
        <div
          className="flex justify-center my-2 text-xs font-mono italic"
          style={{
            color: message.tone === 'error' ? 'var(--color-danger)' : 'var(--color-text-dim)',
          }}
        >
          {message.text}
        </div>
      );
    default:
      return null;
  }
}

function UserBubble({
  text,
  imageCount,
}: {
  text: string;
  imageCount?: number | undefined;
}): JSX.Element {
  return (
    <div className="max-w-[85%] ml-auto px-3.5 py-2 my-1 rounded-2xl bg-[var(--color-bubble-user)] text-white text-[15px] leading-relaxed break-words">
      <MarkdownRenderer source={text} />
      {imageCount !== undefined && imageCount > 0 && (
        <div className="mt-1 text-[11px] opacity-80">
          {imageCount} image{imageCount === 1 ? '' : 's'} attached
        </div>
      )}
    </div>
  );
}

function AssistantBubble({
  text,
  searchQuery,
  onOpenFile,
}: {
  text: string;
  searchQuery: string;
  onOpenFile?: (filePath: string) => void;
}): JSX.Element {
  return (
    <div
      className="max-w-[85%] mr-auto px-3.5 py-2 my-1 rounded-2xl bg-[var(--color-bubble-ai)] text-[var(--color-text)] text-[15px] leading-relaxed break-words"
      data-search-hit={
        searchQuery.length > 0 && text.toLowerCase().includes(searchQuery.toLowerCase())
          ? 'true'
          : undefined
      }
    >
      <MarkdownRenderer source={text} {...(onOpenFile ? { onOpenFile } : {})} />
    </div>
  );
}

/**
 * Thinking is collapsed by default — it is context for *why* the answer looks
 * the way it does, not the answer. Same default as nimbalyst's MessageSegment.
 */
function ThinkingBlock({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, ' ').slice(0, 80);
  return (
    <div className="my-1.5 mr-auto max-w-[85%] w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left border border-dashed border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text-mute)] transition-colors text-xs"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Brain size={13} aria-hidden />
        <span className="shrink-0 italic">thinking</span>
        {!open && <span className="flex-1 min-w-0 truncate opacity-70">{preview}</span>}
      </button>
      {open && (
        <div className="mt-1 ml-4 px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[13px] leading-relaxed text-[var(--color-text-dim)] italic whitespace-pre-wrap break-words">
          {text}
        </div>
      )}
    </div>
  );
}

function TurnFooter({
  message,
}: {
  message: Extract<ViewMessage, { kind: 'turn_end' }>;
}): JSX.Element {
  const parts: string[] = [];
  if (message.durationMs !== undefined) parts.push(formatElapsed(message.durationMs));
  if (message.cost !== undefined) parts.push(`$${message.cost.toFixed(4)}`);
  if (message.usage) {
    const { inputTokens, outputTokens, cacheReadTokens } = message.usage;
    const io: string[] = [];
    if (inputTokens !== undefined) io.push(`${formatCount(inputTokens)} in`);
    if (outputTokens !== undefined) io.push(`${formatCount(outputTokens)} out`);
    if (cacheReadTokens !== undefined && cacheReadTokens > 0) {
      io.push(`${formatCount(cacheReadTokens)} cached`);
    }
    if (io.length > 0) parts.push(io.join(' · '));
  }
  if (message.model !== undefined) parts.push(message.model);

  return (
    <div
      className="flex justify-center my-2 text-[11px] font-mono"
      style={{ color: message.error ? 'var(--color-danger)' : 'var(--color-text-dim)' }}
    >
      {message.error ? `turn failed: ${message.error}` : parts.join('  ·  ') || 'turn complete'}
    </div>
  );
}
