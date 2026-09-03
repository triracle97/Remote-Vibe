import { describe, it, expect } from 'vitest';
import { isStreamingText, isTurnRunning } from './turnState';
import type { SessionEvent } from '../../store/sessions';

const user = (seq: number): SessionEvent =>
  ({ type: 'user', sessionId: 's', seq, payload: { text: 'go' } }) as SessionEvent;
const result = (seq: number): SessionEvent =>
  ({ type: 'result', sessionId: 's', seq, payload: {} }) as SessionEvent;
const assistant = (seq: number): SessionEvent =>
  ({ type: 'assistant', sessionId: 's', seq, payload: { text: 'hi' } }) as SessionEvent;
const created = (seq: number): SessionEvent =>
  ({ type: 'system', event: 'session_created', sessionId: 's', seq }) as SessionEvent;
const ended = (seq: number): SessionEvent =>
  ({ type: 'system', event: 'session_ended', sessionId: 's', seq }) as SessionEvent;

describe('isTurnRunning', () => {
  it('is idle for a session that has never run', () => {
    // Showing a stop button here would read as a bug.
    expect(isTurnRunning([])).toBe(false);
    expect(isTurnRunning([created(1)])).toBe(false);
  });

  it('is running between a user turn and its result', () => {
    expect(isTurnRunning([created(1), user(2)])).toBe(true);
    expect(isTurnRunning([created(1), user(2), assistant(3)])).toBe(true);
  });

  it('is idle once the result lands', () => {
    expect(isTurnRunning([created(1), user(2), assistant(3), result(4)])).toBe(false);
  });

  it('is running again on the next turn', () => {
    expect(isTurnRunning([user(1), result(2), user(3)])).toBe(true);
  });

  it('is idle after the session ends mid-turn', () => {
    // A killed session has no turn to interrupt, even though its last user
    // event was never answered.
    expect(isTurnRunning([user(1), ended(2)])).toBe(false);
  });

  it('reads only the latest turn, not the whole history', () => {
    const events = [user(1), result(2), user(3), result(4), user(5), result(6)];
    expect(isTurnRunning(events)).toBe(false);
    expect(isTurnRunning([...events, user(7)])).toBe(true);
  });
});

const delta = (seq: number, opts: { superseded?: true; from?: string } = {}): SessionEvent =>
  ({
    type: 'stream_delta',
    sessionId: 's',
    seq,
    payload: { delta: '.' },
    ...(opts.superseded ? { superseded: true } : {}),
    ...(opts.from ? { parentToolUseId: opts.from } : {}),
  }) as SessionEvent;
const toolResult = (seq: number): SessionEvent =>
  ({ type: 'tool_result', sessionId: 's', seq, payload: {} }) as SessionEvent;

describe('isStreamingText', () => {
  it('says nothing is streaming in a session with no deltas', () => {
    expect(isStreamingText([])).toBe(false);
    expect(isStreamingText([user(1), assistant(2), result(3)])).toBe(false);
  });

  it('is true while deltas are arriving', () => {
    expect(isStreamingText([user(1), delta(2), delta(3)])).toBe(true);
  });

  it('stops once the complete message supersedes them', () => {
    expect(
      isStreamingText([user(1), delta(2, { superseded: true }), assistant(3)]),
    ).toBe(false);
  });

  it('reads the tail, not the whole session', () => {
    // The bug this replaces: any un-superseded delta anywhere kept the pill up
    // forever. A turn interrupted mid-stream leaves exactly that behind.
    const stranded = [user(1), delta(2), result(3)];
    expect(isStreamingText(stranded)).toBe(false);
    expect(isStreamingText([...stranded, user(4), assistant(5), result(6)])).toBe(false);
  });

  it('is false once the stream turns into a tool call', () => {
    expect(isStreamingText([user(1), delta(2, { superseded: true }), toolResult(3)])).toBe(false);
  });

  it('ignores a subagent streaming under a quiet main agent', () => {
    // What the user sees as "Thinking… with nothing running": the main agent
    // finished its turn and a delegated agent is still talking.
    const events = [user(1), assistant(2), delta(3, { from: 'task1' })];
    expect(isStreamingText(events)).toBe(false);
  });

  it('still sees the main agent through interleaved subagent traffic', () => {
    expect(isStreamingText([user(1), delta(2), delta(3, { from: 'task1' })])).toBe(true);
  });

  it('is false after the session ends mid-stream', () => {
    expect(isStreamingText([user(1), delta(2), ended(3)])).toBe(false);
  });
});
