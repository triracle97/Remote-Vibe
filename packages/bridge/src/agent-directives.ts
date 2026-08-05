import { isSessionPhase, type SessionPhase } from './types.js';

/**
 * Directives the agent can emit to drive its own board card.
 *
 * The agent writes an HTML comment into its reply and the bridge acts on it,
 * then strips it before the text reaches any client:
 *
 *   <!--mrt:phase=verifying-->
 *   <!--mrt:tags=api,bug-->
 *
 * An HTML comment was chosen over a network call or a control file because it
 * needs no credentials in the agent's environment, no new listening surface,
 * and no per-agent plumbing — Codex gets the same behaviour as Claude for
 * free. The cost is that the marker rides in the text, which is why stripping
 * happens before the broadcast rather than in the renderer: a client that
 * never learned about markers still shows clean prose.
 */

const DIRECTIVE_RE = /<!--\s*mrt:(phase|tags)\s*=\s*([^>]*?)\s*-->/gi;

export interface AgentDirectives {
  /** Text with every directive removed. */
  text: string;
  phase: SessionPhase | null;
  /** Replacement tag list, or null when the agent said nothing about tags. */
  tags: string[] | null;
}

const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;

function parseTags(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(',')) {
    const tag = piece.trim().replace(/\s+/g, '-');
    if (tag.length === 0 || tag.length > MAX_TAG_LEN) continue;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(tag)) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * Pull directives out of one assistant text block.
 *
 * Last writer wins if the agent emits the same directive twice in a block.
 * Unknown phases are ignored rather than rejected — a typo should not lose
 * the surrounding prose.
 */
export function extractDirectives(text: string): AgentDirectives {
  DIRECTIVE_RE.lastIndex = 0;
  if (!DIRECTIVE_RE.test(text)) {
    return { text, phase: null, tags: null };
  }

  let phase: SessionPhase | null = null;
  let tags: string[] | null = null;

  DIRECTIVE_RE.lastIndex = 0;
  const stripped = text.replace(DIRECTIVE_RE, (_match, kind: string, value: string) => {
    if (kind.toLowerCase() === 'phase') {
      const v = value.trim().toLowerCase();
      if (isSessionPhase(v)) phase = v;
    } else {
      tags = parseTags(value);
    }
    return '';
  });

  // Removing a marker that sat on its own line leaves a blank line behind.
  const text2 = stripped.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

  return { text: text2, phase, tags };
}

/**
 * Instruction appended to the agent's system prompt so it knows the channel
 * exists. Deliberately short and non-insistent: current models follow the
 * system prompt closely, and a `CRITICAL: you MUST` framing here would make
 * the agent narrate phase changes constantly instead of working.
 */
export const AGENT_DIRECTIVE_PROMPT = [
  'This session appears as a card on a Kanban board in the app driving you.',
  'You can move your own card by emitting an HTML comment anywhere in a reply:',
  '<!--mrt:phase=investigating|planning|implementing|verifying|done--> sets the',
  'column, and <!--mrt:tags=api,bug--> replaces the card tags (comma-separated).',
  'The comment is stripped before the user sees it.',
  'Update the phase when it genuinely changes — you are reading code to answer a',
  'question rather than building (investigating), you finish planning and start',
  'editing, you start running tests, or the work is complete. Do not announce',
  'or explain the change, and do not repeat it every message.',
].join(' ');
