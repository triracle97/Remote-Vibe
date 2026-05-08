import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/bridge-client-singleton', () => ({
  getBridgeClient: vi.fn(),
}));

import { useSessionsStore } from './sessions';
import { getBridgeClient } from '../services/bridge-client-singleton';

beforeEach(() => {
  useSessionsStore.setState({ sessions: {}, order: [], activeId: null, transcriptOnly: {} });
  vi.clearAllMocks();
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

  it('markTranscriptOnly flips the flag for the given session', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    expect(useSessionsStore.getState().transcriptOnly['s1']).toBeUndefined();
    store.markTranscriptOnly('s1');
    expect(useSessionsStore.getState().transcriptOnly['s1']).toBe(true);
  });

  it('markTranscriptOnly works for sessions not yet in the store (deep link)', () => {
    useSessionsStore.getState().markTranscriptOnly('unknown-id');
    expect(useSessionsStore.getState().transcriptOnly['unknown-id']).toBe(true);
  });

  it('session_created for a session marked transcriptOnly does NOT add to order', () => {
    const store = useSessionsStore.getState();
    store.markTranscriptOnly('s1');
    store.applyServerMsg({
      type: 'system',
      event: 'session_created',
      sessionId: 's1',
      seq: 1,
      agent: 'claude',
      projectPath: '/p',
      createdAt: 1,
    });
    const next = useSessionsStore.getState();
    expect(next.sessions['s1']).toBeDefined();
    expect(next.order).toEqual([]);
  });

  it('flags preceding stream_deltas as superseded when assistant text arrives', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    store.applyServerMsg({
      type: 'stream_delta',
      sessionId: 's1',
      seq: 2,
      payload: { delta: 'hel' },
    });
    store.applyServerMsg({
      type: 'stream_delta',
      sessionId: 's1',
      seq: 3,
      payload: { delta: 'lo' },
    });
    store.applyServerMsg({
      type: 'assistant',
      sessionId: 's1',
      seq: 4,
      payload: { text: 'hello' },
    });
    const events = useSessionsStore.getState().sessions['s1']!.events;
    const deltas = events.filter((e) => e.type === 'stream_delta');
    expect(deltas).toHaveLength(2);
    expect(deltas.every((e) => (e as { superseded?: boolean }).superseded === true)).toBe(true);
    const assistant = events.find((e) => e.type === 'assistant');
    expect((assistant as { superseded?: boolean }).superseded).toBeUndefined();
  });

  it('does NOT supersede stream_deltas from a previous turn', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    // Turn 1: deltas + result
    store.applyServerMsg({
      type: 'stream_delta',
      sessionId: 's1',
      seq: 2,
      payload: { delta: 'hi' },
    });
    store.applyServerMsg({ type: 'result', sessionId: 's1', seq: 3, payload: {} });
    // Turn 2: deltas + assistant text
    store.applyServerMsg({
      type: 'stream_delta',
      sessionId: 's1',
      seq: 4,
      payload: { delta: 'world' },
    });
    store.applyServerMsg({
      type: 'assistant',
      sessionId: 's1',
      seq: 5,
      payload: { text: 'world' },
    });
    const events = useSessionsStore.getState().sessions['s1']!.events;
    const seq2 = events.find((e) => 'seq' in e && e.seq === 2)!;
    const seq4 = events.find((e) => 'seq' in e && e.seq === 4)!;
    expect((seq2 as { superseded?: boolean }).superseded).toBeUndefined(); // turn 1 delta NOT touched
    expect((seq4 as { superseded?: boolean }).superseded).toBe(true);
  });

  it('reload-replay (cold reload via history) reaches the same superseded set', () => {
    // Spec §5 + §8 test #3: replay the same events from a cold store and
    // verify the supersession walk re-derives identical superseded flags.
    const replay = [
      { type: 'system', event: 'session_created', sessionId: 's1', seq: 1 } as const,
      { type: 'stream_delta', sessionId: 's1', seq: 2, payload: { delta: 'hel' } } as const,
      { type: 'stream_delta', sessionId: 's1', seq: 3, payload: { delta: 'lo' } } as const,
      { type: 'assistant', sessionId: 's1', seq: 4, payload: { text: 'hello' } } as const,
    ];
    // Pass 1: live append path (event-by-event)
    const store1 = useSessionsStore.getState();
    for (const e of replay) store1.applyServerMsg(e);
    const liveDeltas = useSessionsStore
      .getState()
      .sessions['s1']!.events.filter((e) => e.type === 'stream_delta');
    const liveFlags = liveDeltas.map((e) => (e as { superseded?: boolean }).superseded === true);

    // Reset store to cold and re-load the same events via the history bulk-merge path.
    useSessionsStore.setState({ sessions: {}, order: [], activeId: null, transcriptOnly: {} });
    const store2 = useSessionsStore.getState();
    // Seed the session row first (history path requires existing summary).
    store2.applyServerMsg({
      type: 'session_list',
      sessions: [{ sessionId: 's1', agent: 'claude', projectPath: '/p', createdAt: 1 }],
    });
    store2.applyServerMsg({ type: 'history', sessionId: 's1', events: replay, hasMore: false });
    const replayDeltas = useSessionsStore
      .getState()
      .sessions['s1']!.events.filter((e) => e.type === 'stream_delta');
    const replayFlags = replayDeltas.map(
      (e) => (e as { superseded?: boolean }).superseded === true,
    );

    expect(replayFlags).toEqual(liveFlags);
    expect(replayFlags.every((f) => f === true)).toBe(true);
  });

  it('does NOT supersede on assistant events that have no text payload (e.g. tool_use)', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    store.applyServerMsg({
      type: 'stream_delta',
      sessionId: 's1',
      seq: 2,
      payload: { delta: 'hi' },
    });
    store.applyServerMsg({
      type: 'assistant',
      sessionId: 's1',
      seq: 3,
      payload: { toolUse: { kind: 'tool_use', toolUseId: 'tu1', toolName: 'Bash', input: {} } },
    });
    const events = useSessionsStore.getState().sessions['s1']!.events;
    const delta = events.find((e) => 'seq' in e && e.seq === 2)!;
    expect((delta as { superseded?: boolean }).superseded).toBeUndefined();
  });

  it('error session_dead flips per-session alive=false', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    store.applyServerMsg({
      type: 'error',
      code: 'session_dead',
      message: 'session is not alive',
      sessionId: 's1',
      correlationId: 'c1',
    });
    expect(useSessionsStore.getState().sessions['s1']!.alive).toBe(false);
  });

  it('resume(webSessionId) sends resume_session via WS and resolves on session_resumed reply', async () => {
    const send = vi.fn();
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });

    const promise = store.resume('s1');
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0] as {
      type: string;
      webSessionId: string;
      correlationId: string;
    };
    expect(sent.type).toBe('resume_session');
    expect(sent.webSessionId).toBe('s1');
    expect(typeof sent.correlationId).toBe('string');

    // Deliver the reply with the matching correlationId.
    useSessionsStore.getState().applyServerMsg({
      type: 'session_resumed',
      webSessionId: 's1',
      alive: true,
      correlationId: sent.correlationId,
    });
    await expect(promise).resolves.toBe('s1');
  });

  it('resumeFromHistory(entry) sends resume_session with agent + sessionId + projectPath', async () => {
    const send = vi.fn();
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });
    const entry = {
      agent: 'claude' as const,
      sessionId: 'cli-uuid',
      projectPath: '/p',
      mtime: 1,
      firstPrompt: 'hi',
    };
    const promise = useSessionsStore.getState().resumeFromHistory(entry);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0] as {
      type: string;
      agent: string;
      sessionId: string;
      projectPath: string;
      correlationId: string;
    };
    expect(sent.type).toBe('resume_session');
    expect(sent.agent).toBe('claude');
    expect(sent.sessionId).toBe('cli-uuid');
    expect(sent.projectPath).toBe('/p');
    expect(typeof sent.correlationId).toBe('string');

    // Bridge issues a fresh webSessionId; deliver the reply.
    useSessionsStore.getState().applyServerMsg({
      type: 'session_resumed',
      webSessionId: 'newWebId',
      alive: true,
      correlationId: sent.correlationId,
    });
    await expect(promise).resolves.toBe('newWebId');
  });

  it('on session_resumed reply for known webSessionId, alive flips to true', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    store.applyServerMsg({
      type: 'error',
      code: 'session_dead',
      message: 'd',
      sessionId: 's1',
      correlationId: 'c',
    });
    store.applyServerMsg({
      type: 'session_resumed',
      webSessionId: 's1',
      alive: true,
      correlationId: 'c2',
    });
    expect(useSessionsStore.getState().sessions['s1']!.alive).toBe(true);
  });
});
