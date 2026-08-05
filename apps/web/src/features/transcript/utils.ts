/**
 * Small display helpers for the transcript.
 *
 * Ported from nimbalyst's `packages/runtime/src/ui/AgentTranscript/utils/`
 * (`unwrapShellCommand.ts`, `toolNameFormatter.ts`, `pathResolver.ts`),
 * trimmed to what this app actually renders.
 */

/** Shell wrapper: `/bin/zsh -lc 'cmd'`, or a bare `bash -lc 'cmd'`. */
const SHELL_WRAPPER_RE = /^(?:\/(?:bin|usr\/bin)\/)?(?:bash|zsh|sh)\s+-l?c\s+([\s\S]+)$/;
/** Windows: `cmd.exe /c "actual command"`. */
const CMD_EXE_RE = /^"?(?:[A-Za-z]:\\[^"]*\\)?cmd(?:\.exe)?"?\s+\/[cC]\s+([\s\S]+)$/;
/** Windows: `"...\powershell.exe" -Command 'actual command'`. */
const POWERSHELL_RE =
  /^"?[A-Za-z]:\\[^"]*\\(?:powershell|pwsh)(?:\.exe)?"?\s+-Command\s+([\s\S]+)$/i;

function stripOuterQuotes(s: string): string {
  return s.replace(/^(['"])([\s\S]*)\1$/, '$2');
}

/**
 * Strip the shell wrapper off a command, for display only.
 *
 * `/bin/zsh -lc "sed -n '1,20p' a.ts"` reads as `sed -n '1,20p' a.ts`. The
 * wrapper is noise in a transcript — it is the same on every single call.
 * Recurses, because a PowerShell wrapper can contain a Unix one.
 */
export function unwrapShellCommand(command: unknown): string {
  let cmd = command;
  if (Array.isArray(cmd)) cmd = cmd.map((p) => String(p ?? '')).join(' ');
  if (typeof cmd !== 'string') return String(cmd ?? '');

  for (const re of [CMD_EXE_RE, POWERSHELL_RE]) {
    const m = cmd.match(re);
    if (m?.[1]) return unwrapShellCommand(stripOuterQuotes(m[1]));
  }
  const unix = cmd.match(SHELL_WRAPPER_RE);
  if (unix?.[1]) return stripOuterQuotes(unix[1]);
  return cmd;
}

/** `mcp__github__create_issue` → `create issue`. */
export function formatToolName(name: string): string {
  const stripped = name.replace(/^mcp__[^_]+__/, '');
  return stripped.replace(/_/g, ' ');
}

/**
 * Shorten a path for a one-line header: keep the last `keep` segments and
 * elide the rest. The tail is what identifies a file; the root rarely is.
 */
export function shortenPath(path: string, keep = 3): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= keep) return path;
  return `…/${parts.slice(-keep).join('/')}`;
}

/** `/a/b/c.ts` relative to `/a` → `b/c.ts`. Leaves unrelated paths alone. */
export function toProjectRelative(path: string, projectPath: string): string {
  if (projectPath.length > 0 && path.startsWith(projectPath)) {
    const rest = path.slice(projectPath.length);
    return rest.startsWith('/') ? rest.slice(1) : rest;
  }
  return path;
}

/** `5s` / `2m 15s` / `1h 5m` — compact enough to sit inline in a header. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** `1234` → `1.2k`. Token counts are scanned, not read precisely. */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Coerce arbitrary tool output into something renderable in a <pre>. */
export function outputToText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === null || output === undefined) return '';
  // Claude sends tool_result content as a block array for richer results.
  if (Array.isArray(output)) {
    const texts = output
      .map((b) => (typeof b === 'object' && b !== null && 'text' in b ? String((b as { text: unknown }).text) : null))
      .filter((t): t is string => t !== null);
    if (texts.length > 0) return texts.join('\n');
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

/**
 * One-line summary of a tool call for its collapsed header.
 *
 * Each tool has a different "what is this actually doing" field; showing the
 * raw JSON there would make every card look the same.
 */
export function summarizeToolInput(toolName: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const i = input as Record<string, unknown>;
  const str = (k: string): string | null => (typeof i[k] === 'string' ? (i[k] as string) : null);

  switch (toolName) {
    case 'Bash':
      return unwrapShellCommand(i.command);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return str('file_path') ?? '';
    case 'Grep': {
      const p = str('pattern') ?? '';
      const path = str('path');
      return path ? `${p} in ${path}` : p;
    }
    case 'Glob':
      return str('pattern') ?? '';
    case 'WebFetch':
      return str('url') ?? '';
    case 'WebSearch':
      return str('query') ?? '';
    case 'Task':
    case 'Agent':
      return str('description') ?? '';
    case 'TodoWrite': {
      const todos = i.todos;
      if (!Array.isArray(todos)) return '';
      const done = todos.filter(
        (t) => typeof t === 'object' && t !== null && (t as { status?: unknown }).status === 'completed',
      ).length;
      return `${done}/${todos.length} done`;
    }
    default: {
      // Fall back to the first short string field — usually the salient one.
      for (const v of Object.values(i)) {
        if (typeof v === 'string' && v.length > 0 && v.length < 200) return v;
      }
      return '';
    }
  }
}
