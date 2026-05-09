import { describe, it, expect, beforeEach } from 'vitest';
import { useTerminalsStore } from './terminals';

describe('useTerminalsStore', () => {
  beforeEach(() => {
    useTerminalsStore.setState({ terminals: {}, order: [] });
  });

  it('term_started adds an alive entry', () => {
    useTerminalsStore.getState().applyServerMsg({
      type: 'term_started',
      termId: 't1',
      cwd: '/Users/me/code/p',
      createdAt: 1,
      correlationId: 'c1',
    });
    const state = useTerminalsStore.getState();
    expect(state.terminals['t1']).toMatchObject({
      cwd: '/Users/me/code/p',
      createdAt: 1,
      alive: true,
    });
    expect(state.order).toEqual(['t1']);
  });

  it('term_exit flips alive=false', () => {
    const s = useTerminalsStore.getState();
    s.applyServerMsg({ type: 'term_started', termId: 't1', cwd: '/p', createdAt: 1, correlationId: 'c' });
    s.applyServerMsg({ type: 'term_exit', termId: 't1', exitCode: 0, signal: null });
    expect(useTerminalsStore.getState().terminals['t1']!.alive).toBe(false);
  });

  it('remove drops the entry and order entry', () => {
    const s = useTerminalsStore.getState();
    s.applyServerMsg({ type: 'term_started', termId: 't1', cwd: '/p', createdAt: 1, correlationId: 'c' });
    s.remove('t1');
    expect(useTerminalsStore.getState().terminals['t1']).toBeUndefined();
    expect(useTerminalsStore.getState().order).toEqual([]);
  });

  it('ignores other server msg types', () => {
    const s = useTerminalsStore.getState();
    s.applyServerMsg({ type: 'system', event: 'init' });
    expect(useTerminalsStore.getState().order).toEqual([]);
  });
});
