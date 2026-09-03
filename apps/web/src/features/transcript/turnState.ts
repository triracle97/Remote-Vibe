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
/**
 * Whether the main agent has prose arriving right now that has not yet been
 * finalised — i.e. whether to show "Thinking…".
 *
 * Only the tail matters. The old test was "does the session contain any
 * un-superseded delta anywhere", which is true forever after a single turn
 * that ended without a matching complete message — an interrupt, a crash, a
 * history replay that stops mid-stream — so the pill stayed up under a session
 * that had been idle for hours.
 *
 * Subagent traffic is skipped rather than counted. A subagent streaming says
 * nothing about the main agent, and this pill sits at the bottom of the main
 * transcript; what the subagents are doing is what the header badge counts.
 */
export function isStreamingText(events: readonly SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    // Lifecycle events carry no origin at all, which makes them the main
    // agent's by definition — and a turn boundary either way.
    if ((e as { parentToolUseId?: string }).parentToolUseId !== undefined) continue;
    // Any other event from the main agent means the stream resolved — into a
    // finished message, a tool call, or the end of the turn.
    if (e.type !== 'stream_delta') return false;
    return e.superseded !== true;
  }
  return false;
}

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
