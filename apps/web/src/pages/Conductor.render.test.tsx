import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { Conductor } from './Conductor';
import { useConductorStore } from '../store/conductor';
import { useConnectionStore } from '../store/connection';
import type { ClientMsg, PipelineSummary, SliceSummary } from '../types/protocol';

afterEach(cleanup);

const sent: ClientMsg[] = [];
const fakeClient = { send: (m: ClientMsg) => sent.push(m), on: () => () => {} };

vi.mock('../services/bridge-client-singleton', () => ({
  getBridgeClient: () => fakeClient,
}));

function pipeline(over: Partial<PipelineSummary> = {}): PipelineSummary {
  return {
    slug: 'inventory-stock-tracking',
    dir: '/repo/.pipeline/inventory-stock-tracking',
    state: { phase: '2', step: 'fog' },
    phase: '2',
    step: 'fog',
    slice: null,
    concurrency: null,
    slices: [],
    slicesDone: null,
    slicesTotal: null,
    blocked: false,
    artefacts: [
      { name: 'SPEC.md', size: 184_000, mtime: 3 },
      { name: 'PATHS.md', size: 300_000, mtime: 2 },
    ],
    tickets: [
      { id: 'T-001', title: 'first ticket', type: 'decide', status: 'resolved', covers: null, blockedBy: null },
    ],
    ticketsDir: '/repo/.pipeline/inventory-stock-tracking/tickets',
    worktree: '/repo',
    inSessionDir: true,
    mtime: 1,
    ...over,
  };
}

beforeEach(() => {
  sent.length = 0;
  useConductorStore.setState({
    pipelines: [],
    warnings: [],
    loading: false,
    loaded: false,
    sessionId: 's1',
    pinnedBySession: {},
    agentTie: {},
    doc: null,
    pendingDocId: null,
  });
  useConnectionStore.setState({ status: 'open' });

  // Desktop, and assigned unconditionally: happy-dom may define matchMedia
  // itself, in which case a guarded stub never applies. It has to be desktop
  // because the two presentations are different trees — on a phone the outline
  // lives inside a BottomSheet, which renders nothing at all while closed.
  window.matchMedia = ((q: string) => ({
    matches: true,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  // happy-dom ships neither of these, and the reader uses both: an observer to
  // reveal more sections on scroll, and scrollIntoView to jump from the outline.
  window.IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  Element.prototype.scrollIntoView = (): void => {};
});

/** Mount the page the way AppShell does: inside an Outlet carrying `client`. */
function renderPage(entry = '/session/s1/conductor') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<Outlet context={{ client: fakeClient }} />}>
          <Route path="/session/:id/conductor" element={<Conductor />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('Conductor page — overview', () => {
  it('scans on mount when the store is empty, so a direct load works', () => {
    renderPage();
    expect(sent.some((m) => m.type === 'list_pipelines')).toBe(true);
  });

  it('says so plainly when the scan found nothing', () => {
    useConductorStore.setState({ loaded: true, pipelines: [] });
    renderPage();
    expect(screen.getByText(/no .pipeline\/ directory/i)).toBeTruthy();
  });

  it('lists artefacts and tickets for the tied pipeline', () => {
    useConductorStore.setState({ loaded: true, pipelines: [pipeline()] });
    renderPage();
    expect(screen.getByText('SPEC.md')).toBeTruthy();
    expect(screen.getByText('PATHS.md')).toBeTruthy();
    expect(screen.getByText('T-001')).toBeTruthy();
  });

  it('shows the blocked state, the one thing worth seeing from a phone', () => {
    useConductorStore.setState({ loaded: true, pipelines: [pipeline({ blocked: true })] });
    renderPage();
    // Exact: a regex would match both the <strong> and its parent <span>.
    expect(screen.getByText('BLOCKED.')).toBeTruthy();
  });

  it('opens an artefact by putting it in the URL, not in component state', () => {
    // This is what makes Back work and a document linkable.
    useConductorStore.setState({ loaded: true, pipelines: [pipeline()] });
    renderPage();
    fireEvent.click(screen.getByText('SPEC.md'));
    const read = sent.find((m) => m.type === 'read_file');
    expect(read).toBeTruthy();
    expect((read as { path: string }).path).toBe(
      '/repo/.pipeline/inventory-stock-tracking/SPEC.md',
    );
  });
});

function slice(over: Partial<SliceSummary> = {}): SliceSummary {
  return {
    id: 'S-02',
    dir: '/repo/.pipeline/inventory-stock-tracking/slices/S-02',
    state: {},
    phase: '1',
    step: 'plan',
    status: 'dispatched',
    inFlight: true,
    foreground: false,
    worktree: '/repo/.claude/worktrees/inventory-stock-tracking-S-02',
    branch: 'conductor/inventory-stock-tracking-S-02',
    currentTicket: null,
    attempt: null,
    ticketsDone: null,
    ticketsTotal: null,
    lastVerdict: null,
    blocked: false,
    artefacts: [],
    tickets: [],
    ticketsDir: null,
    lastSync: '2026-09-16',
    mtime: 1,
    ...over,
  };
}

/** A pipeline mid-parallel-dispatch: one slice in front, two workers behind. */
function parallel(over: Partial<PipelineSummary> = {}): PipelineSummary {
  return pipeline({
    slice: 'S-01b',
    slicesDone: 4,
    slicesTotal: 12,
    concurrency: 3,
    tickets: [],
    ticketsDir: null,
    slices: [
      slice({
        id: 'S-01b',
        foreground: true,
        worktree: null,
        phase: '3',
        step: 'ready',
        status: 'active — T-007 parked',
        ticketsDone: 6,
        ticketsTotal: 7,
        currentTicket: 'T-007',
        attempt: 1,
        tickets: [
          { id: 'T-007', title: 'last ticket', type: 'build', status: 'open', covers: null, blockedBy: null },
        ],
        ticketsDir: '/repo/.pipeline/inventory-stock-tracking/slices/S-01b/tickets',
        artefacts: [{ name: 'ROUTE.md', size: 7_000, mtime: 5 }],
      }),
      slice({ id: 'S-02' }),
      slice({ id: 'S-03', phase: '2', step: 'fog' }),
    ],
    ...over,
  });
}

describe('Conductor page — parallel slices', () => {
  it('lists every worker, not only the slice in front', () => {
    useConductorStore.setState({ loaded: true, pipelines: [parallel()] });
    renderPage();
    for (const id of ['S-01b', 'S-02', 'S-03']) {
      expect(screen.getByText(id)).toBeTruthy();
    }
  });

  it('says where each worker is and what it is doing', () => {
    useConductorStore.setState({ loaded: true, pipelines: [parallel()] });
    renderPage();
    const workers = screen.getByRole('list', { name: /workers/i });
    expect(workers.textContent).toContain('3/ready');
    expect(workers.textContent).toContain('6/7');
    expect(workers.textContent).toContain('T-007');
    // A background worker is in its own worktree; naming it is how you tell
    // two workers apart when both are mid-phase-1.
    expect(workers.textContent).toContain('inventory-stock-tracking-S-02');
    expect(workers.textContent).toContain('foreground');
  });

  it('counts the parallel work in the state summary', () => {
    useConductorStore.setState({ loaded: true, pipelines: [parallel()] });
    renderPage();
    const summary = screen.getByTestId('conductor-summary');
    expect(summary.textContent).toContain('3 running');
    expect(summary.textContent).toContain('4/12 merged');
    expect(summary.textContent).toContain('3 at once');
  });

  it('puts a blocked worker at the top, where it cannot be missed', () => {
    const p = parallel();
    p.slices[2]!.blocked = true;
    useConductorStore.setState({ loaded: true, pipelines: [p] });
    renderPage();
    const ids = Array.from(
      screen.getByRole('list', { name: /workers/i }).querySelectorAll('[data-slice]'),
    ).map((el) => el.getAttribute('data-slice'));
    expect(ids[0]).toBe('S-03');
  });

  it('opens one worker’s own tickets and artefacts', () => {
    useConductorStore.setState({ loaded: true, pipelines: [parallel()] });
    renderPage();
    fireEvent.click(screen.getByText('S-01b'));
    expect(screen.getByText('T-007')).toBeTruthy();
    expect(screen.getByText('ROUTE.md')).toBeTruthy();
  });

  it('keeps the open worker in the URL so Back returns to the list', () => {
    useConductorStore.setState({ loaded: true, pipelines: [parallel()] });
    renderPage('/session/s1/conductor?slice=S-03');
    expect(screen.getByTestId('slice-detail').getAttribute('data-slice')).toBe('S-03');
  });

  it('shows one slice inline rather than making you open it', () => {
    // A pipeline with a single slice has no list worth tapping through.
    useConductorStore.setState({
      loaded: true,
      pipelines: [
        parallel({
          slices: [
            slice({
              id: 'S-02',
              tickets: [
                { id: 'T-100', title: 'only', type: 'build', status: 'open', covers: null, blockedBy: null },
              ],
              ticketsDir: '/repo/.pipeline/inventory-stock-tracking/slices/S-02/tickets',
            }),
          ],
        }),
      ],
    });
    renderPage();
    expect(screen.getByText('T-100')).toBeTruthy();
  });
});

describe('Conductor page — session scoping', () => {
  it('shows nothing from a scan that belongs to another session', () => {
    // Open session A, open session B: B must not wear A's pipeline while its
    // own scan is still running.
    useConductorStore.setState({ loaded: true, sessionId: 's2', pipelines: [parallel()] });
    renderPage('/session/s1/conductor');
    expect(screen.queryByText('S-01b')).toBeNull();
    expect(screen.getByText(/scanning/i)).toBeTruthy();
  });

  it('asks for its own session’s scan when the store holds another’s', () => {
    useConductorStore.setState({ loaded: true, sessionId: 's2', pipelines: [parallel()] });
    renderPage('/session/s1/conductor');
    expect(sent.some((m) => m.type === 'list_pipelines' && m.sessionId === 's1')).toBe(true);
  });
});

describe('Conductor page — document reader', () => {
  const doc = (content: string) => ({
    state: 'text' as const,
    path: '/repo/.pipeline/inventory-stock-tracking/SPEC.md',
    name: 'SPEC.md',
    content,
  });

  function renderDoc(content: string) {
    useConductorStore.setState({ loaded: true, pipelines: [pipeline()], doc: doc(content) });
    return renderPage(
      '/session/s1/conductor?doc=' +
        encodeURIComponent('/repo/.pipeline/inventory-stock-tracking/SPEC.md'),
    );
  }

  it('renders the whole document, not one section behind a dropdown', () => {
    renderDoc('## Rules\nfirst rule\n\n## Invariants\nsecond thing\n\n## Criteria\nthird thing\n');
    // All three bodies on the page at once — the complaint that started this
    // was having to pick sections one at a time from a select.
    expect(screen.getByText('first rule')).toBeTruthy();
    expect(screen.getByText('second thing')).toBeTruthy();
    expect(screen.getByText('third thing')).toBeTruthy();
  });

  it('builds an outline from the headings', () => {
    renderDoc('## Rules\na\n\n## Invariants\nb\n');
    const outline = screen.getByRole('navigation', { name: /document outline/i });
    expect(outline.textContent).toContain('Rules');
    expect(outline.textContent).toContain('Invariants');
  });

  it('gives every ### P-xx its own outline entry', () => {
    // PATHS.md is one `## Paths` above hundreds of these. Splitting at `##`
    // alone left a two-row outline over a 250K blob.
    renderDoc('## Paths\n\n### P-01\nalpha\n\n### P-02\nbravo\n');
    const outline = screen.getByRole('navigation', { name: /document outline/i });
    expect(outline.textContent).toContain('P-01');
    expect(outline.textContent).toContain('P-02');
  });

  it('holds back later sections on a big document rather than rendering 300K at once', () => {
    const big = Array.from({ length: 30 }, (_, i) => `## S${i}\nbody-${i}\n`).join('\n');
    renderDoc(big);
    expect(screen.getByText('body-0')).toBeTruthy();
    expect(screen.queryByText('body-29')).toBeNull();
    expect(screen.getByText(/more sections?/)).toBeTruthy();
  });

  it('reveals a section the window has not reached when the outline jumps to it', () => {
    // Without the reveal, every outline entry past the window would do nothing.
    const big = Array.from({ length: 30 }, (_, i) => `## S${i}\nbody-${i}\n`).join('\n');
    renderDoc(big);
    expect(screen.queryByText('body-25')).toBeNull();
    const outline = screen.getByRole('navigation', { name: /document outline/i });
    const entry = Array.from(outline.querySelectorAll('button')).find(
      (b) => b.textContent === 'S25',
    );
    expect(entry).toBeTruthy();
    fireEvent.click(entry!);
    expect(screen.getByText('body-25')).toBeTruthy();
  });

  it('shows a loading and an error state instead of a blank page', () => {
    useConductorStore.setState({
      loaded: true,
      pipelines: [pipeline()],
      doc: { state: 'error', path: '/p/PATHS.md', name: 'PATHS.md', message: 'File is too large to open.' },
    });
    renderPage('/session/s1/conductor?doc=' + encodeURIComponent('/p/PATHS.md'));
    expect(screen.getByText('File is too large to open.')).toBeTruthy();
  });
});
