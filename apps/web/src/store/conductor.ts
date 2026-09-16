import { create } from 'zustand';
import type {
  ClientMsg,
  PipelineSummary,
  SliceSummary,
  ServerFileResultMsg,
  ServerPipelineListMsg,
} from '../types/protocol';

/**
 * Conductor pipelines visible from the current session.
 *
 * A session is "tied" to a pipeline with no user action: the bridge scans the
 * session's working dirs when the session opens, and if it finds exactly one
 * pipeline that is the one. Several is the interesting case — a repo with a
 * long history of conductor runs has several `.pipeline/` dirs, and the newest
 * is a guess, not a fact. So the guess is overridable and the pin is sticky,
 * the same shape the board already uses for session phase: infer, let the
 * agent correct, let the human override.
 */

/** Slug the agent named for itself, per session. See `agentTie`. */
type AgentTie = Record<string, string>;

/** A pipeline document being read in the panel. */
export type OpenDoc =
  | { state: 'loading'; path: string; name: string }
  | { state: 'text'; path: string; name: string; content: string }
  | { state: 'error'; path: string; name: string; message: string };

export interface DocSection {
  /** Heading text, or `(top)` for anything before the first heading. */
  heading: string;
  /** `##` → 2. Zero for the preamble. */
  level: number;
  body: string;
}

/**
 * Split a markdown document into sections at headings `#` to `###`.
 *
 * Conductor's artefacts are routinely enormous — the run that motivated this
 * had a 300K `PATHS.md` and a 184K `SPEC.md`, sizes its own controller could
 * not read in one pass. The reader renders sections progressively and builds
 * its outline from them, so this split decides both how well it scrolls and
 * how well it navigates.
 *
 * Level 3 is included for a specific reason: `PATHS.md` is a single `## Paths`
 * heading above 340 `### P-xx` entries. Splitting at `##` alone would leave one
 * 250K chunk — progressive rendering could not help, and the outline would
 * have two entries and be useless. At level 3 every path is its own chunk and
 * its own outline row. Level 4+ stays inline; below a path entry the headings
 * are prose structure, not navigation.
 *
 * Split client-side deliberately: the file is fetched once over a local
 * network, so doing it here costs nothing in the protocol.
 */
export function docSections(text: string): DocSection[] {
  const lines = text.split('\n');
  const out: DocSection[] = [];
  let heading = '(top)';
  let level = 0;
  let buf: string[] = [];
  const flush = (): void => {
    const body = buf.join('\n').trim();
    // Drop an empty preamble, but keep an empty section that has a heading —
    // "this section exists and is empty" is real information in a spec.
    if (out.length === 0 && heading === '(top)' && body.length === 0) return;
    out.push({ heading, level, body });
  };
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      buf = [];
      level = m[1]!.length;
      heading = m[2]!.trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

interface ConductorStore {
  pipelines: PipelineSummary[];
  /** Directories the bridge could not scan, and why. Surfaced, never hidden. */
  warnings: string[];
  loading: boolean;
  /** True once a scan has come back, so "none" can be told from "not yet". */
  loaded: boolean;
  /**
   * The session the held scan is about, or null for an every-directory scan.
   *
   * One store serves every session, and a scan takes as long as walking a
   * repo's worktrees takes — long enough to open another session first. Without
   * this, the second session shows the first one's pipelines until its own
   * answer arrives, which is a lie with a plausible shape.
   */
  sessionId: string | null;
  /** Explicit user choice of pipeline, per session. Beats agent and guess. */
  pinnedBySession: Record<string, string>;
  /**
   * Per-session slug claimed by the agent via `<!--mrt:pipeline=…-->`.
   *
   * Keyed by session because one bridge drives many, and the directive is a
   * statement about the session that emitted it.
   */
  agentTie: AgentTie;
  /** Document open in the panel, or null. */
  doc: OpenDoc | null;
  /** Correlation id of the in-flight `read_file`, if any. */
  pendingDocId: string | null;

  requestPipelines(client: { send(m: ClientMsg): void }, sessionId?: string): void;
  applyPipelineList(m: ServerPipelineListMsg): void;
  setAgentTie(sessionId: string, slug: string): void;
  pin(sessionId: string, slug: string | null): void;
  pinnedFor(sessionId: string | undefined): string | null;
  openDoc(client: { send(m: ClientMsg): void }, path: string, name: string): void;
  /**
   * Claim a `file_result` that belongs to our own in-flight read.
   *
   * Returns true when it did. Every `file_result` on the socket is otherwise
   * routed to the file-explorer store, so without this claim opening a spec
   * here would also swap whatever the Monaco drawer was showing.
   */
  applyFileResult(m: ServerFileResultMsg): boolean;
  closeDoc(): void;
  reset(): void;
}

function newCorrelationId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const useConductorStore = create<ConductorStore>((set, get) => ({
  pipelines: [],
  warnings: [],
  loading: false,
  loaded: false,
  sessionId: null,
  pinnedBySession: {},
  agentTie: {},
  doc: null,
  pendingDocId: null,

  requestPipelines(client, sessionId) {
    const next = sessionId ?? null;
    // Asking about a different session drops what is on screen immediately.
    // Showing the previous session's pipelines until the new scan lands is
    // worse than showing nothing: it is wrong, and it looks right.
    set((s) =>
      s.sessionId === next
        ? { loading: true }
        : { loading: true, loaded: false, sessionId: next, pipelines: [], warnings: [] },
    );
    client.send({
      type: 'list_pipelines',
      ...(sessionId ? { sessionId } : {}),
      correlationId: newCorrelationId(),
    });
  },

  applyPipelineList(m) {
    // A reply that names a session we have since navigated away from is a
    // scan nobody is waiting for any more.
    if (m.sessionId !== undefined && m.sessionId !== get().sessionId) return;
    set({
      pipelines: m.pipelines.slice(),
      warnings: m.warnings.slice(),
      loading: false,
      loaded: true,
    });
  },

  setAgentTie(sessionId, slug) {
    set((s) => (s.agentTie[sessionId] === slug ? {} : { agentTie: { ...s.agentTie, [sessionId]: slug } }));
  },

  pin(sessionId, slug) {
    set((s) => {
      const next = { ...s.pinnedBySession };
      if (slug === null) delete next[sessionId];
      else next[sessionId] = slug;
      return { pinnedBySession: next };
    });
  },

  pinnedFor(sessionId) {
    return sessionId ? get().pinnedBySession[sessionId] ?? null : null;
  },

  openDoc(client, path, name) {
    const correlationId = newCorrelationId();
    set({ doc: { state: 'loading', path, name }, pendingDocId: correlationId });
    client.send({ type: 'read_file', path, correlationId });
  },

  applyFileResult(m) {
    const pending = get().pendingDocId;
    if (!pending || m.correlationId !== pending) return false;
    const doc = get().doc;
    const name = doc?.name ?? m.path;
    if (m.kind === 'text') {
      set({ doc: { state: 'text', path: m.path, name, content: m.content }, pendingDocId: null });
    } else {
      // Pipeline artefacts are markdown. Anything else is a surprise worth
      // naming rather than rendering as blank.
      set({
        doc: {
          state: 'error',
          path: m.path,
          name,
          message: m.kind === 'too_large' ? 'File is too large to open.' : 'Not a text file.',
        },
        pendingDocId: null,
      });
    }
    return true;
  },

  closeDoc() {
    set({ doc: null, pendingDocId: null });
  },

  reset() {
    // `pinnedBySession` deliberately survives: it is the user's answer to
    // "which pipeline", and re-entering a session should not ask again.
    set({
      pipelines: [],
      warnings: [],
      loading: false,
      loaded: false,
      sessionId: null,
      agentTie: {},
      doc: null,
      pendingDocId: null,
    });
  },
}));

const NO_PIPELINES: PipelineSummary[] = [];
const NO_WARNINGS: string[] = [];

/**
 * The scan for one session — or nothing, when the store holds another's.
 *
 * Every caller that reads pipelines goes through this. The store is global and
 * a scan is slow, so "whose data is this?" has to be answered in one place;
 * asking each screen to remember would mean each screen could forget.
 */
export function useSessionPipelines(sessionId: string | undefined): {
  pipelines: PipelineSummary[];
  warnings: string[];
  loaded: boolean;
} {
  const mine = useConductorStore((s) => s.sessionId === (sessionId ?? null));
  const pipelines = useConductorStore((s) => s.pipelines);
  const warnings = useConductorStore((s) => s.warnings);
  const loaded = useConductorStore((s) => s.loaded);
  return {
    pipelines: mine ? pipelines : NO_PIPELINES,
    warnings: mine ? warnings : NO_WARNINGS,
    loaded: mine && loaded,
  };
}

/**
 * Which pipeline this session is tied to, in order of authority:
 * the user's pin, then the agent's own claim, then the most recently touched.
 *
 * Returns null rather than guessing when there is nothing to show.
 */
export function selectTiedPipeline(
  pipelines: PipelineSummary[],
  opts: { pinnedSlug?: string | null; agentSlug?: string | null } = {},
): PipelineSummary | null {
  if (pipelines.length === 0) return null;
  if (opts.pinnedSlug) {
    const pinned = pipelines.find((p) => p.slug === opts.pinnedSlug);
    if (pinned) return pinned;
  }
  if (opts.agentSlug) {
    const claimed = pipelines.find((p) => p.slug === opts.agentSlug);
    if (claimed) return claimed;
  }
  // The bridge sorts by STATE.md mtime descending, so this is "the one
  // somebody touched last" — the best available guess, and the reason the
  // pin exists.
  return pipelines[0] ?? null;
}

/**
 * One-line summary for the header badge.
 *
 * Phase and step are the two fields that answer "where is it", and both are
 * free-form strings from the pipeline's own STATE.md rather than an enum this
 * app defines — conductor's vocabulary changes, and a badge that renders only
 * the values it was compiled against would go blank rather than out of date.
 */
export function pipelineBadgeLabel(p: PipelineSummary): string {
  const bits: string[] = [];
  const running = p.slices.filter((s) => s.inFlight).length;
  if (p.slice) {
    // With workers running alongside, "+2" is what the badge owes you: the
    // slice in front is no longer the whole of what is happening. The total
    // steps aside for it — two counts in five characters reads as neither.
    if (running > 1) bits.push(`${p.slice} +${running - 1}`);
    else bits.push(p.slicesTotal ? `${p.slice}/${p.slicesTotal}` : p.slice);
  } else if (running > 1) {
    bits.push(`${running} slices`);
  }
  if (p.phase) bits.push(`ph${p.phase}`);
  if (p.step) bits.push(p.step);
  return bits.length > 0 ? bits.join(' · ') : p.slug;
}

/**
 * The slices to render for a pipeline — its own, or one standing in.
 *
 * A pipeline written before slices existed keeps its tickets at the root and
 * has no `slices/` at all. Rather than the page carrying two layouts, that
 * pipeline is presented as a single slice named after itself, so "the work" is
 * one shape everywhere and the old pipelines keep opening.
 */
export function sliceRoster(p: PipelineSummary): SliceSummary[] {
  if (p.slices.length > 0) return p.slices;
  if (p.tickets.length === 0) return [];
  return [
    {
      id: p.slug,
      dir: p.dir,
      state: p.state,
      phase: p.phase,
      step: p.step,
      status: null,
      inFlight: false,
      foreground: false,
      worktree: p.worktree,
      branch: p.state.branch ?? null,
      currentTicket: p.state.current_ticket ?? null,
      attempt: null,
      ticketsDone: p.tickets.filter((t) => t.status === 'done').length,
      ticketsTotal: p.tickets.length,
      lastVerdict: p.state.last_verdict ?? null,
      blocked: p.blocked,
      artefacts: [],
      tickets: p.tickets,
      ticketsDir: p.ticketsDir,
      lastSync: null,
      mtime: p.mtime,
    },
  ];
}
