import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionsStore } from './sessions';
import type { ServerMsg } from '../types/protocol';

/**
 * Names arrive on three different paths — `session_list`, `session_renamed`,
 * and (implicitly) the replayed `session_created` — and the last of those used
 * to rebuild the view from scratch and drop the name. These pin the seams.
 */
describe('session name propagation', () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: {},
      order: [],
      activeId: null,
      transcriptOnly: {},
      pendingNames: {},
    });
  });

  const created = (sessionId: string): ServerMsg =>
    ({
      type: 'system',
      event: 'session_created',
      sessionId,
      seq: 1,
      agent: 'claude',
      projectPath: '/p',
      createdAt: 1,
    }) as ServerMsg;

  const renamed = (sessionId: string, name: string): ServerMsg =>
    ({ type: 'session_renamed', sessionId, name, correlationId: '' }) as ServerMsg;

  it('keeps the name when session_created replays for an already-named session', () => {
    const apply = useSessionsStore.getState().applyServerMsg;
    apply(created('s1'));
    apply(renamed('s1', 'Fix the toast'));
    expect(useSessionsStore.getState().sessions.s1!.name).toBe('Fix the toast');

    // Opening the session replays the bridge's buffered lifecycle events.
    apply(created('s1'));
    expect(useSessionsStore.getState().sessions.s1!.name).toBe('Fix the toast');
  });

  it('parks a rename for a session this tab has not opened, then applies it', () => {
    const apply = useSessionsStore.getState().applyServerMsg;
    // Renamed on the board; this store has no view for it yet.
    apply(renamed('s2', 'From the board'));
    expect(useSessionsStore.getState().sessions.s2).toBeUndefined();
    expect(useSessionsStore.getState().pendingNames.s2).toBe('From the board');

    apply(created('s2'));
    expect(useSessionsStore.getState().sessions.s2!.name).toBe('From the board');
  });

  it('prefers a later rename over an earlier parked one', () => {
    const apply = useSessionsStore.getState().applyServerMsg;
    apply(renamed('s3', 'stale'));
    apply(created('s3'));
    apply(renamed('s3', 'fresh'));
    apply(created('s3'));
    expect(useSessionsStore.getState().sessions.s3!.name).toBe('fresh');
  });

  it('leaves an unnamed session unnamed rather than inventing one', () => {
    const apply = useSessionsStore.getState().applyServerMsg;
    apply(created('s4'));
    expect(useSessionsStore.getState().sessions.s4!.name).toBeUndefined();
  });

  it('session_ended keeps the name', () => {
    const apply = useSessionsStore.getState().applyServerMsg;
    apply(created('s5'));
    apply(renamed('s5', 'Done thing'));
    apply({ type: 'system', event: 'session_ended', sessionId: 's5', seq: 2 } as ServerMsg);
    expect(useSessionsStore.getState().sessions.s5!.name).toBe('Done thing');
    expect(useSessionsStore.getState().sessions.s5!.alive).toBe(false);
  });
});
