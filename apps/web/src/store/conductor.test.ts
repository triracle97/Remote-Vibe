import { describe, it, expect, beforeEach } from 'vitest';
import {
  docSections,
  pipelineBadgeLabel,
  selectTiedPipeline,
  sliceRoster,
  useConductorStore,
} from './conductor';
import type { PipelineSummary, SliceSummary } from '../types/protocol';

function pipeline(over: Partial<PipelineSummary> = {}): PipelineSummary {
  return {
    slug: 'demo',
    dir: '/repo/.pipeline/demo',
    state: {},
    phase: '1',
    step: 'aspects',
    slice: null,
    slicesDone: null,
    slicesTotal: null,
    concurrency: null,
    slices: [],
    blocked: false,
    artefacts: [],
    tickets: [],
    ticketsDir: null,
    worktree: '/repo',
    inSessionDir: true,
    mtime: 1,
    ...over,
  };
}

function slice(over: Partial<SliceSummary> = {}): SliceSummary {
  return {
    id: 'S-01',
    dir: '/repo/.pipeline/demo/slices/S-01',
    state: {},
    phase: '1',
    step: 'plan',
    status: 'dispatched',
    inFlight: true,
    foreground: false,
    worktree: null,
    branch: null,
    currentTicket: null,
    attempt: null,
    ticketsDone: null,
    ticketsTotal: null,
    lastVerdict: null,
    blocked: false,
    artefacts: [],
    tickets: [],
    ticketsDir: null,
    lastSync: null,
    mtime: 1,
    ...over,
  };
}

describe('selectTiedPipeline', () => {
  it('returns null when nothing was found', () => {
    expect(selectTiedPipeline([])).toBeNull();
  });

  it('ties to the only pipeline without needing any user action', () => {
    const only = pipeline({ slug: 'inventory' });
    expect(selectTiedPipeline([only])?.slug).toBe('inventory');
  });

  it('falls back to the most recently touched when several exist', () => {
    // The bridge sorts by STATE.md mtime descending.
    const list = [pipeline({ slug: 'newest', mtime: 9 }), pipeline({ slug: 'older', mtime: 2 })];
    expect(selectTiedPipeline(list)?.slug).toBe('newest');
  });

  it("prefers the agent's own claim over the recency guess", () => {
    const list = [pipeline({ slug: 'newest', mtime: 9 }), pipeline({ slug: 'claimed', mtime: 2 })];
    expect(selectTiedPipeline(list, { agentSlug: 'claimed' })?.slug).toBe('claimed');
  });

  it('prefers the user pin over both the agent and recency', () => {
    const list = [
      pipeline({ slug: 'newest', mtime: 9 }),
      pipeline({ slug: 'claimed', mtime: 5 }),
      pipeline({ slug: 'pinned', mtime: 1 }),
    ];
    expect(
      selectTiedPipeline(list, { pinnedSlug: 'pinned', agentSlug: 'claimed' })?.slug,
    ).toBe('pinned');
  });

  it('ignores a pin or claim naming a pipeline that is no longer there', () => {
    const list = [pipeline({ slug: 'newest', mtime: 9 })];
    expect(selectTiedPipeline(list, { pinnedSlug: 'deleted' })?.slug).toBe('newest');
    expect(selectTiedPipeline(list, { agentSlug: 'deleted' })?.slug).toBe('newest');
  });
});

describe('pipelineBadgeLabel', () => {
  it('shows slice, phase and step when the pipeline has slices', () => {
    expect(
      pipelineBadgeLabel(pipeline({ slice: 'S-02', slicesTotal: 4, phase: '3', step: 'ticket' })),
    ).toBe('S-02/4 · ph3 · ticket');
  });

  it('omits the slice for a pipeline that predates slicing', () => {
    expect(pipelineBadgeLabel(pipeline({ slice: null, phase: '2', step: 'fog' }))).toBe('ph2 · fog');
  });

  it('falls back to the slug when STATE.md said nothing useful', () => {
    expect(pipelineBadgeLabel(pipeline({ phase: null, step: null }))).toBe('demo');
  });

  it('counts the other slices running alongside this one', () => {
    // Parallel dispatch means the badge's one line is no longer the whole
    // story, and "+2" is the shortest way to say there is more to look at.
    const p = pipeline({
      slice: 'S-01b',
      slicesTotal: 12,
      phase: '3',
      step: 'ready',
      slices: [
        slice({ id: 'S-01b', foreground: true }),
        slice({ id: 'S-02' }),
        slice({ id: 'S-03' }),
      ],
    });
    expect(pipelineBadgeLabel(p)).toBe('S-01b +2 · ph3 · ready');
  });

  it('keeps the slice count out of it when only one slice is running', () => {
    const p = pipeline({
      slice: 'S-01b',
      slicesTotal: 12,
      phase: '3',
      step: 'ready',
      slices: [slice({ id: 'S-01b', foreground: true }), slice({ id: 'S-01a', inFlight: false })],
    });
    expect(pipelineBadgeLabel(p)).toBe('S-01b/12 · ph3 · ready');
  });
});

describe('sliceRoster', () => {
  it('hands back the slices the bridge found', () => {
    const p = pipeline({ slices: [slice({ id: 'S-01b' }), slice({ id: 'S-02' })] });
    expect(sliceRoster(p).map((s) => s.id)).toEqual(['S-01b', 'S-02']);
  });

  it('gives a pre-slices pipeline one slice to stand in for it', () => {
    // So the page has a single way to render work, rather than one path for
    // pipelines with slices and another for the ones that predate them.
    const p = pipeline({
      slice: null,
      phase: '3',
      step: 'ticket',
      tickets: [{ id: 'T-001', title: 'first', type: 'build', status: 'done', covers: null, blockedBy: null }],
      ticketsDir: '/repo/.pipeline/demo/tickets',
    });
    const [only] = sliceRoster(p);
    expect(sliceRoster(p)).toHaveLength(1);
    expect(only).toMatchObject({
      id: 'demo',
      phase: '3',
      step: 'ticket',
      ticketsDir: '/repo/.pipeline/demo/tickets',
      inFlight: false,
    });
    expect(only!.tickets.map((t) => t.id)).toEqual(['T-001']);
  });

  it('stands in nothing when a pre-slices pipeline has no tickets either', () => {
    expect(sliceRoster(pipeline({ slice: null }))).toEqual([]);
  });

  it('survives a bridge that is older than this field', () => {
    // The tab reloads before the bridge restarts — routine during a deploy,
    // and the reason index.html is served no-store. A missing `slices` must
    // read as "none", not take the page down.
    const old = pipeline({
      tickets: [
        { id: 'T-001', title: 'first', type: 'build', status: 'done', covers: null, blockedBy: null },
      ],
      ticketsDir: '/repo/.pipeline/demo/tickets',
    });
    delete (old as { slices?: unknown }).slices;
    expect(() => sliceRoster(old)).not.toThrow();
    expect(sliceRoster(old).map((s) => s.id)).toEqual(['demo']);
  });
});

describe('docSections', () => {
  it('splits each ### into its own section so PATHS.md is navigable', () => {
    // PATHS.md is one `## Paths` heading above 340 `### P-xx` entries. Split at
    // `##` only, that is a single 250K chunk with a two-row outline.
    const s = docSections('# Title\n\n## Paths\n\n### P-01\nfirst\n\n### P-02\nsecond\n');
    expect(s.map((x) => x.heading)).toEqual(['Title', 'Paths', 'P-01', 'P-02']);
    expect(s.map((x) => x.level)).toEqual([1, 2, 3, 3]);
    expect(s[2]!.body).toBe('first');
  });

  it('leaves #### and deeper inline as prose structure', () => {
    const s = docSections('### P-01\nbody\n\n#### Detail\nmore\n');
    expect(s.map((x) => x.heading)).toEqual(['P-01']);
    expect(s[0]!.body).toContain('#### Detail');
  });

  it('keeps text that appears before any heading', () => {
    const s = docSections('preamble prose\n\n## First\nbody\n');
    expect(s[0]).toMatchObject({ heading: '(top)', level: 0 });
    expect(s[0]!.body).toBe('preamble prose');
  });

  it('drops an empty preamble rather than showing a blank section', () => {
    const s = docSections('\n\n## Only\nbody\n');
    expect(s.map((x) => x.heading)).toEqual(['Only']);
  });

  it('keeps a heading whose section is empty', () => {
    // "This section exists and is empty" is real information in a spec.
    const s = docSections('## Filled\nbody\n\n## Empty\n');
    expect(s.map((x) => x.heading)).toEqual(['Filled', 'Empty']);
    expect(s[1]!.body).toBe('');
  });

  it('returns one section for a document with no headings', () => {
    const s = docSections('just prose');
    expect(s).toHaveLength(1);
    expect(s[0]!.body).toBe('just prose');
  });

  it('records the heading level', () => {
    const s = docSections('# One\na\n\n## Two\nb\n');
    expect(s.map((x) => x.level)).toEqual([1, 2]);
  });
});

describe('useConductorStore', () => {
  beforeEach(() => {
    useConductorStore.setState({
      pipelines: [],
      warnings: [],
      loading: false,
      loaded: false,
      pinnedBySession: {},
      agentTie: {},
      doc: null,
      pendingDocId: null,
    });
  });

  it('opens a doc and claims only its own file_result', () => {
    const sent: Array<{ correlationId?: string }> = [];
    useConductorStore
      .getState()
      .openDoc({ send: (m) => sent.push(m as { correlationId?: string }) }, '/p/SPEC.md', 'SPEC.md');
    expect(useConductorStore.getState().doc).toMatchObject({ state: 'loading', name: 'SPEC.md' });

    // Somebody else's read — the file drawer's — must not land here.
    const foreign = useConductorStore.getState().applyFileResult({
      type: 'file_result',
      kind: 'text',
      path: '/other.ts',
      content: 'x',
      bytesRead: 1,
      truncated: false,
      hash: 'h',
      correlationId: 'not-ours',
    });
    expect(foreign).toBe(false);
    expect(useConductorStore.getState().doc).toMatchObject({ state: 'loading' });

    const claimed = useConductorStore.getState().applyFileResult({
      type: 'file_result',
      kind: 'text',
      path: '/p/SPEC.md',
      content: '## R\nrule',
      bytesRead: 11,
      truncated: false,
      hash: 'h',
      correlationId: sent[0]!.correlationId!,
    });
    expect(claimed).toBe(true);
    expect(useConductorStore.getState().doc).toMatchObject({
      state: 'text',
      content: '## R\nrule',
    });
  });

  it('reports a too-large artefact instead of rendering nothing', () => {
    const sent: Array<{ correlationId?: string }> = [];
    useConductorStore
      .getState()
      .openDoc({ send: (m) => sent.push(m as { correlationId?: string }) }, '/p/PATHS.md', 'PATHS.md');
    useConductorStore.getState().applyFileResult({
      type: 'file_result',
      kind: 'too_large',
      path: '/p/PATHS.md',
      size: 99_000_000,
      correlationId: sent[0]!.correlationId!,
    });
    expect(useConductorStore.getState().doc).toMatchObject({
      state: 'error',
      message: 'File is too large to open.',
    });
  });

  it('ignores a stale reply after the doc was closed', () => {
    const sent: Array<{ correlationId?: string }> = [];
    useConductorStore
      .getState()
      .openDoc({ send: (m) => sent.push(m as { correlationId?: string }) }, '/p/A.md', 'A.md');
    useConductorStore.getState().closeDoc();
    const claimed = useConductorStore.getState().applyFileResult({
      type: 'file_result',
      kind: 'text',
      path: '/p/A.md',
      content: 'late',
      bytesRead: 4,
      truncated: false,
      hash: 'h',
      correlationId: sent[0]!.correlationId!,
    });
    expect(claimed).toBe(false);
    expect(useConductorStore.getState().doc).toBeNull();
  });

  it('distinguishes "not scanned yet" from "scanned, found none"', () => {
    expect(useConductorStore.getState().loaded).toBe(false);
    useConductorStore.getState().applyPipelineList({
      type: 'pipeline_list',
      pipelines: [],
      warnings: [],
    });
    expect(useConductorStore.getState().loaded).toBe(true);
    expect(useConductorStore.getState().pipelines).toEqual([]);
  });

  it('keeps the scan warnings rather than dropping them', () => {
    useConductorStore.getState().applyPipelineList({
      type: 'pipeline_list',
      pipelines: [],
      warnings: ['/x: worktree is outside BRIDGE_ALLOWED_DIRS, skipped'],
    });
    expect(useConductorStore.getState().warnings).toHaveLength(1);
  });

  it('sends list_pipelines scoped to the session', () => {
    const sent: unknown[] = [];
    useConductorStore.getState().requestPipelines({ send: (m) => sent.push(m) }, 'sess-1');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'list_pipelines', sessionId: 'sess-1' });
    expect(useConductorStore.getState().loading).toBe(true);
  });

  it('keeps the pin across a reset — the user already answered "which one"', () => {
    useConductorStore.getState().pin('sess-1', 'chosen');
    useConductorStore.getState().reset();
    expect(useConductorStore.getState().pinnedFor('sess-1')).toBe('chosen');
    expect(useConductorStore.getState().loaded).toBe(false);
  });

  it('pins per session, so one session’s answer is not imposed on another', () => {
    useConductorStore.getState().pin('sess-1', 'alpha');
    expect(useConductorStore.getState().pinnedFor('sess-1')).toBe('alpha');
    expect(useConductorStore.getState().pinnedFor('sess-2')).toBeNull();
  });

  it('forgets the previous session’s pipelines the moment another asks', () => {
    // The bug: open session A, open session B, and B shows A's pipeline until
    // B's own scan comes back — which on a big repo is seconds of a lie.
    const client = { send: () => {} };
    useConductorStore.getState().requestPipelines(client, 'sess-1');
    useConductorStore.getState().applyPipelineList({
      type: 'pipeline_list',
      pipelines: [pipeline({ slug: 'a-pipeline' })],
      warnings: ['a warning'],
      sessionId: 'sess-1',
    });
    expect(useConductorStore.getState().pipelines).toHaveLength(1);

    useConductorStore.getState().requestPipelines(client, 'sess-2');

    expect(useConductorStore.getState().pipelines).toEqual([]);
    expect(useConductorStore.getState().warnings).toEqual([]);
    expect(useConductorStore.getState().loaded).toBe(false);
  });

  it('drops a scan that answers a session no longer being looked at', () => {
    // A scan walks worktrees and shells out to git; its reply can easily land
    // after the user has moved on, and it must not paint over the new session.
    const client = { send: () => {} };
    useConductorStore.getState().requestPipelines(client, 'sess-1');
    useConductorStore.getState().requestPipelines(client, 'sess-2');

    useConductorStore.getState().applyPipelineList({
      type: 'pipeline_list',
      pipelines: [pipeline({ slug: 'late-from-sess-1' })],
      warnings: [],
      sessionId: 'sess-1',
    });

    expect(useConductorStore.getState().pipelines).toEqual([]);
    expect(useConductorStore.getState().loaded).toBe(false);
  });

  it('accepts an unscoped scan, which is the every-directory one', () => {
    useConductorStore.getState().requestPipelines({ send: () => {} });
    useConductorStore.getState().applyPipelineList({
      type: 'pipeline_list',
      pipelines: [pipeline({ slug: 'anywhere' })],
      warnings: [],
    });
    expect(useConductorStore.getState().pipelines.map((p) => p.slug)).toEqual(['anywhere']);
  });

  it('records an agent claim per session', () => {
    useConductorStore.getState().setAgentTie('sess-1', 'alpha');
    useConductorStore.getState().setAgentTie('sess-2', 'beta');
    expect(useConductorStore.getState().agentTie).toEqual({ 'sess-1': 'alpha', 'sess-2': 'beta' });
  });
});
