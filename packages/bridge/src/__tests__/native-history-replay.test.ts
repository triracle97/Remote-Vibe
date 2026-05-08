import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReplayEvents } from '../native-history-replay.js';

let workDir: string;

async function writeJsonl(name: string, lines: unknown[]): Promise<string> {
  const filePath = join(workDir, name);
  await fsp.writeFile(filePath, lines.map((l) => JSON.stringify(l)).join('\n'));
  return filePath;
}

beforeEach(async () => {
  workDir = await fsp.mkdtemp(join(tmpdir(), 'replay-'));
});

afterEach(async () => {
  await fsp.rm(workDir, { recursive: true, force: true });
});

describe('loadReplayEvents — Claude', () => {
  it('parses user text + assistant text + tool_use + tool_result', async () => {
    const filePath = await writeJsonl('claude.jsonl', [
      // Pre-prompt metadata that should be ignored.
      { type: 'queue-operation' },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hi there' },
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'README.md\n' },
          ],
        },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Done.' }] },
      },
    ]);
    const events = await loadReplayEvents('claude', filePath);
    expect(events).toEqual([
      { type: 'user', payload: { text: 'Hello' } },
      { type: 'assistant', payload: { text: 'Hi there' } },
      {
        type: 'assistant',
        payload: {
          toolUse: {
            kind: 'tool_use',
            toolUseId: 'tu_1',
            toolName: 'Bash',
            input: { command: 'ls' },
          },
        },
      },
      {
        type: 'tool_result',
        payload: { kind: 'tool_result', toolUseId: 'tu_1', output: 'README.md\n' },
      },
      { type: 'assistant', payload: { text: 'Done.' } },
    ]);
  });

  it('handles user.message.content as a plain string (legacy shape)', async () => {
    const filePath = await writeJsonl('claude-str.jsonl', [
      { type: 'user', message: { role: 'user', content: 'Plain string prompt' } },
    ]);
    const events = await loadReplayEvents('claude', filePath);
    expect(events).toEqual([{ type: 'user', payload: { text: 'Plain string prompt' } }]);
  });

  it('skips malformed JSON lines', async () => {
    const filePath = join(workDir, 'broken.jsonl');
    await fsp.writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'text', text: 'Before' }] },
        }),
        '{ this is not JSON',
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'After' }] },
        }),
      ].join('\n'),
    );
    const events = await loadReplayEvents('claude', filePath);
    expect(events.map((e) => e.type)).toEqual(['user', 'assistant']);
  });

  it('returns empty array when file is missing', async () => {
    const events = await loadReplayEvents('claude', join(workDir, 'nope.jsonl'));
    expect(events).toEqual([]);
  });
});

describe('loadReplayEvents — Codex', () => {
  it('parses event_msg user/agent + response_item function_call/output', async () => {
    const filePath = await writeJsonl('codex.jsonl', [
      { type: 'session_meta', payload: { id: 'cdx-1', cwd: '/tmp' } },
      // Developer/system prompts that should be ignored.
      {
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '...' }] },
      },
      {
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Run ls', images: [] },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'shell',
          arguments: '{"command":["ls"]}',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'README.md\n',
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Listed files.' },
      },
    ]);
    const events = await loadReplayEvents('codex', filePath);
    expect(events).toEqual([
      { type: 'user', payload: { text: 'Run ls' } },
      {
        type: 'assistant',
        payload: {
          toolUse: {
            kind: 'tool_use',
            toolUseId: 'call_1',
            toolName: 'shell',
            input: { command: ['ls'] },
          },
        },
      },
      {
        type: 'tool_result',
        payload: { kind: 'tool_result', toolUseId: 'call_1', output: 'README.md\n' },
      },
      { type: 'assistant', payload: { text: 'Listed files.' } },
    ]);
  });

  it('keeps function_call.arguments as raw string when not valid JSON', async () => {
    const filePath = await writeJsonl('codex-bad-args.jsonl', [
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'c2',
          name: 'shell',
          arguments: 'not json',
        },
      },
    ]);
    const [event] = await loadReplayEvents('codex', filePath);
    expect(event).toEqual({
      type: 'assistant',
      payload: {
        toolUse: {
          kind: 'tool_use',
          toolUseId: 'c2',
          toolName: 'shell',
          input: 'not json',
        },
      },
    });
  });
});

describe('loadReplayEvents — cap', () => {
  it('truncates to last 1500 events', async () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 2000; i++) {
      lines.push({
        type: 'user',
        message: { content: [{ type: 'text', text: `m${i}` }] },
      });
    }
    const filePath = await writeJsonl('big.jsonl', lines);
    const events = await loadReplayEvents('claude', filePath);
    expect(events.length).toBe(1500);
    // Tail-truncation: first remaining event should be m500.
    expect(events[0]).toEqual({ type: 'user', payload: { text: 'm500' } });
    expect(events[events.length - 1]).toEqual({
      type: 'user',
      payload: { text: 'm1999' },
    });
  });
});
