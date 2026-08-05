import { useEffect, useRef, useState, type JSX } from 'react';
import {
  formatLimitType,
  formatResetsIn,
  useUsageStore,
  utilizationTone,
  worstWindow,
} from '../../store/usage';
import type { RateLimitWindow } from '../../types/protocol';

/**
 * Circular quota ring, modelled on nimbalyst's `ClaudeUsageIndicator`.
 *
 * The data source differs: nimbalyst polls `api.anthropic.com/api/oauth/usage`
 * with a Keychain-read OAuth token, whereas the CLI already volunteers the
 * same numbers as `rate_limit_event` mid-stream — so this needs no credential
 * and no extra request. The trade-off is that it only knows what it has seen:
 * before the first turn of a run there is nothing to show, and the ring hides.
 */

const RADIUS = 11;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const TONE_VAR: Record<'ok' | 'warn' | 'danger', string> = {
  ok: '--color-success',
  warn: '--color-warn',
  danger: '--color-danger',
};

export function UsageIndicator(): JSX.Element | null {
  const windows = useUsageStore((s) => s.windows);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click / Escape, the way a popover should behave.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const worst = worstWindow(windows);
  // Nothing observed yet — better to show nothing than a confident zero.
  if (worst === null) return null;

  const tone = utilizationTone(worst.utilization);
  const pct = Math.round(worst.utilization * 100);
  const offset = CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, worst.utilization)));

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Plan usage ${pct}%`}
        aria-expanded={open}
        title={`${formatLimitType(worst.limitType)}: ${pct}% — ${formatResetsIn(worst.resetsAt)}`}
        data-testid="usage-indicator"
        className="relative w-9 h-9 flex items-center justify-center rounded-md hover:bg-[var(--color-surface-2)] transition-colors"
      >
        <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
          <circle
            cx="14"
            cy="14"
            r={RADIUS}
            fill="none"
            strokeWidth="3"
            className="stroke-[var(--color-border)]"
          />
          <circle
            cx="14"
            cy="14"
            r={RADIUS}
            fill="none"
            strokeWidth="3"
            strokeLinecap="round"
            stroke={`var(${TONE_VAR[tone]})`}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            // Start the arc at 12 o'clock rather than 3.
            transform="rotate(-90 14 14)"
            style={{ transition: 'stroke-dashoffset 0.3s ease' }}
          />
        </svg>
        <span className="absolute text-[9px] font-semibold tabular-nums text-[var(--color-text-mute)]">
          {pct}
        </span>
      </button>

      {open && <UsagePopover windows={windows} onClose={() => setOpen(false)} />}
    </div>
  );
}

function UsagePopover({
  windows,
  onClose,
}: {
  windows: Record<string, RateLimitWindow>;
  onClose: () => void;
}): JSX.Element {
  const list = Object.values(windows).sort((a, b) => b.utilization - a.utilization);
  return (
    <div
      role="dialog"
      aria-label="Plan usage"
      data-testid="usage-popover"
      className={[
        'absolute z-50 w-64 p-3 rounded-xl shadow-2xl',
        'bg-[var(--color-surface)] border border-[var(--color-border)]',
        // Sits above the bar on mobile, beside the rail on desktop.
        'bottom-full mb-2 right-0 md:bottom-auto md:top-0 md:left-full md:ml-2 md:mb-0',
      ].join(' ')}
    >
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-mute)]">
          Plan usage
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto text-[var(--color-text-dim)] hover:text-[var(--color-text)] leading-none"
        >
          ×
        </button>
      </div>

      <ul className="flex flex-col gap-2.5">
        {list.map((w) => {
          const tone = utilizationTone(w.utilization);
          const pct = Math.round(w.utilization * 100);
          return (
            <li key={w.limitType}>
              <div className="flex items-baseline gap-2 text-xs">
                <span className="text-[var(--color-text)]">{formatLimitType(w.limitType)}</span>
                <span
                  className="ml-auto font-semibold tabular-nums"
                  style={{ color: `var(${TONE_VAR[tone]})` }}
                >
                  {pct}%
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, pct)}%`,
                    background: `var(${TONE_VAR[tone]})`,
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
              <div className="mt-0.5 flex gap-2 text-[10px] text-[var(--color-text-dim)]">
                <span>{formatResetsIn(w.resetsAt)}</span>
                {w.isUsingOverage && (
                  <span style={{ color: 'var(--color-warn)' }}>using overage</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-2.5 text-[10px] text-[var(--color-text-dim)] leading-snug">
        Reported by the agent CLI during a turn. Updates as you work.
      </p>
    </div>
  );
}
