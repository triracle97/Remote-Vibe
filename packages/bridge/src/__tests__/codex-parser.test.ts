import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCodexLine } from '../codex-parser.js';

const __filename = fileURLToPath(import.meta.url);
const fixture = readFileSync(
  join(dirname(__filename), '..', '..', 'test', 'fixtures', 'codex-stream.jsonl'),
  'utf8',
);
const lines = fixture.trim().split('\n');

describe('parseCodexLine', () => {
  it('captures session_id from session_init', () => {
    expect(parseCodexLine(lines[0]!)).toEqual({ kind: 'session_id', id: 'sess-codex-1' });
  });

  it('parses agent_message into assistant_text', () => {
    expect(parseCodexLine(lines[1]!)).toEqual({ kind: 'assistant_text', text: 'Hello from Codex' });
  });

  it('parses function_call into tool_use', () => {
    expect(parseCodexLine(lines[2]!)).toEqual({
      kind: 'tool_use',
      toolUseId: 'fc_1',
      toolName: 'shell',
      input: { command: 'ls' },
    });
  });

  it('parses function_call_output into tool_result', () => {
    expect(parseCodexLine(lines[3]!)).toEqual({
      kind: 'tool_result',
      toolUseId: 'fc_1',
      output: 'file.txt\n',
    });
  });

  it('parses task_completed into result with cost + durationMs', () => {
    expect(parseCodexLine(lines[4]!)).toEqual({ kind: 'result', cost: 0.001, durationMs: 250 });
  });

  it('returns null for unknown event type', () => {
    expect(parseCodexLine('{"type":"???"}')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseCodexLine('not json')).toBeNull();
  });
});
