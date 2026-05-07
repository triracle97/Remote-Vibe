import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionsStore } from './sessions';

beforeEach(() => {
  useSessionsStore.setState({ sessions: {}, order: [], activeId: null });
});

describe('sessions store', () => {
  it('appends a session_created lifecycle message', () => {
    useSessionsStore.getState().applyServerMsg({
      type: 'system',
      event: 'session_created',
      sessionId: 's1',
      seq: 1,
    });
    const s = useSessionsStore.getState();
    expect(s.order).toEqual(['s1']);
    expect(s.sessions['s1']?.events).toHaveLength(1);
    expect(s.sessions['s1']?.lastSeq).toBe(1);
    expect(s.sessions['s1']?.alive).toBe(true);
  });

  it('marks the session dead on session_ended', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    store.applyServerMsg({
      type: 'system',
      event: 'session_ended',
      sessionId: 's1',
      seq: 5,
      exitCode: 0,
    });
    const s = useSessionsStore.getState().sessions['s1']!;
    expect(s.alive).toBe(false);
    expect(s.lastSeq).toBe(5);
  });

  it('appends stream events and tracks lastSeq', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    store.applyServerMsg({ type: 'stream_delta', sessionId: 's1', seq: 2, payload: { delta: 'hi' } });
    store.applyServerMsg({ type: 'assistant', sessionId: 's1', seq: 3, payload: { text: 'hello' } });
    const s = useSessionsStore.getState().sessions['s1']!;
    expect(s.events).toHaveLength(3);
    expect(s.lastSeq).toBe(3);
  });

  it('replaces session list from session_list message', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({
      type: 'session_list',
      sessions: [
        { sessionId: 's1', agent: 'claude', projectPath: '/p', createdAt: 1 },
        { sessionId: 's2', agent: 'claude', projectPath: '/q', createdAt: 2 },
      ],
    });
    expect(useSessionsStore.getState().order).toEqual(['s1', 's2']);
  });

  it('setActive() only accepts known sessions', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    store.setActive('s1');
    expect(useSessionsStore.getState().activeId).toBe('s1');
    store.setActive('unknown');
    expect(useSessionsStore.getState().activeId).toBe('s1');
  });

  it('uses agent/projectPath/createdAt from session_created when present', () => {
    useSessionsStore.getState().applyServerMsg({
      type: 'system',
      event: 'session_created',
      sessionId: 's1',
      seq: 1,
      agent: 'claude',
      projectPath: '/Users/x/proj',
      createdAt: 100,
    });
    const s = useSessionsStore.getState().sessions['s1']!;
    expect(s.projectPath).toBe('/Users/x/proj');
    expect(s.createdAt).toBe(100);
  });

  it('merges history events by seq with dedup and advances lastSeq', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    store.applyServerMsg({
      type: 'stream_delta',
      sessionId: 's1',
      seq: 2,
      payload: { delta: 'a' },
    });
    store.applyServerMsg({
      type: 'history',
      sessionId: 's1',
      events: [
        { type: 'stream_delta', sessionId: 's1', seq: 2, payload: { delta: 'a' } },
        { type: 'stream_delta', sessionId: 's1', seq: 3, payload: { delta: 'b' } },
        { type: 'stream_delta', sessionId: 's1', seq: 4, payload: { delta: 'c' } },
      ],
      hasMore: false,
    });
    const s = useSessionsStore.getState().sessions['s1']!;
    expect(s.events.length).toBe(4); // session_created + 3 deltas, dup removed
    expect(s.lastSeq).toBe(4);
  });
});
