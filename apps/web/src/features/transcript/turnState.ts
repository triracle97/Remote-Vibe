import type { SessionEvent } from '../../store/sessions';

/**
 * Whether the agent is mid-turn — i.e. whether there is anything to interrupt.
 *
 * Derived from the raw event stream rather than the projection: the question is
 * "has a `user` turn been opened and not yet closed by a `result`", and the raw
 * events answer it directly. The projection collapses and reorders content for
 * display, which is the wrong shape for a strict open/close pairing.
 *
 * A session with no events at all is idle, not running — that matters on first
 * load, where showing a stop button for a session that has never run reads as a
 * bug.
 */
export function isTurnRunning(events: readonly SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    // The turn's terminator. Anything before this belongs to a finished turn.
    if (e.type === 'result') return false;
    // A session that ended is not running, whatever came before.
    if (e.type === 'system' && e.event === 'session_ended') return false;
    // An unanswered user turn is an open one.
    if (e.type === 'user') return true;
  }
  return false;
}
