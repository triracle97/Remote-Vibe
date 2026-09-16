import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { Conductor } from './Conductor';
import { useConductorStore } from '../store/conductor';
import { useConnectionStore } from '../store/connection';
import type { ClientMsg, PipelineSummary } from '../types/protocol';

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
    slicesDone: null,
    slicesTotal: null,
    blocked: false,
    artefacts: [
      { name: 'SPEC.md', size: 184_000, mtime: 3 },
      { name: 'PATHS.md', size: 300_000, mtime: 2 },
    ],
    sliceArtefacts: [],
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
    pinnedSlug: null,
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
