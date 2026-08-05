import { useCallback, useRef } from 'react';
import { formatElapsed } from './utils';

/**
 * Ref callback that keeps an element's text showing live elapsed time.
 *
 * Ported from nimbalyst's
 * `packages/runtime/src/ui/AgentTranscript/components/CustomToolWidgets/useElapsedTime.ts`.
 *
 * Writes `textContent` from a requestAnimationFrame loop instead of holding
 * the value in state. The point is that it triggers **zero React re-renders**:
 * a setState-based interval re-renders the widget every second with stale
 * props, which is how timers end up still ticking after the tool has finished.
 *
 * React owns the lifecycle. Attach the ref inside an `{isRunning && …}` block;
 * when `isRunning` flips, React unmounts the node, the ref fires with null,
 * and the loop stops.
 */
export function useElapsedTimeRef(
  startTimestamp: number | undefined,
): (node: HTMLElement | null) => void {
  const rafRef = useRef<number | null>(null);
  const lastTextRef = useRef('');

  return useCallback(
    (node: HTMLElement | null) => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (!node || startTimestamp === undefined) return;

      const paint = (): void => {
        const ms = Date.now() - startTimestamp;
        if (ms < 0) return;
        const text = formatElapsed(ms);
        if (text !== lastTextRef.current) {
          lastTextRef.current = text;
          node.textContent = text;
        }
      };

      let lastSecond = -1;
      const tick = (): void => {
        const sec = Math.floor((Date.now() - startTimestamp) / 1000);
        // Only touch the DOM when the displayed second actually changes.
        if (sec !== lastSecond) {
          lastSecond = sec;
          paint();
        }
        rafRef.current = requestAnimationFrame(tick);
      };

      paint();
      rafRef.current = requestAnimationFrame(tick);
    },
    [startTimestamp],
  );
}
