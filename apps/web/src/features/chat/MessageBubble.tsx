import { useState } from 'react';
import { Play, ChevronRight, ChevronDown } from 'lucide-react';
import type { SessionEvent } from '../../store/sessions';
import { MarkdownRenderer } from '../markdown/MarkdownRenderer';

interface MessageBubbleProps {
  event: SessionEvent;
}

const systemBubble = 'bubble system flex justify-center my-2 text-[var(--color-text-dim)] italic text-xs font-mono';
const userBubble =
  'bubble user max-w-[85%] ml-auto px-4 py-2.5 my-1 rounded-2xl bg-[var(--color-bubble-user)] text-white text-[15px] leading-relaxed whitespace-pre-wrap break-words';
const assistantBubble =
  'bubble assistant max-w-[85%] mr-auto px-4 py-2.5 my-1 rounded-2xl bg-[var(--color-bubble-ai)] text-[var(--color-text)] text-[15px] leading-relaxed whitespace-pre-wrap break-words';
const deltaBubble = 'bubble-delta px-1 bg-[var(--color-bubble-ai)]';

export function MessageBubble({ event }: MessageBubbleProps): JSX.Element | null {
  if (event.superseded) return null;
  if (event.type === 'system' && event.event === 'session_created') {
    return <div className={systemBubble}><span>session started</span></div>;
  }
  if (event.type === 'system' && event.event === 'session_ended') {
    const reason = event.reason;
    return (
      <div className={systemBubble}>
        <span>session ended (exit {event.exitCode ?? '?'}{reason ? `, ${reason}` : ''})</span>
      </div>
    );
  }
  if (event.type === 'stream_delta') {
    const delta = (event.payload as { delta?: string }).delta ?? '';
    return <span className={deltaBubble}>{delta}</span>;
  }
  if (event.type === 'assistant') {
    const payload = event.payload as { text?: string; toolUse?: { toolName: string; input: unknown } };
    if (payload.text) {
      return (
        <div className={assistantBubble}>
          <MarkdownRenderer source={payload.text} />
        </div>
      );
    }
    if (payload.toolUse) {
      return <ToolUseBubble toolName={payload.toolUse.toolName} input={payload.toolUse.input} />;
    }
    return null;
  }
  if (event.type === 'tool_result') {
    const payload = event.payload as { toolUseId: string; output: unknown };
    return <ToolResultBubble output={payload.output} />;
  }
  if (event.type === 'user') {
    const payload = event.payload as { text?: string };
    return (
      <div className={userBubble}>
        <MarkdownRenderer source={payload.text ?? ''} />
      </div>
    );
  }
  if (event.type === 'result') {
    const payload = event.payload as { cost?: number; durationMs?: number };
    const parts: string[] = [];
    if (typeof payload.durationMs === 'number') parts.push(`${payload.durationMs} ms`);
    if (typeof payload.cost === 'number') parts.push(`$${payload.cost.toFixed(4)}`);
    return <div className={systemBubble}><span>turn complete{parts.length > 0 ? ` (${parts.join(', ')})` : ''}</span></div>;
  }
  return null;
}

function ToolUseBubble({ toolName, input }: { toolName: string; input: unknown }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="bubble tool-use my-2 mr-auto max-w-[85%]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-tool-shell)] border border-[color-mix(in_srgb,var(--color-success)_50%,var(--color-border))] text-[var(--color-success)] font-mono text-sm"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Play size={14} aria-hidden="true" />
        <span>tool: {toolName}</span>
      </button>
      {open && (
        <pre className="mt-1 ml-2 px-3 py-2 bg-black text-[var(--color-success)] rounded overflow-x-auto text-xs">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResultBubble({ output }: { output: unknown }): JSX.Element {
  const [open, setOpen] = useState(false);
  const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  return (
    <div className="bubble tool-result my-2 mr-auto max-w-[85%]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-tool-result)] border border-[color-mix(in_srgb,var(--color-warn)_50%,var(--color-border))] text-[var(--color-warn)] font-mono text-sm"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Play size={14} aria-hidden="true" />
        <span>tool result ({text.length} chars)</span>
      </button>
      {open && (
        <pre className="mt-1 ml-2 px-3 py-2 bg-black text-[var(--color-warn)] rounded overflow-x-auto text-xs">
          {text}
        </pre>
      )}
    </div>
  );
}
