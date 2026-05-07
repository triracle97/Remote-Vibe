import type { AgentEvent } from './types.js';

// Pinned to codex-cli 0.128.0. If a future codex release changes event names
// or shapes, update both this file and packages/bridge/test/fixtures/codex-stream.jsonl
// in lockstep.
interface RawCodexMsg {
  type: string;
  session_id?: string;
  content?: string;
  call_id?: string;
  name?: string;
  arguments?: unknown;
  output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
}

export type CodexParseResult = AgentEvent | { kind: 'session_id'; id: string };

export function parseCodexLine(line: string): CodexParseResult | null {
  let raw: RawCodexMsg;
  try {
    raw = JSON.parse(line) as RawCodexMsg;
  } catch {
    return null;
  }
  if (!raw || typeof raw.type !== 'string') return null;

  switch (raw.type) {
    case 'session_init':
      if (typeof raw.session_id === 'string') {
        return { kind: 'session_id', id: raw.session_id };
      }
      return null;
    case 'agent_message':
      if (typeof raw.content === 'string') {
        return { kind: 'assistant_text', text: raw.content };
      }
      return null;
    case 'function_call':
      if (typeof raw.call_id === 'string' && typeof raw.name === 'string') {
        return {
          kind: 'tool_use',
          toolUseId: raw.call_id,
          toolName: raw.name,
          input: raw.arguments,
        };
      }
      return null;
    case 'function_call_output':
      if (typeof raw.call_id === 'string') {
        return { kind: 'tool_result', toolUseId: raw.call_id, output: raw.output };
      }
      return null;
    case 'task_completed': {
      const out: AgentEvent = { kind: 'result' };
      if (typeof raw.total_cost_usd === 'number') out.cost = raw.total_cost_usd;
      if (typeof raw.duration_ms === 'number') out.durationMs = raw.duration_ms;
      return out;
    }
    default:
      return null;
  }
}
