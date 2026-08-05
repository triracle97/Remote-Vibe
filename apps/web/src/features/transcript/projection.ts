import type { SessionEvent } from '../../store/sessions';
import type { TurnUsage } from '../../types/protocol';

/**
 * Fold the raw `ServerStreamMsg` stream into a renderable transcript.
 *
 * Shape follows nimbalyst's `TranscriptViewMessage`
 * (`packages/runtime/src/ai/server/transcript/TranscriptProjector.ts`), but the
 * input is our already-parsed bridge events rather than raw provider JSON —
 * `packages/bridge/src/parser.ts` has done the NDJSON work, so re-parsing
 * provider formats here would duplicate it.
 *
 * Pure and synchronous: given the same events it always produces the same
 * output, which is what makes it testable in isolation.
 */

export type ToolStatus = 'running' | 'ok' | 'error';

export interface FileDiff {
  filePath: string;
  /** Absent for a whole-file create. */
  oldString?: string;
  newString: string;
  /** True when the tool wrote a new file rather than editing one. */
  created: boolean;
}

export interface ToolCallMessage {
  kind: 'tool_call';
  id: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  status: ToolStatus;
  output?: unknown;
  /** Wall-clock between the tool_use and its result, when both are present. */
  durationMs?: number;
  /** Start timestamp, for a live-ticking elapsed timer while `running`. */
  startedAt?: number;
  /** Parsed edits for Edit/Write/MultiEdit, so the UI can render real diffs. */
  fileDiffs?: FileDiff[];
}

export interface TextMessage {
  kind: 'text';
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Images attached to a user turn. */
  imageCount?: number;
}

export interface ThinkingMessage {
  kind: 'thinking';
  id: string;
  text: string;
}

export interface TurnEndMessage {
  kind: 'turn_end';
  id: string;
  cost?: number;
  durationMs?: number;
  usage?: TurnUsage;
  model?: string;
  error?: string;
}

export interface NoticeMessage {
  kind: 'notice';
  id: string;
  text: string;
  tone: 'info' | 'error';
}

export type ViewMessage =
  | TextMessage
  | ThinkingMessage
  | ToolCallMessage
  | TurnEndMessage
  | NoticeMessage;

interface AssistantPayload {
  text?: string;
  thinking?: string;
  toolUse?: { toolUseId: string; toolName: string; input: unknown };
}

interface ToolResultPayload {
  toolUseId: string;
  output: unknown;
  isError?: boolean;
}

/**
 * Project a session's event log into view messages.
 *
 * Consecutive assistant text is merged into one block: the CLI emits a
 * separate `assistant` message per content block, and rendering each as its
 * own bubble fragments a single paragraph across the screen.
 */
export function projectEvents(events: readonly SessionEvent[]): ViewMessage[] {
  const out: ViewMessage[] = [];
  /** toolUseId → index in `out`, so a later result can complete the call. */
  const openTools = new Map<string, number>();

  for (const e of events) {
    if (e.superseded) continue;

    switch (e.type) {
      case 'stream_delta':
        // Live deltas are rendered by the caller as an in-flight tail; the
        // consolidated `assistant` message supersedes them.
        break;

      case 'user': {
        const p = e.payload as { text?: string; imageCount?: number };
        out.push({
          kind: 'text',
          id: idFor(e),
          role: 'user',
          text: p.text ?? '',
          ...(p.imageCount ? { imageCount: p.imageCount } : {}),
        });
        break;
      }

      case 'assistant': {
        const p = e.payload as AssistantPayload;
        if (typeof p.thinking === 'string') {
          out.push({ kind: 'thinking', id: idFor(e), text: p.thinking });
          break;
        }
        if (typeof p.text === 'string' && p.text.length > 0) {
          const prev = out[out.length - 1];
          if (prev?.kind === 'text' && prev.role === 'assistant') {
            prev.text += `\n\n${p.text}`;
          } else {
            out.push({ kind: 'text', id: idFor(e), role: 'assistant', text: p.text });
          }
          break;
        }
        if (p.toolUse) {
          const startedAt = timeOf(e);
          openTools.set(p.toolUse.toolUseId, out.length);
          out.push({
            kind: 'tool_call',
            id: idFor(e),
            toolUseId: p.toolUse.toolUseId,
            toolName: p.toolUse.toolName,
            input: p.toolUse.input,
            status: 'running',
            ...(startedAt !== undefined ? { startedAt } : {}),
            ...(fileDiffsFor(p.toolUse.toolName, p.toolUse.input) ?? {}),
          });
        }
        break;
      }

      case 'tool_result': {
        const p = e.payload as ToolResultPayload;
        const at = openTools.get(p.toolUseId);
        if (at === undefined) {
          // Result with no matching call — a resumed session whose earlier
          // turns were replayed only partially. Surface it rather than drop it.
          out.push({
            kind: 'tool_call',
            id: idFor(e),
            toolUseId: p.toolUseId,
            toolName: '(unknown)',
            input: undefined,
            status: p.isError ? 'error' : 'ok',
            output: p.output,
          });
          break;
        }
        openTools.delete(p.toolUseId);
        const call = out[at] as ToolCallMessage;
        call.status = p.isError ? 'error' : 'ok';
        call.output = p.output;
        const finishedAt = timeOf(e);
        if (call.startedAt !== undefined && finishedAt !== undefined) {
          call.durationMs = Math.max(0, finishedAt - call.startedAt);
        }
        break;
      }

      case 'result': {
        const p = e.payload as {
          cost?: number;
          durationMs?: number;
          usage?: TurnUsage;
          model?: string;
          error?: string;
        };
        // A turn ending abandons any tool still marked running.
        for (const at of openTools.values()) {
          const call = out[at] as ToolCallMessage;
          if (call.status === 'running') call.status = p.error ? 'error' : 'ok';
        }
        openTools.clear();
        out.push({
          kind: 'turn_end',
          id: idFor(e),
          ...(p.cost !== undefined ? { cost: p.cost } : {}),
          ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
          ...(p.usage !== undefined ? { usage: p.usage } : {}),
          ...(p.model !== undefined ? { model: p.model } : {}),
          ...(p.error !== undefined ? { error: p.error } : {}),
        });
        break;
      }

      case 'system': {
        if (e.event === 'session_created') {
          out.push({ kind: 'notice', id: idFor(e), text: 'session started', tone: 'info' });
        } else if (e.event === 'session_ended') {
          const reason = e.reason ? `, ${e.reason}` : '';
          out.push({
            kind: 'notice',
            id: idFor(e),
            text: `session ended (exit ${e.exitCode ?? '?'}${reason})`,
            tone: e.exitCode === 0 ? 'info' : 'error',
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return out;
}

/** `seq` is unique and monotonic per session, so it makes a stable React key. */
function idFor(e: SessionEvent): string {
  return `${e.type}-${e.seq}`;
}

/**
 * Events carry no timestamp on the wire, so durations are only available for
 * calls observed live. Replayed history shows no timer rather than a wrong one.
 */
function timeOf(e: SessionEvent): number | undefined {
  const t = (e as { receivedAt?: number }).receivedAt;
  return typeof t === 'number' ? t : undefined;
}

interface EditInput {
  file_path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
  content?: unknown;
  edits?: Array<{ old_string?: unknown; new_string?: unknown }>;
}

/**
 * Extract renderable diffs from a file-mutating tool's arguments.
 *
 * Reads the *request*, not the result: the tool result is a confirmation
 * string, while the arguments carry the actual before/after text.
 */
function fileDiffsFor(
  toolName: string,
  input: unknown,
): { fileDiffs: FileDiff[] } | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const i = input as EditInput;
  const filePath = typeof i.file_path === 'string' ? i.file_path : null;
  if (filePath === null) return undefined;

  switch (toolName) {
    case 'Write': {
      if (typeof i.content !== 'string') return undefined;
      return { fileDiffs: [{ filePath, newString: i.content, created: true }] };
    }
    case 'Edit': {
      if (typeof i.old_string !== 'string' || typeof i.new_string !== 'string') return undefined;
      return {
        fileDiffs: [
          { filePath, oldString: i.old_string, newString: i.new_string, created: false },
        ],
      };
    }
    case 'MultiEdit': {
      if (!Array.isArray(i.edits)) return undefined;
      const diffs: FileDiff[] = [];
      for (const ed of i.edits) {
        if (typeof ed?.old_string !== 'string' || typeof ed.new_string !== 'string') continue;
        diffs.push({
          filePath,
          oldString: ed.old_string,
          newString: ed.new_string,
          created: false,
        });
      }
      return diffs.length > 0 ? { fileDiffs: diffs } : undefined;
    }
    default:
      return undefined;
  }
}
