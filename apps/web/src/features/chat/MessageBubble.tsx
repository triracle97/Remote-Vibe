import { useState } from 'react';
import type { SessionEvent } from '../../store/sessions';
import { MarkdownRenderer } from '../markdown/MarkdownRenderer';

interface MessageBubbleProps {
  event: SessionEvent;
}

export function MessageBubble({ event }: MessageBubbleProps): JSX.Element | null {
  if (event.superseded) return null;
  if (event.type === 'system' && event.event === 'session_created') {
    return <div className="bubble system">session started</div>;
  }
  if (event.type === 'system' && event.event === 'session_ended') {
    const reason = event.reason;
    return (
      <div className="bubble system">
        session ended (exit {event.exitCode ?? '?'}{reason ? `, ${reason}` : ''})
      </div>
    );
  }
  if (event.type === 'stream_delta') {
    const delta = (event.payload as { delta?: string }).delta ?? '';
    return <span className="bubble-delta">{delta}</span>;
  }
  if (event.type === 'assistant') {
    const payload = event.payload as { text?: string; toolUse?: { toolName: string; input: unknown } };
    if (payload.text) {
      return (
        <div className="bubble assistant">
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
      <div className="bubble user">
        <MarkdownRenderer source={payload.text ?? ''} />
      </div>
    );
  }
  if (event.type === 'result') {
    const payload = event.payload as { cost?: number; durationMs?: number };
    const parts: string[] = [];
    if (typeof payload.durationMs === 'number') parts.push(`${payload.durationMs} ms`);
    if (typeof payload.cost === 'number') parts.push(`$${payload.cost.toFixed(4)}`);
    return <div className="bubble system">turn complete{parts.length > 0 ? ` (${parts.join(', ')})` : ''}</div>;
  }
  return null;
}

function ToolUseBubble({ toolName, input }: { toolName: string; input: unknown }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="bubble tool-use">
      <button type="button" onClick={() => setOpen((o) => !o)}>
        {open ? '▼' : '▶'} tool: {toolName}
      </button>
      {open && <pre>{JSON.stringify(input, null, 2)}</pre>}
    </div>
  );
}

function ToolResultBubble({ output }: { output: unknown }): JSX.Element {
  const [open, setOpen] = useState(false);
  const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  return (
    <div className="bubble tool-result">
      <button type="button" onClick={() => setOpen((o) => !o)}>
        {open ? '▼' : '▶'} tool result ({text.length} chars)
      </button>
      {open && <pre>{text}</pre>}
    </div>
  );
}
