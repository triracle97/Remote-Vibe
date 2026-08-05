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
    expect(runningWork([])).toEqual({ shells: 0, monitors: 0 });
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
    expect(runningWork(msgs)).toEqual({ shells: 1, monitors: 1 });
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
