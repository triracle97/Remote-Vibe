import { Clock } from 'lucide-react';
import { useEffect, useRef, useState, type JSX } from 'react';
import {
  describeReset,
  formatLimitType,
  formatResetsAt,
  shortLimitType,
  useUsageStore,
  utilizationTone,
  windowsForAccount,
} from '../../store/usage';
import { useNow } from './useNow';

/**
 * Plan quota for the account *this* session runs as, in the session header.
 *
 * The nav rail's ring answers "which of my plans is closest to stopping me",
 * which is the right question with three sessions open on two profiles. Inside
 * a session it is the wrong one: a chat running as `claude1` was showing the
 * default profile's 78% because that was the worse number, and nothing on
 * screen said the figure belonged to somebody else.
 *
 * So this shows one account — the session's — and both of its windows, since
 * "fine for the next five hours, nearly out for the week" is a normal and
 * unreadable state from a single figure.
 *
 * Rows come from whatever the account actually reports. A Codex plan reports a
 * weekly window and no 5-hour one, so a Codex session shows a single row
 * rather than an empty 5-hour slot pretending the limit exists.
 *
 * The 5-hour window's reset time rides in the chip itself. It is the one
 * figure that changes what you do next — "wait twenty minutes" and "wait
 * until three" are different decisions — and a click to find it is one too
 * many when the number is right there. The week's reset stays in the popover.
 */

const TONE_VAR: Record<'ok' | 'warn' | 'danger', string> = {
  ok: '--color-success',
  warn: '--color-warn',
  danger: '--color-danger',
};

function pctLabel(utilization: number | null): string {
  return utilization === null ? 'OK' : `${Math.round(utilization * 100)}%`;
}

export function SessionQuotaBadge({
  accountKey,
}: {
  accountKey: string | null | undefined;
}): JSX.Element | null {
  const windows = useUsageStore((s) => s.windows);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const now = useNow();
  const mine = windowsForAccount(windows, accountKey);
  // Nothing observed for this account yet. Better an absent chip than one
  // reading 0%, which is a claim nobody made.
  if (mine.length === 0) return null;

  const label = mine[0]!.account.label;
  const summary = mine.map((w) => {
    const reset = w.resetsAt === null ? '' : ` (${describeReset(w.resetsAt, now)})`;
    return `${shortLimitType(w.limitType)} ${pctLabel(w.utilization)}${reset}`;
  });

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Plan usage on ${label}: ${summary.join(', ')}`}
        data-testid="session-quota-badge"
        title={`Plan usage for ${label}: ${summary.join(' · ')}`}
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-[var(--color-border)] text-[11px] tabular-nums text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
      >
        {mine.map((w, i) => (
          <span key={w.limitType} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-[var(--color-border)]">·</span>}
            <span>
              {shortLimitType(w.limitType)}{' '}
              <span
                className="font-semibold"
                style={{ color: `var(${TONE_VAR[utilizationTone(w.utilization)]})` }}
              >
                {pctLabel(w.utilization)}
              </span>
              {w.limitType === 'five_hour' && w.resetsAt !== null && (
                <span
                  data-testid="session-quota-reset"
                  className="ml-1 inline-flex items-center gap-0.5 text-[var(--color-text-dim)]"
                >
                  <Clock size={10} aria-hidden />
                  {formatResetsAt(w.resetsAt, now)}
                </span>
              )}
            </span>
          </span>
        ))}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Plan usage"
          data-testid="session-quota-popover"
          className="absolute z-50 right-0 top-full mt-1 w-56 p-3 rounded-xl shadow-2xl bg-[var(--color-surface)] border border-[var(--color-border)]"
        >
          <div className="mb-2 flex items-baseline gap-1.5">
            <span className="text-[11px] font-semibold text-[var(--color-text)]">{label}</span>
            <span className="text-[10px] text-[var(--color-text-dim)]">
              {mine[0]!.account.agent}
            </span>
          </div>
          <ul className="flex flex-col gap-2.5">
            {mine.map((w) => {
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
                  {/* No bar without a number — a zero-width one reads as 0%. */}
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
                    <span data-testid="session-quota-popover-reset">
                      {describeReset(w.resetsAt, now)}
                    </span>
                    {w.isUsingOverage && (
                      <span style={{ color: 'var(--color-warn)' }}>using overage</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-2.5 text-[10px] text-[var(--color-text-dim)] leading-snug">
            This session's own plan. Other accounts are in the usage ring.
          </p>
        </div>
      )}
    </div>
  );
}
