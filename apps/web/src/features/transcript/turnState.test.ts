import { describe, it, expect } from 'vitest';
import { isTurnRunning } from './turnState';
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
