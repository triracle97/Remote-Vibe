import { describe, it, expect } from 'vitest';
import { projectEvents, type ToolCallMessage, type ViewMessage } from './projection';
import type { SessionEvent } from '../../store/sessions';

let seq = 0;
function reset(): void {
  seq = 0;
}

function assistantText(text: string, receivedAt?: number): SessionEvent {
  seq += 1;
  return { type: 'assistant', sessionId: 's', seq, payload: { text }, ...(receivedAt ? { receivedAt } : {}) } as SessionEvent;
}
function thinking(text: string): SessionEvent {
  seq += 1;
  return { type: 'assistant', sessionId: 's', seq, payload: { thinking: text } } as SessionEvent;
}
function toolUse(
  toolUseId: string,
  toolName: string,
  input: unknown,
  receivedAt?: number,
): SessionEvent {
  seq += 1;
  return {
    type: 'assistant',
    sessionId: 's',
    seq,
    payload: { toolUse: { toolUseId, toolName, input } },
    ...(receivedAt ? { receivedAt } : {}),
  } as SessionEvent;
}
function toolResult(
  toolUseId: string,
  output: unknown,
  opts: { isError?: boolean; receivedAt?: number } = {},
): SessionEvent {
  seq += 1;
  return {
    type: 'tool_result',
    sessionId: 's',
    seq,
    payload: { toolUseId, output, ...(opts.isError ? { isError: true } : {}) },
    ...(opts.receivedAt ? { receivedAt: opts.receivedAt } : {}),
  } as SessionEvent;
}
function userText(text: string): SessionEvent {
  seq += 1;
  return { type: 'user', sessionId: 's', seq, payload: { text } } as SessionEvent;
}
function result(payload: Record<string, unknown> = {}): SessionEvent {
  seq += 1;
  return { type: 'result', sessionId: 's', seq, payload } as SessionEvent;
}

const kinds = (m: ViewMessage[]): string[] => m.map((x) => x.kind);

describe('projectEvents', () => {
  it('pairs a tool call with its result', () => {
    reset();
    const out = projectEvents([
      toolUse('t1', 'Bash', { command: 'ls' }),
      toolResult('t1', 'a.txt\n'),
    ]);
    expect(out).toHaveLength(1);
    const call = out[0] as ToolCallMessage;
    expect(call.kind).toBe('tool_call');
    expect(call.toolName).toBe('Bash');
    expect(call.status).toBe('ok');
    expect(call.output).toBe('a.txt\n');
  });

  it('marks an errored tool result', () => {
    reset();
    const out = projectEvents([
      toolUse('t1', 'Bash', { command: 'false' }),
      toolResult('t1', 'boom', { isError: true }),
    ]);
    expect((out[0] as ToolCallMessage).status).toBe('error');
  });

  it('leaves an unresolved call running', () => {
    reset();
    const out = projectEvents([toolUse('t1', 'Bash', {})]);
    expect((out[0] as ToolCallMessage).status).toBe('running');
  });

  it('pairs out-of-order results by id, not position', () => {
    reset();
    const out = projectEvents([
      toolUse('t1', 'Read', {}),
      toolUse('t2', 'Grep', {}),
      toolResult('t2', 'grep done'),
      toolResult('t1', 'read done'),
    ]);
    const calls = out as ToolCallMessage[];
    expect(calls[0]!.toolName).toBe('Read');
    expect(calls[0]!.output).toBe('read done');
    expect(calls[1]!.toolName).toBe('Grep');
    expect(calls[1]!.output).toBe('grep done');
  });

  it('computes duration from live arrival stamps', () => {
    reset();
    const out = projectEvents([
      toolUse('t1', 'Bash', {}, 1000),
      toolResult('t1', 'ok', { receivedAt: 1750 }),
    ]);
    expect((out[0] as ToolCallMessage).durationMs).toBe(750);
  });

  it('omits duration for replayed history that has no stamps', () => {
    reset();
    const out = projectEvents([toolUse('t1', 'Bash', {}), toolResult('t1', 'ok')]);
    expect((out[0] as ToolCallMessage).durationMs).toBeUndefined();
  });

  it('surfaces a result whose call was never seen, rather than dropping it', () => {
    reset();
    const out = projectEvents([toolResult('orphan', 'output')]);
    expect(out).toHaveLength(1);
    expect((out[0] as ToolCallMessage).toolName).toBe('(unknown)');
    expect((out[0] as ToolCallMessage).status).toBe('ok');
  });

  it('merges consecutive assistant text into one block', () => {
    reset();
    const out = projectEvents([assistantText('First half.'), assistantText('Second half.')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'text', role: 'assistant', text: 'First half.\n\nSecond half.' });
  });

  it('does not merge across a tool call', () => {
    reset();
    const out = projectEvents([
      assistantText('Before.'),
      toolUse('t1', 'Read', {}),
      assistantText('After.'),
    ]);
    expect(kinds(out)).toEqual(['text', 'tool_call', 'text']);
  });

  it('does not merge assistant text into a user turn', () => {
    reset();
    const out = projectEvents([userText('hi'), assistantText('hello')]);
    expect(kinds(out)).toEqual(['text', 'text']);
    expect(out[0]).toMatchObject({ role: 'user' });
    expect(out[1]).toMatchObject({ role: 'assistant' });
  });

  it('keeps thinking as its own block', () => {
    reset();
    const out = projectEvents([thinking('hmm...'), assistantText('answer')]);
    expect(kinds(out)).toEqual(['thinking', 'text']);
    expect(out[0]).toMatchObject({ text: 'hmm...' });
  });

  it('skips superseded stream deltas and the deltas themselves', () => {
    reset();
    const delta = { type: 'stream_delta', sessionId: 's', seq: 99, payload: { delta: 'x' } } as SessionEvent;
    expect(projectEvents([delta])).toHaveLength(0);
  });

  it('closes any still-running tool when the turn ends', () => {
    reset();
    const out = projectEvents([toolUse('t1', 'Bash', {}), result({ cost: 1 })]);
    expect((out[0] as ToolCallMessage).status).toBe('ok');
    expect(out[1]).toMatchObject({ kind: 'turn_end', cost: 1 });
  });

  it('marks a dangling tool as errored when the turn itself errored', () => {
    reset();
    const out = projectEvents([toolUse('t1', 'Bash', {}), result({ error: 'error_max_turns' })]);
    expect((out[0] as ToolCallMessage).status).toBe('error');
  });

  it('carries usage and model onto turn_end', () => {
    reset();
    const out = projectEvents([
      result({ usage: { inputTokens: 5, outputTokens: 7 }, model: 'claude-opus-5', durationMs: 12 }),
    ]);
    expect(out[0]).toMatchObject({
      kind: 'turn_end',
      usage: { inputTokens: 5, outputTokens: 7 },
      model: 'claude-opus-5',
      durationMs: 12,
    });
  });

  it('renders lifecycle events as notices', () => {
    const events = [
      { type: 'system', event: 'session_created', sessionId: 's', seq: 1 },
      { type: 'system', event: 'session_ended', sessionId: 's', seq: 2, exitCode: 1, reason: 'agent_exit' },
    ] as SessionEvent[];
    const out = projectEvents(events);
    expect(out[0]).toMatchObject({ kind: 'notice', text: 'session started', tone: 'info' });
    expect(out[1]).toMatchObject({ tone: 'error' });
    expect((out[1] as { text: string }).text).toContain('agent_exit');
  });

  it('gives every message a stable unique key', () => {
    reset();
    const out = projectEvents([
      userText('a'),
      toolUse('t1', 'Read', {}),
      toolResult('t1', 'x'),
      result(),
    ]);
    const ids = out.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries the image count on a user turn', () => {
    const e = { type: 'user', sessionId: 's', seq: 1, payload: { text: 'look', imageCount: 2 } } as SessionEvent;
    expect(projectEvents([e])[0]).toMatchObject({ imageCount: 2 });
  });
});

describe('file diff extraction', () => {
  it('reads an Edit as a before/after pair', () => {
    reset();
    const out = projectEvents([
      toolUse('t1', 'Edit', { file_path: '/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' }),
    ]);
    expect((out[0] as ToolCallMessage).fileDiffs).toEqual([
      { filePath: '/a.ts', oldString: 'const a = 1', newString: 'const a = 2', created: false },
    ]);
  });

  it('reads a Write as a creation', () => {
    reset();
    const out = projectEvents([toolUse('t1', 'Write', { file_path: '/new.ts', content: 'hi' })]);
    expect((out[0] as ToolCallMessage).fileDiffs).toEqual([
      { filePath: '/new.ts', newString: 'hi', created: true },
    ]);
  });

  it('reads every edit of a MultiEdit', () => {
    reset();
    const out = projectEvents([
      toolUse('t1', 'MultiEdit', {
        file_path: '/a.ts',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      }),
    ]);
    expect((out[0] as ToolCallMessage).fileDiffs).toHaveLength(2);
  });

  it('attaches no diffs to a non-mutating tool', () => {
    reset();
    const out = projectEvents([toolUse('t1', 'Read', { file_path: '/a.ts' })]);
    expect((out[0] as ToolCallMessage).fileDiffs).toBeUndefined();
  });

  it('tolerates malformed edit arguments', () => {
    reset();
    const out = projectEvents([
      toolUse('t1', 'Edit', { file_path: '/a.ts' }),
      toolUse('t2', 'Edit', { old_string: 'x', new_string: 'y' }),
      toolUse('t3', 'MultiEdit', { file_path: '/a.ts', edits: 'nope' }),
      toolUse('t4', 'Write', { file_path: '/a.ts', content: 123 }),
    ]);
    for (const m of out) expect((m as ToolCallMessage).fileDiffs).toBeUndefined();
  });
});
