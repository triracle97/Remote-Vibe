import type { AgentEvent, TurnUsage } from './types.js';

/**
 * One line of `grok -p --output-format streaming-json`.
 *
 * The stream is newline-delimited and non-exhaustive: unknown `type` values
 * are ignored so a newer CLI can add events without breaking the turn.
 */
interface RawGrokLine {
  type?: string;
  data?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  title?: unknown;
  status?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  sessionId?: unknown;
  message?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
  total_cost_usd?: unknown;
}

export interface GrokParseResult {
  /** Conversation event, if this line carried one. */
  event: AgentEvent | null;
  /** CLI session id, when the line named one. */
  sessionId?: string;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function usageOf(raw: RawGrokLine): TurnUsage | undefined {
  const u = raw.usage;
  if (!u || typeof u !== 'object') return undefined;
  const usage: TurnUsage = {};
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheCreation = num(u.cache_creation_input_tokens);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
  if (cacheCreation !== undefined) usage.cacheCreationTokens = cacheCreation;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function sessionIdOf(raw: RawGrokLine): string | undefined {
  return typeof raw.sessionId === 'string' && raw.sessionId.length > 0 ? raw.sessionId : undefined;
}

/**
 * Parse one stdout line. Returns null for blank lines, non-JSON, and objects
 * with no `type` — those are noise, not a failed turn.
 */
export function parseGrokLine(line: string): GrokParseResult | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: RawGrokLine;
  try {
    raw = JSON.parse(trimmed) as RawGrokLine;
  } catch {
    return null;
  }
  if (!raw || typeof raw.type !== 'string') return null;

  const sessionId = sessionIdOf(raw);

  switch (raw.type) {
    case 'text': {
      if (typeof raw.data !== 'string' || raw.data.length === 0) {
        return sessionId ? { event: null, sessionId } : null;
      }
      return { event: { kind: 'stream_delta', delta: raw.data }, ...(sessionId ? { sessionId } : {}) };
    }
    case 'thought': {
      if (typeof raw.data !== 'string' || raw.data.length === 0) {
        return sessionId ? { event: null, sessionId } : null;
      }
      return { event: { kind: 'thinking', text: raw.data }, ...(sessionId ? { sessionId } : {}) };
    }
    case 'tool_call': {
      if (typeof raw.toolCallId !== 'string') return sessionId ? { event: null, sessionId } : null;
      const toolName =
        typeof raw.toolName === 'string'
          ? raw.toolName
          : typeof raw.title === 'string'
            ? raw.title
            : 'tool';
      return {
        event: {
          kind: 'tool_use',
          toolUseId: raw.toolCallId,
          toolName,
          input: raw.rawInput ?? {},
        },
        ...(sessionId ? { sessionId } : {}),
      };
    }
    case 'tool_call_update': {
      if (typeof raw.toolCallId !== 'string') return sessionId ? { event: null, sessionId } : null;
      const status = typeof raw.status === 'string' ? raw.status : '';
      // Progress pings have no result yet. Emitting them would close the card
      // while the tool is still running.
      if (status !== 'completed' && status !== 'failed' && status !== 'error') {
        return sessionId ? { event: null, sessionId } : null;
      }
      return {
        event: {
          kind: 'tool_result',
          toolUseId: raw.toolCallId,
          output: raw.rawOutput ?? null,
          ...(status !== 'completed' ? { isError: true } : {}),
        },
        ...(sessionId ? { sessionId } : {}),
      };
    }
    case 'end': {
      const usage = usageOf(raw);
      const cost = num(raw.total_cost_usd);
      const event: AgentEvent = {
        kind: 'result',
        ...(usage ? { usage } : {}),
        ...(cost !== undefined ? { cost } : {}),
      };
      return { event, ...(sessionId ? { sessionId } : {}) };
    }
    case 'error': {
      const message = typeof raw.message === 'string' && raw.message.length > 0
        ? raw.message
        : 'grok reported an error';
      return {
        event: { kind: 'result', error: message },
        ...(sessionId ? { sessionId } : {}),
      };
    }
    default:
      return sessionId ? { event: null, sessionId } : { event: null };
  }
}
