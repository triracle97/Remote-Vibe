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
    message?: unknown;
    call_id?: unknown;
    name?: unknown;
    arguments?: unknown;
    output?: unknown;
  };
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
        out.push({ type: 'user', payload: { text: p.message } });
      } else if (p.type === 'agent_message' && typeof p.message === 'string' && p.message.length > 0) {
        out.push({ type: 'assistant', payload: { text: p.message } });
      }
      continue;
    }

    if (obj.type === 'response_item') {
      if (p.type === 'function_call' && typeof p.call_id === 'string' && typeof p.name === 'string') {
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
