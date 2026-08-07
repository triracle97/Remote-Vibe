import type { AgentEvent, TurnUsage } from './types.js';

interface RawContentBlock {
  type: string;
  /** text / thinking blocks */
  text?: string;
  thinking?: string;
  /** tool_use */
  id?: string;
  name?: string;
  input?: unknown;
  /** tool_result */
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface RawClaudeMsg {
  type: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  message?: {
    model?: string;
    content?: RawContentBlock[] | string;
    usage?: RawUsage;
  };
  event?: {
    type: string;
    delta?: { type: string; text?: string; thinking?: string };
  };
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: RawUsage;
  result?: unknown;
  rate_limit_info?: {
    status?: unknown;
    resetsAt?: unknown;
    rateLimitType?: unknown;
    utilization?: unknown;
    isUsingOverage?: unknown;
  };
}

// Claude parser may yield either a normal AgentEvent or a session-id discriminant
// surfaced from the `system` init line so the driver can capture Claude's
// session uuid without polluting the downstream `event` channel. Mirrors the
// CodexParseResult pattern in codex-parser.ts.
export type ClaudeParseResult = AgentEvent | { kind: 'session_id'; id: string };

/**
 * Parse one NDJSON line from `claude --output-format stream-json`.
 *
 * Returns *all* events the line carries, not just the first. A single
 * `assistant` message routinely holds prose, a thinking block and several tool
 * calls; emitting only the first block silently discarded the rest, which made
 * a faithful transcript impossible to render.
 *
 * Unparseable or uninteresting lines yield `[]`. That is load-bearing: when
 * Claude is launched through `headroom wrap`, the wrapper prints a banner to
 * stdout before exec'ing, and those lines flow through here.
 */
export function parseClaudeLine(line: string): ClaudeParseResult[] {
  let raw: RawClaudeMsg;
  try {
    raw = JSON.parse(line) as RawClaudeMsg;
  } catch {
    return [];
  }
  if (!raw || typeof raw.type !== 'string') return [];

  switch (raw.type) {
    case 'stream_event': {
      const ev = raw.event;
      if (ev?.type !== 'content_block_delta') return [];
      const d = ev.delta;
      if (d?.type === 'text_delta' && typeof d.text === 'string') {
        return [{ kind: 'stream_delta', delta: d.text }];
      }
      // Thinking deltas are intentionally not streamed: they would interleave
      // with prose in the same channel. The complete block arrives on the
      // `assistant` message.
      return [];
    }
    case 'assistant': {
      const out: ClaudeParseResult[] = [];
      for (const b of contentBlocks(raw)) {
        switch (b.type) {
          case 'text':
            if (typeof b.text === 'string' && b.text.length > 0) {
              out.push({ kind: 'assistant_text', text: b.text });
            }
            break;
          case 'thinking':
          case 'redacted_thinking': {
            const text = b.thinking ?? b.text;
            if (typeof text === 'string' && text.length > 0) {
              out.push({ kind: 'thinking', text });
            }
            break;
          }
          case 'tool_use':
          case 'server_tool_use':
            if (typeof b.id === 'string' && typeof b.name === 'string') {
              out.push({ kind: 'tool_use', toolUseId: b.id, toolName: b.name, input: b.input });
            }
            break;
          default:
            break;
        }
      }
      return out;
    }
    case 'user': {
      const out: ClaudeParseResult[] = [];
      for (const b of contentBlocks(raw)) {
        if (b.type !== 'tool_result' && b.type !== 'web_search_tool_result') continue;
        if (typeof b.tool_use_id !== 'string') continue;
        out.push({
          kind: 'tool_result',
          toolUseId: b.tool_use_id,
          output: b.content,
          ...(b.is_error === true ? { isError: true } : {}),
        });
      }
      return out;
    }
    case 'result': {
      const out: AgentEvent = { kind: 'result' };
      if (typeof raw.total_cost_usd === 'number') out.cost = raw.total_cost_usd;
      if (typeof raw.duration_ms === 'number') out.durationMs = raw.duration_ms;
      if (raw.is_error === true && typeof raw.subtype === 'string') out.error = raw.subtype;
      const usage = normalizeUsage(raw.usage ?? raw.message?.usage);
      if (usage !== null) out.usage = usage;
      if (typeof raw.message?.model === 'string') out.model = raw.message.model;
      return [out];
    }
    case 'system': {
      // Claude's `--output-format stream-json` system init line carries
      // `session_id`; surface it as a typed result so the driver can capture
      // the CLI's session uuid for resume/registry purposes.
      if (raw.subtype === 'init' && typeof raw.session_id === 'string') {
        return [{ kind: 'session_id', id: raw.session_id }];
      }
      return [];
    }
    case 'rate_limit_event': {
      // The CLI volunteers quota state mid-stream. Note `utilization` is a
      // fraction (0.78 == 78%), not a percentage.
      //
      // It is also optional: the CLI only puts a number on the payload once
      // the window passes its warning threshold (`status: allowed_warning`).
      // Under that, all it says is which window it is, that it is `allowed`,
      // and when it resets — which is still worth surfacing, so the window is
      // kept with a null utilization rather than dropped.
      const info = raw.rate_limit_info;
      if (!info || typeof info.rateLimitType !== 'string') return [];
      const utilization = typeof info.utilization === 'number' ? info.utilization : null;
      return [
        {
          kind: 'rate_limit',
          window: {
            limitType: info.rateLimitType,
            utilization,
            resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null,
            status: typeof info.status === 'string' ? info.status : null,
            isUsingOverage: info.isUsingOverage === true,
            observedAt: Date.now(),
          },
        },
      ];
    }
    default:
      // Unknown line types are ignored rather than treated as errors — the
      // CLI adds them over time.
      return [];
  }
}

/** `message.content` is an array of blocks, but a bare string for simple text. */
function contentBlocks(raw: RawClaudeMsg): RawContentBlock[] {
  const c = raw.message?.content;
  if (Array.isArray(c)) return c;
  if (typeof c === 'string' && c.length > 0) return [{ type: 'text', text: c }];
  return [];
}

function normalizeUsage(u: RawUsage | undefined): TurnUsage | null {
  if (!u) return null;
  const out: TurnUsage = {};
  if (typeof u.input_tokens === 'number') out.inputTokens = u.input_tokens;
  if (typeof u.output_tokens === 'number') out.outputTokens = u.output_tokens;
  if (typeof u.cache_read_input_tokens === 'number') out.cacheReadTokens = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === 'number') {
    out.cacheCreationTokens = u.cache_creation_input_tokens;
  }
  return Object.keys(out).length > 0 ? out : null;
}
