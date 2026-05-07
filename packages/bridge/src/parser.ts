import type { AgentEvent } from './types.js';

interface RawClaudeMsg {
  type: string;
  subtype?: string;
  message?: {
    content?: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
      | { type: 'tool_result'; tool_use_id: string; content: unknown }
    >;
  };
  event?: {
    type: string;
    delta?: { type: string; text?: string };
  };
  total_cost_usd?: number;
  duration_ms?: number;
}

export function parseClaudeLine(line: string): AgentEvent | null {
  let raw: RawClaudeMsg;
  try {
    raw = JSON.parse(line) as RawClaudeMsg;
  } catch {
    return null;
  }
  if (!raw || typeof raw.type !== 'string') return null;

  switch (raw.type) {
    case 'stream_event': {
      const ev = raw.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
        return { kind: 'stream_delta', delta: ev.delta.text };
      }
      return null;
    }
    case 'assistant': {
      const blocks = raw.message?.content ?? [];
      for (const b of blocks) {
        if (b.type === 'text') {
          return { kind: 'assistant_text', text: b.text };
        }
        if (b.type === 'tool_use') {
          return {
            kind: 'tool_use',
            toolUseId: b.id,
            toolName: b.name,
            input: b.input,
          };
        }
      }
      return null;
    }
    case 'user': {
      const blocks = raw.message?.content ?? [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          return { kind: 'tool_result', toolUseId: b.tool_use_id, output: b.content };
        }
      }
      return null;
    }
    case 'result': {
      const out: AgentEvent = { kind: 'result' };
      if (typeof raw.total_cost_usd === 'number') out.cost = raw.total_cost_usd;
      if (typeof raw.duration_ms === 'number') out.durationMs = raw.duration_ms;
      return out;
    }
    case 'system':
      return null;
    default:
      return null;
  }
}
