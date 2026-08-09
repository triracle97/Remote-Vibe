import { useEffect, useRef, useState, type JSX } from 'react';
import {
  formatLimitType,
  formatResetsIn,
  groupByAccount,
  useUsageStore,
  utilizationTone,
  worstWindow,
  type AccountWindows,
} from '../../store/usage';

/**
 * Circular quota ring, modelled on nimbalyst's `ClaudeUsageIndicator`.
 *
 * The data source differs: nimbalyst polls `api.anthropic.com/api/oauth/usage`
 * with a Keychain-read OAuth token, whereas the CLI already volunteers the
 * same numbers as `rate_limit_event` mid-stream — so this needs no credential
 * and no extra request. The trade-off is that it only knows what it has seen:
 * before the first turn of a run there is nothing to show, and the ring hides.
 *
 * A window can also arrive *without* a percentage: the CLI withholds
 * `utilization` until the window passes its own warning threshold, so a healthy
 * account reports which window is live and when it resets and nothing more.
 * That still beats an empty toolbar, so it renders as a full ring reading OK —
 * never as a 0%, which would claim a number nobody gave us.
 *
 * Windows belong to an *account*, not to the bridge. Running one session on
 * `~/.claude` and another on `~/.claude1` means two plans with two separate
 * 5-hour windows; the ring shows whichever is closest to stopping you and says
 * whose it is, and the popover lists each plan under its own heading.
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

  const groups = groupByAccount(windows);
  const worst = worstWindow(windows);
  // Nothing observed yet — better to show nothing than a confident zero.
  if (worst === null) return null;

  const tone = utilizationTone(worst.utilization);
  const util = worst.utilization;
  const pct = util === null ? null : Math.round(util * 100);
  // No figure means "below the warning threshold", so the ring completes rather
  // than sitting empty — an empty ring is how 0% looks.
  const offset = util === null ? 0 : CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, util)));
  const level = pct === null ? 'below warning threshold' : `${pct}%`;
  // One account needs no caption — every number on screen is already its own.
  // Two do: without it the ring is a figure with no owner.
  const label = worst.account.label;
  const showAccount = groups.length > 1;

  return (
    <div ref={rootRef} className="relative flex flex-col items-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Plan usage ${level} on ${label}`}
        aria-expanded={open}
        title={`${label}: ${formatLimitType(worst.limitType)} ${level} — ${formatResetsIn(worst.resetsAt)}`}
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
            style={{
              transition: 'stroke-dashoffset 0.3s ease',
              // Dimmed when it is a "nothing to report" ring, not a measurement.
              ...(util === null ? { opacity: 0.4 } : {}),
            }}
          />
        </svg>
        <span className="absolute text-[9px] font-semibold tabular-nums text-[var(--color-text-mute)]">
          {pct ?? 'OK'}
        </span>
      </button>
      {showAccount && (
        <span
          data-testid="usage-account"
          className="max-w-[2.6rem] truncate text-[8px] leading-none text-[var(--color-text-dim)]"
        >
          {label}
        </span>
      )}

      {open && <UsagePopover groups={groups} onClose={() => setOpen(false)} />}
    </div>
  );
}

function UsagePopover({
  groups,
  onClose,
}: {
  groups: AccountWindows[];
  onClose: () => void;
}): JSX.Element {
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

      {groups.map((g) => (
        <section key={g.account.key} className="mb-2.5 last:mb-0">
          {/* The heading is what makes two accounts readable as two plans
              rather than one contradictory set of numbers. */}
          <div
            className="mb-1.5 flex items-baseline gap-1.5"
            title={g.account.configDir ?? undefined}
          >
            <span className="text-[11px] font-semibold text-[var(--color-text)]">
              {g.account.label}
            </span>
            <span className="text-[10px] text-[var(--color-text-dim)] truncate">
              {g.account.agent}
            </span>
          </div>
          <ul className="flex flex-col gap-2.5">
            {g.windows.map((w) => {
              const tone = utilizationTone(w.utilization);
              const pct = w.utilization === null ? null : Math.round(w.utilization * 100);
              return (
                <li key={w.limitType}>
                  <div className="flex items-baseline gap-2 text-xs">
                    <span className="text-[var(--color-text)]">{formatLimitType(w.limitType)}</span>
                    <span
                      className="ml-auto font-semibold tabular-nums"
                      style={{ color: `var(${TONE_VAR[tone]})` }}
                    >
                      {pct === null ? 'OK' : `${pct}%`}
                    </span>
                  </div>
                  {/* No bar without a number — a zero-width one would read as 0%. */}
                  {pct !== null && (
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
                  )}
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
        </section>
      ))}

      <p className="mt-2.5 text-[10px] text-[var(--color-text-dim)] leading-snug">
        Reported by the agent CLI during a turn, per account. Updates as you work.{' '}
        <strong className="text-[var(--color-text-mute)]">OK</strong> means the CLI gave no
        percentage — it only names one once a window nears its limit.
      </p>
    </div>
  );
}
