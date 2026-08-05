/**
 * Escape `$` that means money, not math.
 *
 * We ship `remark-math`, which treats `$…$` as inline math. Agent prose is full
 * of prices and shell variables, so `it costs $5 or $10` parses as a math span
 * containing `5 or `, and renders as garbage. Ported from nimbalyst's
 * `packages/runtime/src/ui/AgentTranscript/utils/escapeCurrencyDollars.ts`.
 *
 * The rule: a `$` immediately followed by a digit is currency. Real inline math
 * (`$x^2$`, `$\alpha$`) does not start with a digit, and display math (`$$…$$`)
 * is left alone entirely.
 *
 * Fenced and inline code are skipped — `$5` inside a code span is literal text
 * already, and escaping it there would show the backslash.
 */
export function escapeCurrencyDollars(source: string): string {
  let out = '';
  let i = 0;

  while (i < source.length) {
    // Fenced code block: copy verbatim through the closing fence.
    const fence = /^(```+|~~~+)/.exec(source.slice(i));
    if (fence && atLineStart(source, i)) {
      const marker = fence[1]!;
      const end = source.indexOf(`\n${marker}`, i + marker.length);
      const stop = end === -1 ? source.length : end + marker.length + 1;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }

    const ch = source[i]!;

    // Inline code span: copy verbatim through the closing backtick run.
    if (ch === '`') {
      const run = /^`+/.exec(source.slice(i))![0];
      const end = source.indexOf(run, i + run.length);
      const stop = end === -1 ? source.length : end + run.length;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }

    // Display math — leave both delimiters and the body alone.
    if (ch === '$' && source[i + 1] === '$') {
      const end = source.indexOf('$$', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === '$' && source[i - 1] !== '\\' && /[0-9]/.test(source[i + 1] ?? '')) {
      out += '\\$';
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function atLineStart(source: string, i: number): boolean {
  return i === 0 || source[i - 1] === '\n';
}

/**
 * Block anything that isn't a safe, inert link target.
 *
 * Agent output is untrusted markdown: a `javascript:` or `data:` href in a
 * rendered transcript is a script-execution vector.
 */
export function safeUrlTransform(url: string): string {
  const trimmed = url.trim();
  if (/^(https?:|mailto:|#|\/|\.{1,2}\/)/i.test(trimmed)) return trimmed;
  // Bare relative paths (`src/a.ts`) are fine; schemes we don't know are not.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return '';
  return trimmed;
}
