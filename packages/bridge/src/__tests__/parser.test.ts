import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseClaudeLine } from '../parser.js';

const __filename = fileURLToPath(import.meta.url);
const fixture = readFileSync(
  join(dirname(__filename), '..', '..', 'test', 'fixtures', 'claude-stream.ndjson'),
  'utf8',
);
const lines = fixture.trim().split('\n');

describe('parseClaudeLine', () => {
  it('returns session_id discriminant for Claude system init line', () => {
    expect(parseClaudeLine(lines[0]!)).toEqual([{ kind: 'session_id', id: 'sess-1' }]);
  });

  it('returns session_id discriminant for an explicit Claude system init payload', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-uuid-xyz' });
    expect(parseClaudeLine(line)).toEqual([{ kind: 'session_id', id: 'claude-uuid-xyz' }]);
  });

  it('yields nothing for a system line without subtype=init', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'other', session_id: 'whatever' });
    expect(parseClaudeLine(line)).toEqual([]);
  });

  it('parses a content_block_delta into stream_delta', () => {
    expect(parseClaudeLine(lines[1]!)).toEqual([{ kind: 'stream_delta', delta: 'Hello' }]);
  });

  it('parses an assistant text message into assistant_text', () => {
    expect(parseClaudeLine(lines[3]!)).toEqual([{ kind: 'assistant_text', text: 'Hello, world' }]);
  });

  it('parses an assistant tool_use message into tool_use', () => {
    expect(parseClaudeLine(lines[4]!)).toEqual([
      { kind: 'tool_use', toolUseId: 'tu_1', toolName: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('parses a user tool_result message into tool_result', () => {
    expect(parseClaudeLine(lines[5]!)).toEqual([
      { kind: 'tool_result', toolUseId: 'tu_1', output: 'file.txt\n' },
    ]);
  });

  it('parses a result message', () => {
    expect(parseClaudeLine(lines[6]!)).toEqual([
      { kind: 'result', cost: 0.0042, durationMs: 1234 },
    ]);
  });

  it('yields nothing for unrecognized JSON', () => {
    expect(parseClaudeLine('{"type":"???"}')).toEqual([]);
  });

  it('yields nothing for malformed JSON', () => {
    expect(parseClaudeLine('not json')).toEqual([]);
  });

  // --- multi-block messages ---------------------------------------------
  // These are the cases the old parser silently dropped: it `return`ed from
  // inside the block loop, so only the first block of a message survived.

  it('emits every block of an assistant message, in order', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check that.' },
          { type: 'tool_use', id: 'tu_a', name: 'Read', input: { file_path: '/a.ts' } },
          { type: 'tool_use', id: 'tu_b', name: 'Grep', input: { pattern: 'x' } },
        ],
      },
    });
    expect(parseClaudeLine(line)).toEqual([
      { kind: 'assistant_text', text: 'Let me check that.' },
      { kind: 'tool_use', toolUseId: 'tu_a', toolName: 'Read', input: { file_path: '/a.ts' } },
      { kind: 'tool_use', toolUseId: 'tu_b', toolName: 'Grep', input: { pattern: 'x' } },
    ]);
  });

  it('emits every tool_result of a user message', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu_a', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'tu_b', content: 'boom', is_error: true },
        ],
      },
    });
    expect(parseClaudeLine(line)).toEqual([
      { kind: 'tool_result', toolUseId: 'tu_a', output: 'ok' },
      { kind: 'tool_result', toolUseId: 'tu_b', output: 'boom', isError: true },
    ]);
  });

  // --- thinking ----------------------------------------------------------

  it('surfaces thinking blocks, which used to be dropped entirely', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'The user wants X, so...' },
          { type: 'text', text: 'Here you go.' },
        ],
      },
    });
    expect(parseClaudeLine(line)).toEqual([
      { kind: 'thinking', text: 'The user wants X, so...' },
      { kind: 'assistant_text', text: 'Here you go.' },
    ]);
  });

  it('handles redacted thinking blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'redacted_thinking', text: '[redacted]' }] },
    });
    expect(parseClaudeLine(line)).toEqual([{ kind: 'thinking', text: '[redacted]' }]);
  });

  it('does not stream thinking deltas into the prose channel', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } },
    });
    expect(parseClaudeLine(line)).toEqual([]);
  });

  // --- result accounting -------------------------------------------------

  it('carries usage and model off the result line', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.5,
      duration_ms: 900,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
      },
      message: { model: 'claude-opus-5' },
    });
    expect(parseClaudeLine(line)).toEqual([
      {
        kind: 'result',
        cost: 0.5,
        durationMs: 900,
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 5,
          cacheCreationTokens: 2,
        },
        model: 'claude-opus-5',
      },
    ]);
  });

  it('reports an errored turn with its subtype', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
    });
    expect(parseClaudeLine(line)).toEqual([{ kind: 'result', error: 'error_max_turns' }]);
  });

  it('omits usage entirely when the CLI sends none', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 1 });
    expect(parseClaudeLine(line)).toEqual([{ kind: 'result', cost: 1 }]);
  });

  // --- robustness --------------------------------------------------------

  it('ignores message types the CLI added later, e.g. rate_limit_event', () => {
    // Observed live in `claude --output-format stream-json` output.
    expect(parseClaudeLine(JSON.stringify({ type: 'rate_limit_event' }))).toEqual([]);
  });

  it('ignores the headroom wrapper banner printed to stdout', () => {
    // `headroom wrap claude` echoes a banner before exec'ing the CLI, so these
    // lines land in the same stream as the NDJSON.
    for (const line of [
      '  ╔═══════════════════════════════════════════════╗',
      '  ║            HEADROOM WRAP: CLAUDE              ║',
      '  Launching Claude Code (API routed through Headroom)...',
      '  ANTHROPIC_BASE_URL=http://127.0.0.1:8787',
    ]) {
      expect(parseClaudeLine(line)).toEqual([]);
    }
  });

  it('accepts a bare string content payload', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: 'plain text' } });
    expect(parseClaudeLine(line)).toEqual([{ kind: 'assistant_text', text: 'plain text' }]);
  });

  it('skips blocks that are missing their identifying fields', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash' }, // no id
          { type: 'text', text: '' }, // empty
          { type: 'text', text: 'kept' },
        ],
      },
    });
    expect(parseClaudeLine(line)).toEqual([{ kind: 'assistant_text', text: 'kept' }]);
  });
});
