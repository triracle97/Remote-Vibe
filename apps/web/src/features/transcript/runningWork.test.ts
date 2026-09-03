import { describe, it, expect } from 'vitest';
import { runningWork } from './runningWork';
import type { ToolCallMessage, ViewMessage } from './projection';

function call(over: Partial<ToolCallMessage>): ToolCallMessage {
  return {
    kind: 'tool_call',
    id: over.toolUseId ?? 't1',
    toolUseId: over.toolUseId ?? 't1',
    toolName: 'Bash',
    input: {},
    status: 'ok',
    ...over,
  } as ToolCallMessage;
}

const bg = (toolUseId: string, output?: unknown, status: ToolCallMessage['status'] = 'ok') =>
  call({
    toolUseId,
    toolName: 'Bash',
    input: { command: 'npm test', run_in_background: true },
    status,
    ...(output !== undefined ? { output } : {}),
  });

describe('runningWork', () => {
  it('counts nothing for an empty transcript', () => {
    expect(runningWork([])).toEqual({ shells: 0, monitors: 0, subagents: 0, workflows: 0 });
  });

  it('ignores a foreground Bash', () => {
    const msgs: ViewMessage[] = [
      call({ toolName: 'Bash', input: { command: 'ls' }, status: 'ok' }),
    ];
    expect(runningWork(msgs).shells).toBe(0);
  });

  it('counts a background Bash even though its tool call already succeeded', () => {
    // This is the whole point: the call returns instantly, the shell does not.
    const msgs: ViewMessage[] = [bg('t1', { shell_id: 'bash_1' })];
    expect(runningWork(msgs).shells).toBe(1);
  });

  it('counts a just-started shell that has no id yet', () => {
    const msgs: ViewMessage[] = [bg('t1', undefined, 'running')];
    expect(runningWork(msgs).shells).toBe(1);
  });

  it('does not count a background Bash that failed to start', () => {
    const msgs: ViewMessage[] = [bg('t1', { error: 'nope' }, 'error')];
    expect(runningWork(msgs).shells).toBe(0);
  });

  it('closes a shell when it is killed', () => {
    const msgs: ViewMessage[] = [
      bg('t1', { shell_id: 'bash_1' }),
      call({ toolUseId: 't2', toolName: 'KillShell', input: { shell_id: 'bash_1' } }),
    ];
    expect(runningWork(msgs).shells).toBe(0);
  });

  it('closes a shell when BashOutput reports it completed', () => {
    const msgs: ViewMessage[] = [
      bg('t1', { shell_id: 'bash_1' }),
      call({
        toolUseId: 't2',
        toolName: 'BashOutput',
        input: { bash_id: 'bash_1' },
        output: { status: 'completed' },
      }),
    ];
    expect(runningWork(msgs).shells).toBe(0);
  });

  it('reads a completion out of the text form too', () => {
    const msgs: ViewMessage[] = [
      bg('t1', { shell_id: 'bash_1' }),
      call({
        toolUseId: 't2',
        toolName: 'BashOutput',
        input: { bash_id: 'bash_1' },
        output: '<status>completed</status>\nall tests passed',
      }),
    ];
    expect(runningWork(msgs).shells).toBe(0);
  });

  it('keeps a shell open when BashOutput shows it is still going', () => {
    const msgs: ViewMessage[] = [
      bg('t1', { shell_id: 'bash_1' }),
      call({
        toolUseId: 't2',
        toolName: 'BashOutput',
        input: { bash_id: 'bash_1' },
        output: { status: 'running', output: 'still building…' },
      }),
    ];
    expect(runningWork(msgs).shells).toBe(1);
  });

  it('tracks several shells independently', () => {
    const msgs: ViewMessage[] = [
      bg('t1', { shell_id: 'bash_1' }),
      bg('t2', { shell_id: 'bash_2' }),
      bg('t3', { shell_id: 'bash_3' }),
      call({ toolUseId: 't4', toolName: 'KillShell', input: { shell_id: 'bash_2' } }),
    ];
    expect(runningWork(msgs).shells).toBe(2);
  });

  it('counts a Monitor only while its call is still running', () => {
    expect(
      runningWork([call({ toolUseId: 'm1', toolName: 'Monitor', status: 'running' })]).monitors,
    ).toBe(1);
    expect(
      runningWork([call({ toolUseId: 'm1', toolName: 'Monitor', status: 'ok' })]).monitors,
    ).toBe(0);
  });

  it('reports shells and monitors together', () => {
    const msgs: ViewMessage[] = [
      bg('t1', { shell_id: 'bash_1' }),
      call({ toolUseId: 'm1', toolName: 'Monitor', status: 'running' }),
    ];
    expect(runningWork(msgs)).toEqual({ shells: 1, monitors: 1, subagents: 0, workflows: 0 });
  });

  it('counts a subagent for as long as its call is open', () => {
    // A subagent *is* its tool call — it holds it open for its whole life, so
    // unlike a background shell there is nothing to track separately.
    const running: ViewMessage[] = [
      call({ toolUseId: 'a1', toolName: 'Task', status: 'running' }),
      call({ toolUseId: 'a2', toolName: 'Task', status: 'running' }),
      call({ toolUseId: 'a3', toolName: 'Task', status: 'ok' }),
    ];
    expect(runningWork(running).subagents).toBe(2);
  });

  it('counts a workflow separately from the agents it runs', () => {
    const msgs: ViewMessage[] = [
      call({ toolUseId: 'w1', toolName: 'Workflow', status: 'running' }),
      call({ toolUseId: 'a1', toolName: 'Task', status: 'running' }),
    ];
    expect(runningWork(msgs)).toEqual({ shells: 0, monitors: 0, subagents: 1, workflows: 1 });
  });

  it('accepts the camelCase spellings as well', () => {
    const msgs: ViewMessage[] = [
      call({
        toolUseId: 't1',
        toolName: 'Bash',
        input: { command: 'x', runInBackground: true },
        output: { shellId: 'bash_9' },
      }),
      call({ toolUseId: 't2', toolName: 'KillShell', input: { shellId: 'bash_9' } }),
    ];
    expect(runningWork(msgs).shells).toBe(0);
  });
});

describe('background work started by a subagent', () => {
  it('counts a shell a delegated agent opened', () => {
    // Nesting subagent output under its call took this work out of the flat
    // list, and the count silently stopped seeing any of it.
    const msgs: ViewMessage[] = [
      call({
        toolUseId: 'task1',
        toolName: 'Task',
        status: 'running',
        subagent: [bg('t1', { shell_id: 'bash_1' })],
      } as Partial<ToolCallMessage>),
    ];
    // One agent working, and the shell it left running.
    expect(runningWork(msgs)).toEqual({ shells: 1, monitors: 0, subagents: 1, workflows: 0 });
  });

  it('counts a monitor and a nested agent at any depth', () => {
    const msgs: ViewMessage[] = [
      call({
        toolUseId: 'w1',
        toolName: 'Workflow',
        status: 'running',
        subagent: [
          call({ toolUseId: 'm1', toolName: 'Monitor', status: 'running' }),
          call({
            toolUseId: 'task1',
            toolName: 'Task',
            status: 'running',
            subagent: [call({ toolUseId: 'm2', toolName: 'Monitor', status: 'running' })],
          } as Partial<ToolCallMessage>),
        ],
      } as Partial<ToolCallMessage>),
    ];
    expect(runningWork(msgs)).toEqual({ shells: 0, monitors: 2, subagents: 1, workflows: 1 });
  });

  it('lets a subagent close a shell the main agent opened', () => {
    // Shell ids are session-wide, so whoever polls the shell closes it.
    const msgs: ViewMessage[] = [
      bg('t1', { shell_id: 'bash_1' }),
      call({
        toolUseId: 'task1',
        toolName: 'Task',
        status: 'ok',
        subagent: [
          call({
            toolUseId: 'b1',
            toolName: 'BashOutput',
            input: { shell_id: 'bash_1' },
            output: { status: 'completed' },
          }),
        ],
      } as Partial<ToolCallMessage>),
    ];
    expect(runningWork(msgs).shells).toBe(0);
  });
});

describe('shell ids quoted in prose', () => {
  it('matches a text-reported id against the BashOutput that closes it', () => {
    // The background Bash reports its id as text, not a field. Keyed by the
    // tool-use id instead, the closing BashOutput matched nothing and the
    // shell was counted forever — a number that only ever went up.
    const msgs: ViewMessage[] = [
      bg('t1', 'Command running in background with shell ID: bash_7'),
      call({
        toolUseId: 'b1',
        toolName: 'BashOutput',
        input: { bash_id: 'bash_7' },
        output: '<status>completed</status>',
      }),
    ];
    expect(runningWork(msgs).shells).toBe(0);
  });

  it('finds a bare bash_N in the output too', () => {
    const msgs: ViewMessage[] = [
      bg('t1', 'started as bash_3'),
      call({ toolUseId: 'k1', toolName: 'KillShell', input: { shell_id: 'bash_3' } }),
    ];
    expect(runningWork(msgs).shells).toBe(0);
  });

  it('still falls back to the tool-use id when nothing names a shell', () => {
    expect(runningWork([bg('t1', 'no id here')]).shells).toBe(1);
  });
});

describe('async agents', () => {
  it('counts an agent whose call returned but which is still working', () => {
    // `Agent` returns "launched" at once; the call reads `ok` for as long as
    // the agent works. Counting `running` calls never saw it.
    const msgs: ViewMessage[] = [
      call({ toolUseId: 'a1', toolName: 'Agent', status: 'ok', subagent: [], subagentRunning: true } as Partial<ToolCallMessage>),
    ];
    expect(runningWork(msgs).subagents).toBe(1);
  });

  it('stops counting it once the projection says it is done', () => {
    const msgs: ViewMessage[] = [
      call({ toolUseId: 'a1', toolName: 'Agent', status: 'ok', subagent: [], subagentRunning: false } as Partial<ToolCallMessage>),
    ];
    expect(runningWork(msgs).subagents).toBe(0);
  });

  it('counts a live agent whose call is out of view', () => {
    const msgs: ViewMessage[] = [
      call({ toolUseId: 'gone', toolName: '(subagent)', status: 'running', subagent: [], subagentRunning: true } as Partial<ToolCallMessage>),
    ];
    expect(runningWork(msgs).subagents).toBe(1);
  });

  it('counts a workflow whose agents are still working', () => {
    const msgs: ViewMessage[] = [
      call({ toolUseId: 'w1', toolName: 'Workflow', status: 'ok', subagent: [], subagentRunning: true } as Partial<ToolCallMessage>),
    ];
    expect(runningWork(msgs).workflows).toBe(1);
  });
});
