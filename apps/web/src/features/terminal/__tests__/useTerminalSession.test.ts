import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminalSession } from '../useTerminalSession';
import { useTerminalsStore } from '../../../store/terminals';
import type { ClientMsg, ServerMsg } from '../../../types/protocol';

let sent: ClientMsg[];
let listeners: Array<(m: ServerMsg) => void>;

vi.mock('../../../services/bridge-client-singleton', () => ({
  getBridgeClient: () => ({
    send: (m: ClientMsg) => { sent.push(m); },
    on: (event: string, fn: (m: ServerMsg) => void) => {
      if (event === 'message') listeners.push(fn);
      return () => { listeners = listeners.filter((l) => l !== fn); };
    },
  }),
}));

describe('useTerminalSession', () => {
  beforeEach(() => {
    sent = [];
    listeners = [];
    useTerminalsStore.setState({ terminals: {}, order: [] });
  });

  it('routes term_output to the onData callback for the matching termId', () => {
    const onData = vi.fn();
    renderHook(() => useTerminalSession({ termId: 't1', onData }));
    act(() => { listeners.forEach((l) => l({ type: 'term_output', termId: 't1', data: 'hi' })); });
    expect(onData).toHaveBeenCalledWith('hi');
  });

  it('ignores term_output for other termIds', () => {
    const onData = vi.fn();
    renderHook(() => useTerminalSession({ termId: 't1', onData }));
    act(() => { listeners.forEach((l) => l({ type: 'term_output', termId: 'OTHER', data: 'nope' })); });
    expect(onData).not.toHaveBeenCalled();
  });

  it('returns sendInput that emits term_input', () => {
    const { result } = renderHook(() => useTerminalSession({ termId: 't1', onData: () => {} }));
    act(() => { result.current.sendInput('ls\n'); });
    expect(sent).toContainEqual({ type: 'term_input', termId: 't1', data: 'ls\n' });
  });

  it('returns resize that emits term_resize', () => {
    const { result } = renderHook(() => useTerminalSession({ termId: 't1', onData: () => {} }));
    act(() => { result.current.resize(120, 40); });
    expect(sent).toContainEqual({ type: 'term_resize', termId: 't1', cols: 120, rows: 40 });
  });

  it('emits term_kill on unmount', () => {
    const { unmount } = renderHook(() => useTerminalSession({ termId: 't1', onData: () => {} }));
    unmount();
    expect(sent.some((m) => m.type === 'term_kill' && m.termId === 't1')).toBe(true);
  });
});
