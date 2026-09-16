import { execFile } from 'node:child_process';
import { readdir, readFile, realpath as fsRealpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Read-only view of a conductor pipeline (`.pipeline/<slug>/`).
 *
 * The conductor skill keeps all its state as markdown in a worktree, which
 * means the only way to see where a long pipeline has got to is to open a
 * terminal and read files. This finds those directories and parses the one
 * file that answers "where is it": `STATE.md`.
 *
 * Deliberately tolerant. `STATE.md`'s fields changed when conductor was
 * restructured around slices, and they will change again — so nothing here
 * requires a particular key to exist. Unknown keys are carried through
 * verbatim and rendered as-is, and a pipeline written by an older conductor
 * still lists and still opens.
 */

/**
 * How deep below a worktree root to look for `.pipeline/<slug>/STATE.md`.
 *
 * Shallow on purpose. `init_pipeline.sh` creates `.pipeline/` in the cwd, which
 * is a repo or worktree root, so it sits at depth 1 — and because every
 * worktree is enumerated and scanned *from its own root*, a pipeline in a
 * nested worktree is still depth 1 rather than 4. Depth 3 is margin, not need.
 *
 * This is a performance bound, not a correctness one. A repo with 27 worktrees
 * is 27 full source trees; at depth 6 the walk took 10.8s, which is far too
 * slow for something that runs when a session opens.
 */
const MAX_SCAN_DEPTH = 3;

const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'vendor',
  'target',
  '.next',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'Pods',
  '.gradle',
  'DerivedData',
]);

export interface PipelineArtefact {
  name: string;
  size: number;
  /** ms since epoch. */
  mtime: number;
}

/**
 * One `tickets/T-xxx.md` file, reduced to its header.
 *
 * Parsed here rather than in the browser because the alternative is shipping
 * every ticket body to render a status column — a pipeline in the failed run
 * had 46 of them. Fields are all optional strings: a ticket is markdown a
 * planner wrote, not a schema, and half-filled ones are normal mid-phase.
 */
export interface TicketSummary {
  /** From the filename, e.g. `T-012`. */
  id: string;
  /** First `# ` heading, minus the id prefix. Empty when the file has none. */
  title: string;
  type: string | null;
  status: string | null;
  covers: string | null;
  blockedBy: string | null;
}

export interface PipelineSummary {
  /** Directory name under `.pipeline/`. */
  slug: string;
  /** Absolute path to `.pipeline/<slug>`. */
  dir: string;
  /**
   * Every `key: value` line in STATE.md, in file order.
   *
   * Not narrowed to a fixed shape on purpose — see the note above. The named
   * fields below are conveniences lifted out of this map, not a replacement
   * for it, and the UI renders the whole map so a field this bridge has never
   * heard of still reaches the screen.
   */
  state: Record<string, string>;
  phase: string | null;
  step: string | null;
  /** Current slice id (`S-01`), or null for a pipeline with no slices. */
  slice: string | null;
  slicesDone: number | null;
  slicesTotal: number | null;
  /** True when a `BLOCKED.md` exists at feature level or in the current slice. */
  blocked: boolean;
  /** Feature-level markdown files, newest first. */
  artefacts: PipelineArtefact[];
  /** The current slice's markdown files, if the pipeline has slices. */
  sliceArtefacts: PipelineArtefact[];
  /**
   * Tickets for the current slice, or the pipeline's own `tickets/` for a
   * pipeline written before slices existed. Empty before phase 2.
   */
  tickets: TicketSummary[];
  /** Absolute path the tickets came from, for the UI to open them. */
  ticketsDir: string | null;
  /** Worktree root this pipeline was found under. */
  worktree: string;
  /**
   * True when the pipeline sits inside one of the session's own working dirs.
   *
   * The distinction is the whole ranking. A repo with many worktrees has many
   * `.pipeline/` dirs, and "most recently touched" picks somebody else's work:
   * a session in worktree A would tie to a pipeline in worktree B simply
   * because B was touched last. It must not be dropped from the list though —
   * conductor's own design puts state in a worktree while the skill runs from
   * the main checkout, so a session legitimately drives a pipeline outside its
   * own dir. It is shown, and labelled.
   */
  inSessionDir: boolean;
  /** mtime of STATE.md — the pipeline's own "last touched". */
  mtime: number;
}

export interface ConductorScannerOpts {
  allowedDirs: string[];
  /** Working dirs for a session id: `[projectPath, ...additionalDirs]`. */
  getDirsForSession(sessionId: string): string[];
  /** Injected in tests. Returns absolute worktree roots for a directory. */
  listWorktrees?(dir: string): Promise<string[]>;
}

export interface ScanResult {
  pipelines: PipelineSummary[];
  /**
   * Why a directory produced nothing.
   *
   * Reported rather than swallowed: "no pipelines" and "could not look" are
   * different answers, and conductor's own discovery bug was exactly a silent
   * version of the second one.
   */
  warnings: string[];
}

/**
 * Worktree roots for `dir`, via `git worktree list`.
 *
 * Not a `find` from the repo root. A worktree can live anywhere on disk — a
 * sibling directory, a `wt/<name>` tree elsewhere entirely — and a walk rooted
 * at the top level cannot see those, so a pipeline living in one reports as
 * "no pipelines". `git worktree list` puts the main checkout first, so the
 * starting directory is covered too.
 */
async function gitWorktrees(dir: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
    cwd: dir,
    maxBuffer: 4 * 1024 * 1024,
  });
  const roots: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) roots.push(line.slice('worktree '.length).trim());
  }
  return roots;
}

/**
 * Parse `key: value` lines out of a STATE.md-shaped file.
 *
 * Skips markdown headings and HTML comments, and strips a trailing ` # …`
 * annotation, which conductor's template uses to document a field's allowed
 * values. A `#` with no whitespace before it is left alone — it could be part
 * of the value (a branch name, a commit subject).
 */
export function parseStateFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inFence = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    // A fenced block is content, not fields. Without this a snippet like
    // `type: { type: 'string' },` inside an example reads as a real field —
    // and since later lines win, it overwrites the genuine one.
    if (line.startsWith('```') || line.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.length === 0 || line.startsWith('#') || line.startsWith('<!--')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    // A key with spaces is prose with a colon in it, not a field.
    if (key.length === 0 || /\s/.test(key)) continue;
    let value = line.slice(colon + 1).trim();
    const comment = value.search(/\s+#/);
    if (comment >= 0) value = value.slice(0, comment).trim();
    out[key] = value;
  }
  return out;
}

function intOrNull(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nonEmpty(v: string | undefined): string | null {
  return v === undefined || v === '' ? null : v;
}

async function listMarkdown(dir: string): Promise<PipelineArtefact[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: PipelineArtefact[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    try {
      const st = await stat(join(dir, e.name));
      out.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
    } catch {
      /* vanished between readdir and stat — skip */
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Ticket id from a filename: `T-012.md` → `T-012`. Null when it is not one. */
function ticketIdFrom(filename: string): string | null {
  const m = /^(T-[A-Za-z0-9]+)\.md$/.exec(filename);
  return m ? m[1]! : null;
}

async function listTickets(dir: string): Promise<TicketSummary[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: TicketSummary[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const id = ticketIdFrom(e.name);
    if (!id) continue;
    let text: string;
    try {
      text = await readFile(join(dir, e.name), 'utf8');
    } catch {
      continue;
    }
    // Header only. A ticket's fields sit above its first `## ` section; below
    // that is prose, scope notes and code. Parsing the whole file let a body
    // line overwrite a real header field — observed on a live pipeline, where
    // a schema snippet turned a `build` ticket's type into `{ type: 'string' },`.
    const sectionStart = text.search(/^##\s/m);
    const header = sectionStart >= 0 ? text.slice(0, sectionStart) : text;
    const fields = parseStateFile(header);
    // `# T-012 — goal` → `goal`. The id is already the column beside it.
    const heading = /^#\s+(.*)$/m.exec(text)?.[1]?.trim() ?? '';
    const title = heading.replace(/^T-[A-Za-z0-9]+\s*[—–-]\s*/, '').trim();
    out.push({
      id,
      title,
      type: nonEmpty(fields.type),
      status: nonEmpty(fields.status),
      covers: nonEmpty(fields.covers),
      blockedBy: nonEmpty(fields.blocked_by),
    });
  }
  // Natural order by id, so T-2 sorts before T-10.
  out.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk `root` for `.pipeline/<slug>/STATE.md`, bounded in depth and pruned.
 *
 * Records the worktree each hit was found under, so the caller can tell a
 * session's own pipeline from one belonging to a sibling worktree.
 */
async function findPipelineDirs(root: string, found: Map<string, string>): Promise<void> {
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const child = join(dir, e.name);
      if (e.name === '.pipeline') {
        let slugs;
        try {
          slugs = await readdir(child, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const s of slugs) {
          if (!s.isDirectory()) continue;
          const pipelineDir = join(child, s.name);
          // Most specific worktree wins, not the first to reach it. A nested
          // worktree's pipeline is reachable from the outer checkout too, and
          // crediting it to the outer one would misreport whose work it is.
          const prior = found.get(pipelineDir);
          if (prior !== undefined && prior.length >= root.length) continue;
          if (await exists(join(pipelineDir, 'STATE.md'))) found.set(pipelineDir, root);
        }
        continue; // never descend into .pipeline itself
      }
      await walk(child, depth + 1);
    }
  };
  await walk(root, 0);
}

export class ConductorScanner {
  private readonly allowedDirs: string[];
  private resolvedAllowed: string[] | null = null;
  private readonly getDirsForSession: (sessionId: string) => string[];
  private readonly listWorktrees: (dir: string) => Promise<string[]>;

  constructor(opts: ConductorScannerOpts) {
    this.allowedDirs = opts.allowedDirs;
    this.getDirsForSession = opts.getDirsForSession;
    this.listWorktrees = opts.listWorktrees ?? gitWorktrees;
  }

  private async allowed(): Promise<string[]> {
    if (this.resolvedAllowed) return this.resolvedAllowed;
    this.resolvedAllowed = await Promise.all(
      this.allowedDirs.map((d) => fsRealpath(d).catch(() => d)),
    );
    return this.resolvedAllowed;
  }

  private async isInsideAllowed(p: string): Promise<boolean> {
    const allowed = await this.allowed();
    let real: string;
    try {
      real = await fsRealpath(p);
    } catch {
      return false;
    }
    return allowed.some((d) => real === d || real.startsWith(d + sep));
  }

  /**
   * Find pipelines reachable from a session's working dirs, or from every
   * allowed dir when no session is named.
   *
   * A worktree is often outside the allowlist even when the repo is inside it,
   * so every candidate is gated before it is read — the bridge must not hand
   * back a file the token was never granted.
   */
  async scan(sessionId?: string): Promise<ScanResult> {
    const roots = sessionId ? this.getDirsForSession(sessionId) : this.allowedDirs;
    const warnings: string[] = [];
    const candidates = new Map<string, string>();
    const seenWorktrees = new Set<string>();

    // The session's own dirs, resolved, for the proximity test below.
    const sessionDirs = await Promise.all(roots.map((d) => fsRealpath(d).catch(() => d)));

    for (const root of roots) {
      let worktrees: string[];
      try {
        worktrees = await this.listWorktrees(root);
      } catch (err) {
        // Not a git repo, or no git. Still worth walking the directory itself.
        warnings.push(`${root}: could not list worktrees (${(err as Error).message.split('\n')[0]})`);
        worktrees = [];
      }
      for (const wt of [root, ...worktrees]) {
        if (seenWorktrees.has(wt)) continue;
        seenWorktrees.add(wt);
        if (!(await this.isInsideAllowed(wt))) {
          // Always report, and say plainly when it is the session's OWN dir.
          // Staying quiet there was the worst case: the session's real pipeline
          // is invisible, some other worktree's is shown instead, and nothing
          // on screen explains why.
          warnings.push(
            wt === root
              ? `${wt}: this session's own directory is outside BRIDGE_ALLOWED_DIRS — its pipeline cannot be read`
              : `${wt}: worktree is outside BRIDGE_ALLOWED_DIRS, skipped`,
          );
          continue;
        }
        await findPipelineDirs(wt, candidates);
      }
    }

    const pipelines: PipelineSummary[] = [];
    /**
     * How specifically a pipeline's worktree contains the session.
     *
     * The length of that worktree's path, or -1 when it does not contain the
     * session at all. Length is the tiebreak because worktrees nest: a session
     * in `repo/.claude/worktrees/x` is inside both `repo` and `x`, and `x` is
     * the one it is actually working in.
     */
    const containment = new Map<string, number>();

    for (const [dir, worktree] of candidates) {
      const summary = await this.read(dir, worktree, sessionDirs);
      if (!summary) continue;
      const realWt = await fsRealpath(worktree).catch(() => worktree);
      const contains = sessionDirs.some((d) => d === realWt || d.startsWith(realWt + sep));
      containment.set(dir, contains ? realWt.length : -1);
      pipelines.push(summary);
    }

    // Whose work is this? In order: the worktree the session is actually in,
    // then anything else under the session's dirs, then recency. Recency alone
    // was wrong — with many worktrees it hands a session whichever pipeline
    // somebody touched last, which is usually not the one it is working on.
    pipelines.sort(
      (a, b) =>
        (containment.get(b.dir) ?? -1) - (containment.get(a.dir) ?? -1) ||
        Number(b.inSessionDir) - Number(a.inSessionDir) ||
        b.mtime - a.mtime,
    );
    return { pipelines, warnings };
  }

  /** Read one `.pipeline/<slug>` directory into a summary. */
  private async read(
    dir: string,
    worktree: string,
    sessionDirs: string[],
  ): Promise<PipelineSummary | null> {
    const statePath = join(dir, 'STATE.md');
    let text: string;
    let mtime: number;
    try {
      const st = await stat(statePath);
      mtime = st.mtimeMs;
      text = await readFile(statePath, 'utf8');
    } catch {
      return null;
    }

    const state = parseStateFile(text);
    const slice = nonEmpty(state.slice);
    const sliceDir = slice ? join(dir, 'slices', slice) : null;

    // A sliced pipeline keeps tickets under the slice; one written before
    // slices existed keeps them at the root. Prefer the slice, fall back.
    const sliceTicketsDir = sliceDir ? join(sliceDir, 'tickets') : null;
    const ticketsDir =
      sliceTicketsDir && (await exists(sliceTicketsDir))
        ? sliceTicketsDir
        : (await exists(join(dir, 'tickets')))
          ? join(dir, 'tickets')
          : null;

    const [artefacts, sliceArtefacts, blockedRoot, blockedSlice, tickets] = await Promise.all([
      listMarkdown(dir),
      sliceDir ? listMarkdown(sliceDir) : Promise.resolve([]),
      exists(join(dir, 'BLOCKED.md')),
      sliceDir ? exists(join(sliceDir, 'BLOCKED.md')) : Promise.resolve(false),
      ticketsDir ? listTickets(ticketsDir) : Promise.resolve([]),
    ]);

    // Resolved on both sides: a session dir and a worktree path can reach the
    // same place through different symlinks (`/tmp` vs `/private/tmp`), and a
    // string compare would call a session's own pipeline somebody else's.
    const realDir = await fsRealpath(dir).catch(() => dir);
    const inSessionDir = sessionDirs.some(
      (d) => realDir === d || realDir.startsWith(d + sep),
    );

    const slug = dir.slice(dir.lastIndexOf(sep) + 1);
    return {
      slug,
      dir,
      worktree,
      inSessionDir,
      state,
      phase: nonEmpty(state.phase),
      step: nonEmpty(state.step),
      slice,
      slicesDone: intOrNull(state.slices_done),
      slicesTotal: intOrNull(state.slices_total),
      blocked: blockedRoot || blockedSlice,
      artefacts,
      sliceArtefacts,
      tickets,
      ticketsDir,
      mtime,
    };
  }
}
