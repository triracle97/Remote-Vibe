import { promises as fsp } from 'node:fs';
import type { AgentKind, ServerStreamMsg } from './types.js';

const MAX_REPLAY_EVENTS = 1500;

export type ReplayEvent = Omit<ServerStreamMsg, 'sessionId' | 'seq'>;

export async function loadReplayEvents(
  agent: AgentKind,
  filePath: string,
): Promise<ReplayEvent[]> {
  const events = agent === 'claude'
    ? await parseClaudeReplay(filePath)
    : await parseCodexReplay(filePath);
  return events.length > MAX_REPLAY_EVENTS
    ? events.slice(-MAX_REPLAY_EVENTS)
    : events;
}

async function readLines(filePath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  return raw.split('\n');
}

interface ClaudeBlock {
  type?: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
}

interface ClaudeRawLine {
  type?: string;
  message?: { content?: unknown };
}

async function parseClaudeReplay(filePath: string): Promise<ReplayEvent[]> {
  const lines = await readLines(filePath);
  const out: ReplayEvent[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    let obj: ClaudeRawLine;
    try {
      obj = JSON.parse(line) as ClaudeRawLine;
    } catch {
      continue;
    }
    if (obj === null || typeof obj !== 'object') continue;
    const content = obj.message?.content;

    if (obj.type === 'user') {
      // String form: message.content is a plain string.
      if (typeof content === 'string' && content.length > 0) {
        out.push({ type: 'user', payload: { text: content } });
        continue;
      }
      if (Array.isArray(content)) {
        for (const b of content as ClaudeBlock[]) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
            out.push({ type: 'user', payload: { text: b.text } });
          } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            out.push({
              type: 'tool_result',
              payload: { kind: 'tool_result', toolUseId: b.tool_use_id, output: b.content },
            });
          }
        }
      }
      continue;
    }

    if (obj.type === 'assistant' && Array.isArray(content)) {
      for (const b of content as ClaudeBlock[]) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
          out.push({ type: 'assistant', payload: { text: b.text } });
        } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
          out.push({
            type: 'assistant',
            payload: {
              toolUse: {
                kind: 'tool_use',
                toolUseId: b.id,
                toolName: b.name,
                input: b.input,
              },
            },
          });
        }
      }
    }
  }
  return out;
}

interface CodexRawLine {
  type?: string;
  payload?: {
    type?: string;
    role?: unknown;
    content?: unknown;
    message?: unknown;
    call_id?: unknown;
    name?: unknown;
    arguments?: unknown;
    output?: unknown;
  };
}

interface CodexContentBlock {
  type?: unknown;
  text?: unknown;
}

function textFromCodexMessageContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.length > 0 ? content : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content as CodexContentBlock[]) {
    if (!block || typeof block !== 'object') continue;
    if (
      (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') &&
      typeof block.text === 'string' &&
      block.text.length > 0
    ) {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function pushTextReplayEvent(
  out: ReplayEvent[],
  type: 'user' | 'assistant',
  text: string,
): void {
  const last = out[out.length - 1];
  const lastPayload = last?.payload;
  if (
    last?.type === type &&
    typeof lastPayload === 'object' &&
    lastPayload !== null &&
    'text' in lastPayload &&
    lastPayload.text === text
  ) {
    return;
  }
  out.push({ type, payload: { text } });
}

async function parseCodexReplay(filePath: string): Promise<ReplayEvent[]> {
  const lines = await readLines(filePath);
  const out: ReplayEvent[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    let obj: CodexRawLine;
    try {
      obj = JSON.parse(line) as CodexRawLine;
    } catch {
      continue;
    }
    if (obj === null || typeof obj !== 'object') continue;
    const p = obj.payload;
    if (!p || typeof p !== 'object') continue;

    if (obj.type === 'event_msg') {
      if (p.type === 'user_message' && typeof p.message === 'string' && p.message.length > 0) {
        pushTextReplayEvent(out, 'user', p.message);
      } else if (p.type === 'agent_message' && typeof p.message === 'string' && p.message.length > 0) {
        pushTextReplayEvent(out, 'assistant', p.message);
      }
      continue;
    }

    if (obj.type === 'response_item') {
      if (p.type === 'message') {
        const text = textFromCodexMessageContent(p.content);
        if (text !== null) {
          if (p.role === 'user') {
            pushTextReplayEvent(out, 'user', text);
          } else if (p.role === 'assistant') {
            pushTextReplayEvent(out, 'assistant', text);
          }
        }
      } else if (p.type === 'function_call' && typeof p.call_id === 'string' && typeof p.name === 'string') {
        // Codex stores `arguments` as a JSON-encoded string. Try to parse so
        // the web renders the structured tool input the same way live events do.
        let input: unknown = p.arguments;
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            // Keep raw string if not valid JSON.
          }
        }
        out.push({
          type: 'assistant',
          payload: {
            toolUse: {
              kind: 'tool_use',
              toolUseId: p.call_id,
              toolName: p.name,
              input,
            },
          },
        });
      } else if (p.type === 'function_call_output' && typeof p.call_id === 'string') {
        out.push({
          type: 'tool_result',
          payload: { kind: 'tool_result', toolUseId: p.call_id, output: p.output },
        });
      }
    }
  }
  return out;
}
