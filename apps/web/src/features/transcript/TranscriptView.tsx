import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
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
 *
 * Instead, opening a session renders only its tail and keeps the rest one click
 * away. A thousand buffered events can be hundreds of markdown blocks, diffs,
 * and mermaid diagrams — parsing all of them to show the last screenful is the
 * cost this avoids. The window only ever *grows*: it collapses once when a
 * session is opened, and messages arriving after that are always rendered, so
 * you never watch something appear and then vanish.
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

export interface TranscriptViewHandle {
  /**
   * Render the whole history.
   *
   * Needed before jumping to a message the window has collapsed away — search
   * and the outline both index the full transcript, so their targets can sit
   * above the visible tail.
   */
  revealAll(): void;
}

interface Props {
  events: readonly SessionEvent[];
  projectPath?: string;
  settings?: TranscriptSettings;
  onOpenFile?: (filePath: string) => void;
  /** Rendered after the messages — the in-flight streaming tail. */
  footer?: React.ReactNode;
  /** Highlighted when transcript search is active. */
  searchQuery?: string;
  /**
   * Collapses the window back to the tail when it changes. The session id in
   * practice — switching sessions should not inherit however far the previous
   * one had been expanded.
   */
  sessionKey?: string;
  /** How many messages an opened session starts with. */
  initialWindow?: number;
}

/** How many more to reveal per click of "show earlier". */
const REVEAL_STEP = 50;

export const TranscriptView = forwardRef<TranscriptViewHandle, Props>(function TranscriptView(
  {
    events,
    projectPath = '',
    settings = DEFAULT_TRANSCRIPT_SETTINGS,
    onOpenFile,
    footer,
    searchQuery = '',
    sessionKey,
    initialWindow = 20,
  },
  ref,
): JSX.Element {
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

  // Index of the first rendered message. Only ever moves toward 0 — see the
  // note above about messages never disappearing once shown.
  const [floor, setFloor] = useState(0);
  // A freshly-opened session has no events yet; history arrives a moment later.
  // Collapsing has to wait for that, or it would compute a window over nothing
  // and then render the whole backlog when it lands.
  const collapsePending = useRef(true);
  const lastKey = useRef(sessionKey);

  useEffect(() => {
    // A new session re-arms the collapse; an expanded view should not carry
    // over from whatever was open before.
    if (lastKey.current !== sessionKey) {
      lastKey.current = sessionKey;
      collapsePending.current = true;
    }
    if (!collapsePending.current || visible.length === 0) return;
    collapsePending.current = false;
    setFloor(Math.max(0, visible.length - initialWindow));
  }, [sessionKey, visible.length, initialWindow]);

  useImperativeHandle(ref, () => ({ revealAll: () => setFloor(0) }), []);

  const shown = floor > 0 ? visible.slice(floor) : visible;

  return (
    <div className="flex flex-col" data-testid="transcript">
      {floor > 0 && (
        <div className="flex items-center justify-center gap-2 py-3">
          <button
            type="button"
            onClick={() => setFloor((f) => Math.max(0, f - REVEAL_STEP))}
            data-testid="transcript-show-earlier"
            className="px-3 py-1.5 min-h-[36px] rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-mute)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
          >
            Show {Math.min(REVEAL_STEP, floor)} earlier
          </button>
          <button
            type="button"
            onClick={() => setFloor(0)}
            data-testid="transcript-show-all"
            className="px-3 py-1.5 min-h-[36px] rounded-lg text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          >
            all {floor}
          </button>
        </div>
      )}
      {shown.map((m) => (
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
});

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
