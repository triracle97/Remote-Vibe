import { describe, it, expect } from 'vitest';
import { parseGrokLine } from '../grok-parser.js';

describe('parseGrokLine', () => {
  it('ignores blank lines and non-JSON', () => {
    expect(parseGrokLine('')).toBeNull();
    expect(parseGrokLine('   ')).toBeNull();
    expect(parseGrokLine('not json')).toBeNull();
  });

  it('maps text and thought chunks', () => {
    expect(parseGrokLine('{"type":"text","data":"Hello"}')).toEqual({
      event: { kind: 'stream_delta', delta: 'Hello' },
    });
    expect(parseGrokLine('{"type":"thought","data":"Looking"}')).toEqual({
      event: { kind: 'thinking', text: 'Looking' },
    });
  });

  it('maps a tool call and only a finished update', () => {
    expect(parseGrokLine(JSON.stringify({
      type: 'tool_call',
      toolCallId: 'call_1',
      toolName: 'read_file',
      rawInput: { path: 'src/main.ts' },
    }))).toEqual({
      event: {
        kind: 'tool_use',
        toolUseId: 'call_1',
        toolName: 'read_file',
        input: { path: 'src/main.ts' },
      },
    });
    expect(parseGrokLine(JSON.stringify({
      type: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'in_progress',
    }))).toBeNull();
    expect(parseGrokLine(JSON.stringify({
      type: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'failed',
      rawOutput: { error: 'nope' },
    }))).toEqual({
      event: {
        kind: 'tool_result',
        toolUseId: 'call_1',
        output: { error: 'nope' },
        isError: true,
      },
    });
  });

  it('maps end to a result and keeps the session id', () => {
    const parsed = parseGrokLine(JSON.stringify({
      type: 'end',
      stopReason: 'end_turn',
      sessionId: 'abc-123',
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
    }));
    expect(parsed?.sessionId).toBe('abc-123');
    expect(parsed?.event).toEqual({
      kind: 'result',
      cost: 0.01,
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 },
    });
  });

  it('maps error lines to a failed result', () => {
    expect(parseGrokLine('{"type":"error","message":"nope"}')).toEqual({
      event: { kind: 'result', error: 'nope' },
    });
  });

  it('drops unknown event types', () => {
    expect(parseGrokLine('{"type":"plan","entries":[]}')).toEqual({ event: null });
  });
});
