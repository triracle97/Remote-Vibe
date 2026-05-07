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
  it('returns null for the system init line', () => {
    expect(parseClaudeLine(lines[0]!)).toBeNull();
  });

  it('parses a content_block_delta into stream_delta', () => {
    const ev = parseClaudeLine(lines[1]!);
    expect(ev).toEqual({ kind: 'stream_delta', delta: 'Hello' });
  });

  it('parses an assistant text message into assistant_text', () => {
    const ev = parseClaudeLine(lines[3]!);
    expect(ev).toEqual({ kind: 'assistant_text', text: 'Hello, world' });
  });

  it('parses an assistant tool_use message into tool_use', () => {
    const ev = parseClaudeLine(lines[4]!);
    expect(ev).toEqual({
      kind: 'tool_use',
      toolUseId: 'tu_1',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
  });

  it('parses a user tool_result message into tool_result', () => {
    const ev = parseClaudeLine(lines[5]!);
    expect(ev).toEqual({
      kind: 'tool_result',
      toolUseId: 'tu_1',
      output: 'file.txt\n',
    });
  });

  it('parses a result message', () => {
    const ev = parseClaudeLine(lines[6]!);
    expect(ev).toEqual({ kind: 'result', cost: 0.0042, durationMs: 1234 });
  });

  it('returns null for unrecognized JSON', () => {
    expect(parseClaudeLine('{"type":"???"}')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseClaudeLine('not json')).toBeNull();
  });
});
