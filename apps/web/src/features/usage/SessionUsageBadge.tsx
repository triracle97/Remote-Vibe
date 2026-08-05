import { useState, type JSX } from 'react';
import { contextTokens, totalTokens, useUsageStore } from '../../store/usage';
import { formatCount } from '../transcript/utils';
import { EMPTY_SESSION_USAGE } from '../../types/protocol';

/**
 * Token spend for one chat, shown in the session header.
 *
 * Collapsed it leads with the *context* level, not lifetime spend: mid-session
 * the question is "how much room is left before this compacts", and lifetime
 * totals cannot answer that — they only ever grow. Cumulative spend and the
 * cache split live in the breakdown, where the question is "what did this
 * cost".
 */
export function SessionUsageBadge({ sessionId }: { sessionId: string }): JSX.Element | null {
  const usage = useUsageStore((s) => s.bySession[sessionId]) ?? EMPTY_SESSION_USAGE;
  const [open, setOpen] = useState(false);

  // Nothing has completed yet; a row of zeroes is noise.
  if (usage.turns === 0) return null;

  const total = totalTokens(usage);
  const context = contextTokens(usage);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Session token usage"
        data-testid="session-usage-badge"
        title="Context in use, and lifetime cost, for this session"
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-[var(--color-border)] text-[11px] tabular-nums text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
      >
        <span>{formatCount(context)} ctx</span>
        <span className="text-[var(--color-border)]">·</span>
        <span>${usage.costUsd.toFixed(2)}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Token breakdown"
          data-testid="session-usage-breakdown"
          className="absolute z-50 right-0 top-full mt-1 w-56 p-3 rounded-xl shadow-2xl bg-[var(--color-surface)] border border-[var(--color-border)]"
        >
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] tabular-nums">
            <Row label="Context now" value={formatCount(context)} strong />
            <Row label="Turns" value={String(usage.turns)} />
            <Row label="Input" value={formatCount(usage.inputTokens)} />
            <Row label="Output" value={formatCount(usage.outputTokens)} />
            <Row label="Cache read" value={formatCount(usage.cacheReadTokens)} />
            <Row label="Cache write" value={formatCount(usage.cacheCreationTokens)} />
            <Row label="Total used" value={formatCount(total)} strong />
            <Row label="Cost" value={`$${usage.costUsd.toFixed(4)}`} strong />
          </dl>
          <p className="mt-2 text-[10px] text-[var(--color-text-dim)] leading-snug">
            <strong className="text-[var(--color-text-mute)]">Context now</strong> is
            what the last turn had to read — it falls when the CLI compacts.
            <strong className="text-[var(--color-text-mute)]"> Total used</strong> is
            lifetime spend and only grows. Cache reads bill at a fraction of fresh
            input, so a high cache share means cheap turns.
          </p>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}): JSX.Element {
  return (
    <>
      <dt className="text-[var(--color-text-dim)]">{label}</dt>
      <dd
        className={`text-right ${strong ? 'text-[var(--color-text)] font-semibold' : 'text-[var(--color-text-mute)]'}`}
      >
        {value}
      </dd>
    </>
  );
}
