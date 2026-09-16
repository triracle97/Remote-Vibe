import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { ConductorScanner, parseDispatchTable, parseStateFile } from '../conductor.js';

const STATE = `# STATE — demo
phase: 1
step: aspects            # aspects | plan | plan-review
slice: S-01
slices_done: 0
slices_total: 3
branch: conductor/demo
base_commit:
test_cmd: npm test
notes:
`;

describe('parseStateFile', () => {
  it('reads key: value lines and strips the trailing annotation', () => {
    const s = parseStateFile(STATE);
    expect(s.phase).toBe('1');
    expect(s.step).toBe('aspects');
    expect(s.slices_total).toBe('3');
  });

  it('keeps empty values rather than dropping the key', () => {
    const s = parseStateFile(STATE);
    expect(s.base_commit).toBe('');
    expect('notes' in s).toBe(true);
  });

  it('does not treat a markdown heading or prose-with-colon as a field', () => {
    const s = parseStateFile('# STATE — demo\nSome prose: with a colon\nphase: 2\n');
    expect(s.phase).toBe('2');
    expect(Object.keys(s)).toEqual(['phase']);
  });

  it('leaves a # that is part of the value alone', () => {
    const s = parseStateFile('branch: feat/thing#42\n');
    expect(s.branch).toBe('feat/thing#42');
  });

  it('ignores key: value lines inside a fenced code block', () => {
    // Regression: a live pipeline had a schema snippet in a ticket body, and
    // because later lines win it overwrote the ticket's real `type`.
    const s = parseStateFile(
      'type: build\n\n```ts\nconst schema = {\ntype: { type: \'string\' },\n}\n```\n',
    );
    expect(s.type).toBe('build');
  });

  it('resumes reading fields after a fenced block closes', () => {
    const s = parseStateFile('a: 1\n```\nb: ignored\n```\nc: 3\n');
    expect(s).toEqual({ a: '1', c: '3' });
  });

  it('carries through a key it has never heard of', () => {
    // The whole point: conductor's fields change, and an unknown one must
    // still reach the UI rather than being silently dropped.
    const s = parseStateFile('some_future_field: yes\n');
    expect(s.some_future_field).toBe('yes');
  });
});

/** A root STATE.md as parallel dispatch writes it: feature fields plus a table. */
const PARALLEL_STATE = `# STATE — demo
concurrency: 3
slices_done: 1
slices_total: 9
branch: conductor/demo

## Dispatch table (parallel slices in flight) — written only by the root controller
| slice | worktree | branch | phase/step | status | last sync |
|---|---|---|---|---|---|
| S-01b | (this worktree, foreground) | conductor/demo-S-01b | 3/ready | active — T-007 parked | 2026-09-16 |
| S-02 | .claude/worktrees/demo-S-02 | conductor/demo-S-02 | 1/aspects | dispatched | 2026-09-16 |
| S-03 | .claude/worktrees/demo-S-03 | conductor/demo-S-03 | 1/plan | dispatched | 2026-09-16 |

notes:
`;

describe('parseDispatchTable', () => {
  it('reads a row per in-flight slice', () => {
    const rows = parseDispatchTable(PARALLEL_STATE);
    expect(rows.map((r) => r.slice)).toEqual(['S-01b', 'S-02', 'S-03']);
    expect(rows[1]).toMatchObject({
      worktree: '.claude/worktrees/demo-S-02',
      branch: 'conductor/demo-S-02',
      phase: '1',
      step: 'aspects',
      status: 'dispatched',
      lastSync: '2026-09-16',
      foreground: false,
    });
  });

  it('marks the row the root controller drives itself', () => {
    // "(this worktree, foreground)" is not a path, and the slice it names has
    // no separate worker — it is the session you are looking at.
    const rows = parseDispatchTable(PARALLEL_STATE);
    expect(rows[0]).toMatchObject({ slice: 'S-01b', foreground: true, worktree: null });
  });

  it('keeps the whole status cell, prose and all', () => {
    // The controller writes "active — T-007 parked on owner decision" here, and
    // that trailing clause is the most useful sentence on the page.
    expect(parseDispatchTable(PARALLEL_STATE)[0]!.status).toBe('active — T-007 parked');
  });

  it('follows the header rather than the column order', () => {
    const rows = parseDispatchTable(
      [
        '| status | slice | phase/step |',
        '|---|---|---|',
        '| blocked | S-04 | 4/review |',
      ].join('\n'),
    );
    expect(rows).toEqual([
      {
        slice: 'S-04',
        status: 'blocked',
        phase: '4',
        step: 'review',
        worktree: null,
        branch: null,
        foreground: false,
        lastSync: null,
      },
    ]);
  });

  it('ignores tables that are not the dispatch table', () => {
    const rows = parseDispatchTable('| file | size |\n|---|---|\n| SPEC.md | 24K |\n');
    expect(rows).toEqual([]);
  });

  it('finds no rows in a pipeline that never went parallel', () => {
    expect(parseDispatchTable(STATE)).toEqual([]);
  });
});

describe('ConductorScanner', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'conductor-scan-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const scanner = (opts: {
    allowedDirs: string[];
    dirs: string[];
    worktrees?: Record<string, string[]>;
    fail?: boolean;
  }): ConductorScanner =>
    new ConductorScanner({
      allowedDirs: opts.allowedDirs,
      getDirsForSession: () => opts.dirs,
      listWorktrees: async (d) => {
        if (opts.fail) throw new Error('not a git repository');
        return opts.worktrees?.[d] ?? [];
      },
    });

  async function makePipeline(base: string, slug: string, state = STATE): Promise<string> {
    const dir = join(base, '.pipeline', slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'STATE.md'), state);
    await writeFile(join(dir, 'BRIEF.md'), 'the task');
    return dir;
  }

  it('finds a pipeline in the session directory and lifts the named fields', async () => {
    const repo = join(root, 'repo');
    await makePipeline(repo, 'demo');

    const res = await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1');

    expect(res.pipelines).toHaveLength(1);
    const p = res.pipelines[0]!;
    expect(p.slug).toBe('demo');
    expect(p.phase).toBe('1');
    expect(p.slice).toBe('S-01');
    expect(p.slicesTotal).toBe(3);
    expect(p.blocked).toBe(false);
    expect(p.artefacts.map((a) => a.name).sort()).toEqual(['BRIEF.md', 'STATE.md']);
  });

  it('finds a pipeline that lives in a worktree outside the repo root', async () => {
    // The bug this whole feature exists around: conductor's own discovery
    // walked down from the repo root, so a worktree parked elsewhere on disk
    // reported as "no pipelines".
    const repo = join(root, 'repo');
    const outside = join(root, 'elsewhere', 'wt');
    await mkdir(repo, { recursive: true });
    await makePipeline(outside, 'parked');

    const res = await scanner({
      allowedDirs: [root],
      dirs: [repo],
      worktrees: { [repo]: [repo, outside] },
    }).scan('s1');

    expect(res.pipelines.map((p) => p.slug)).toEqual(['parked']);
  });

  it('refuses a worktree outside the allowlist and says so', async () => {
    const repo = join(root, 'repo');
    const outside = join(root, 'elsewhere', 'wt');
    await mkdir(repo, { recursive: true });
    await makePipeline(outside, 'parked');

    const res = await scanner({
      allowedDirs: [repo], // only the repo is granted
      dirs: [repo],
      worktrees: { [repo]: [repo, outside] },
    }).scan('s1');

    expect(res.pipelines).toEqual([]);
    expect(res.warnings.join(' ')).toContain('outside BRIDGE_ALLOWED_DIRS');
  });

  it('reports a warning when worktrees cannot be listed, and still scans the dir', async () => {
    const repo = join(root, 'repo');
    await makePipeline(repo, 'demo');

    const res = await scanner({ allowedDirs: [root], dirs: [repo], fail: true }).scan('s1');

    expect(res.pipelines.map((p) => p.slug)).toEqual(['demo']);
    expect(res.warnings.join(' ')).toContain('could not list worktrees');
  });

  it('flags a pipeline with a BLOCKED.md in the current slice', async () => {
    const repo = join(root, 'repo');
    const dir = await makePipeline(repo, 'demo');
    const sliceDir = join(dir, 'slices', 'S-01');
    await mkdir(sliceDir, { recursive: true });
    await writeFile(join(sliceDir, 'BLOCKED.md'), 'did not converge');
    await writeFile(join(sliceDir, 'SPEC.md'), 'rules');

    const res = await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1');

    const p = res.pipelines[0]!;
    expect(p.blocked).toBe(true);
    expect(p.slices[0]).toMatchObject({ id: 'S-01', blocked: true });
    expect(p.slices[0]!.artefacts.map((a) => a.name).sort()).toEqual(['BLOCKED.md', 'SPEC.md']);
  });

  it('reads a pre-slices pipeline without inventing slice fields', async () => {
    const repo = join(root, 'repo');
    await makePipeline(repo, 'old', '# STATE — old\nphase: 3\nstep: ticket\n');

    const res = await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1');

    const p = res.pipelines[0]!;
    expect(p.phase).toBe('3');
    expect(p.slice).toBeNull();
    expect(p.slicesTotal).toBeNull();
    expect(p.slices).toEqual([]);
  });

  it('parses tickets from the current slice', async () => {
    const repo = join(root, 'repo');
    const dir = await makePipeline(repo, 'demo');
    const tickets = join(dir, 'slices', 'S-01', 'tickets');
    await mkdir(tickets, { recursive: true });
    await writeFile(
      join(tickets, 'T-002.md'),
      '# T-002 — add the movement row\ntype: build\nstatus: open\ncovers: P-01, P-02\nblocked_by: T-001\n',
    );
    await writeFile(join(tickets, 'T-010.md'), '# T-010 — later\ntype: build\nstatus: done\n');
    await writeFile(join(tickets, 'notes.md'), 'not a ticket');

    const res = await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1');

    const t = res.pipelines[0]!.slices[0]!.tickets;
    // Natural order: T-002 before T-010, and `notes.md` is not a ticket.
    expect(t.map((x) => x.id)).toEqual(['T-002', 'T-010']);
    expect(t[0]).toMatchObject({
      title: 'add the movement row',
      type: 'build',
      status: 'open',
      covers: 'P-01, P-02',
      blockedBy: 'T-001',
    });
  });

  it('falls back to root tickets/ for a pipeline written before slices', async () => {
    const repo = join(root, 'repo');
    const dir = await makePipeline(repo, 'old', '# STATE — old\nphase: 3\nstep: ticket\n');
    await mkdir(join(dir, 'tickets'), { recursive: true });
    await writeFile(join(dir, 'tickets', 'T-001.md'), '# T-001 — first\ntype: build\nstatus: done\n');

    const res = await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1');

    expect(res.pipelines[0]!.tickets.map((t) => t.id)).toEqual(['T-001']);
    expect(res.pipelines[0]!.ticketsDir).toBe(join(dir, 'tickets'));
  });

  it('reads ticket fields from the header, not from the body', async () => {
    // The exact shape that broke on a live pipeline: a `build` ticket whose
    // Scope section describes a schema, reported as type `{ type: 'string' },`.
    const repo = join(root, 'repo');
    const dir = await makePipeline(repo, 'demo');
    const tickets = join(dir, 'slices', 'S-01', 'tickets');
    await mkdir(tickets, { recursive: true });
    await writeFile(
      join(tickets, 'T-004.md'),
      [
        '# T-004 — add the field',
        'type: build',
        'status: open',
        '',
        '## Scope',
        'The payload becomes:',
        '',
        '```ts',
        'const schema = {',
        "type: { type: 'string' },",
        '}',
        '```',
        '',
        '## Done criteria',
        'status: irrelevant prose',
        '',
      ].join('\n'),
    );

    const res = await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1');

    expect(res.pipelines[0]!.slices[0]!.tickets[0]).toMatchObject({
      id: 'T-004',
      title: 'add the field',
      type: 'build',
      status: 'open',
    });
  });

  it('tolerates a half-written ticket rather than dropping it', async () => {
    const repo = join(root, 'repo');
    const dir = await makePipeline(repo, 'demo');
    const tickets = join(dir, 'slices', 'S-01', 'tickets');
    await mkdir(tickets, { recursive: true });
    await writeFile(join(tickets, 'T-003.md'), 'type: decide\n');

    const res = await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1');

    expect(res.pipelines[0]!.slices[0]!.tickets[0]).toMatchObject({
      id: 'T-003',
      title: '',
      type: 'decide',
      status: null,
    });
  });

  it('reports no tickets before phase 2 has created any', async () => {
    const repo = join(root, 'repo');
    await makePipeline(repo, 'demo');

    const res = await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1');

    expect(res.pipelines[0]!.tickets).toEqual([]);
    expect(res.pipelines[0]!.ticketsDir).toBeNull();
  });

  it('does not descend into node_modules', async () => {
    const repo = join(root, 'repo');
    await makePipeline(join(repo, 'node_modules', 'pkg'), 'vendored');

    const res = await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1');

    expect(res.pipelines).toEqual([]);
  });

  it("ranks the session's own pipeline above a more recently touched sibling", async () => {
    // The defect this fixes: a session working in worktree A tied to worktree
    // B's pipeline purely because B was touched last. With many worktrees that
    // is the normal case, not an edge case.
    const repo = join(root, 'repo');
    const sibling = join(root, 'sibling-wt');
    const mine = await makePipeline(repo, 'mine');
    const theirs = await makePipeline(sibling, 'theirs');
    // Force the sibling strictly newer. Set explicitly rather than by sleeping
    // and rewriting: at coarse filesystem timestamp resolution the two could
    // land on the same mtime, and the test would pass while proving nothing.
    await utimes(join(mine, 'STATE.md'), new Date(1_000_000), new Date(1_000_000));
    await utimes(join(theirs, 'STATE.md'), new Date(9_000_000), new Date(9_000_000));

    const res = await scanner({
      allowedDirs: [root],
      dirs: [repo],
      worktrees: { [repo]: [repo, sibling] },
    }).scan('s1');

    expect(res.pipelines.map((p) => p.slug)).toEqual(['mine', 'theirs']);
    expect(res.pipelines[0]).toMatchObject({ slug: 'mine', inSessionDir: true });
    expect(res.pipelines[1]).toMatchObject({ slug: 'theirs', inSessionDir: false });
  });

  it('prefers the pipeline of the worktree the session is actually in', async () => {
    // A nested worktree's pipeline is inside the outer checkout's path, so
    // "under the session dir" cannot separate them — the session's own
    // worktree has to win even when the nested one was touched later.
    const repo = join(root, 'repo');
    const nested = join(repo, '.wt', 'nested');
    const mine = await makePipeline(repo, 'root-pipe');
    const theirs = await makePipeline(nested, 'nested-pipe');
    await utimes(join(mine, 'STATE.md'), new Date(1_000_000), new Date(1_000_000));
    await utimes(join(theirs, 'STATE.md'), new Date(9_000_000), new Date(9_000_000));

    const res = await scanner({
      allowedDirs: [root],
      dirs: [repo],
      worktrees: { [repo]: [repo, nested] },
    }).scan('s1');

    expect(res.pipelines.map((p) => p.slug)).toEqual(['root-pipe', 'nested-pipe']);
    // And the nested one is credited to the nested worktree, not the outer
    // checkout that also happens to contain its path.
    expect(res.pipelines[1]!.worktree).toBe(nested);
  });

  it('still surfaces a sibling worktree pipeline when the session dir has none', async () => {
    // Conductor installs the skill in the main checkout and keeps state in a
    // worktree, so this is a legitimate arrangement, not a mistake.
    const repo = join(root, 'repo');
    const sibling = join(root, 'sibling-wt');
    await mkdir(repo, { recursive: true });
    await makePipeline(sibling, 'theirs');

    const res = await scanner({
      allowedDirs: [root],
      dirs: [repo],
      worktrees: { [repo]: [repo, sibling] },
    }).scan('s1');

    expect(res.pipelines.map((p) => p.slug)).toEqual(['theirs']);
    expect(res.pipelines[0]!.inSessionDir).toBe(false);
    expect(res.pipelines[0]!.worktree).toBe(sibling);
  });

  it("warns when the session's OWN dir is outside the allowlist", async () => {
    // Previously silent, which was the worst outcome available: the session's
    // real pipeline is unreadable, an unrelated one is shown instead, and
    // nothing explains why.
    const repo = join(root, 'repo');
    const outside = join(root, 'outside-wt');
    await makePipeline(repo, 'allowed');
    await makePipeline(outside, 'mine');

    const res = await scanner({
      allowedDirs: [repo], // the session's own dir is NOT allowed
      dirs: [outside],
      worktrees: { [outside]: [repo, outside] },
    }).scan('s1');

    expect(res.warnings.join(' ')).toContain("this session's own directory is outside");
    expect(res.pipelines.map((p) => p.slug)).toEqual(['allowed']);
    expect(res.pipelines[0]!.inSessionDir).toBe(false);
  });

  describe('parallel slices', () => {
    async function makeSlice(dir: string, id: string, state?: string): Promise<string> {
      const sliceDir = join(dir, 'slices', id);
      await mkdir(sliceDir, { recursive: true });
      if (state !== undefined) await writeFile(join(sliceDir, 'STATE.md'), state);
      return sliceDir;
    }

    it('reports every slice, not only the one in front', async () => {
      const repo = join(root, 'repo');
      const dir = await makePipeline(repo, 'demo', PARALLEL_STATE);
      await makeSlice(dir, 'S-01b', '# STATE — S-01b\nphase: 3\nstep: ready\ntickets_done: 6\ntickets_total: 7\ncurrent_ticket: T-007\nattempt: 1\n');
      await makeSlice(dir, 'S-02', '# STATE — S-02\nphase: 1\nstep: plan\n');
      await makeSlice(dir, 'S-03', '# STATE — S-03\nphase: 1\nstep: aspects\n');

      const p = (await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1')).pipelines[0]!;

      expect(p.slices.map((s) => s.id)).toEqual(['S-01b', 'S-02', 'S-03']);
      expect(p.slices[0]).toMatchObject({
        phase: '3',
        step: 'ready',
        ticketsDone: 6,
        ticketsTotal: 7,
        currentTicket: 'T-007',
        attempt: 1,
        inFlight: true,
        foreground: true,
        status: 'active — T-007 parked',
        branch: 'conductor/demo-S-01b',
      });
      expect(p.slices[1]).toMatchObject({
        id: 'S-02',
        foreground: false,
        worktree: '.claude/worktrees/demo-S-02',
        status: 'dispatched',
      });
      expect(p.concurrency).toBe(3);
    });

    it("believes the slice's own STATE.md over the dispatch row", async () => {
      // The row is written by the root controller and goes stale between syncs;
      // the slice's own file is written by the worker doing the work.
      const repo = join(root, 'repo');
      const dir = await makePipeline(repo, 'demo', PARALLEL_STATE);
      await makeSlice(dir, 'S-02', '# STATE — S-02\nphase: 2\nstep: fog\n');

      const p = (await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1')).pipelines[0]!;

      expect(p.slices.find((s) => s.id === 'S-02')).toMatchObject({ phase: '2', step: 'fog' });
    });

    it('lists a slice that is dispatched but not yet scaffolded', async () => {
      // Between `git worktree add` and `init_slice.sh` there is no directory —
      // and that gap is exactly when you want to see the worker exists.
      const repo = join(root, 'repo');
      await makePipeline(repo, 'demo', PARALLEL_STATE);

      const p = (await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1')).pipelines[0]!;

      expect(p.slices.map((s) => s.id)).toEqual(['S-01b', 'S-02', 'S-03']);
      expect(p.slices[1]).toMatchObject({ id: 'S-02', phase: '1', step: 'aspects', state: {} });
      expect(p.slices[1]!.artefacts).toEqual([]);
    });

    it('treats a slice with no dispatch row as no longer in flight', async () => {
      // The row is removed when the slice merges, but its directory stays as
      // the record of the work — so a dir without a row reads as finished.
      const repo = join(root, 'repo');
      const dir = await makePipeline(repo, 'demo', PARALLEL_STATE);
      await makeSlice(dir, 'S-01a', '# STATE — S-01a\nphase: 4\nstep: done\n');
      await makeSlice(dir, 'S-02', '# STATE — S-02\nphase: 1\nstep: plan\n');

      const p = (await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1')).pipelines[0]!;

      // In flight first, finished after, so the workers are what you see.
      expect(p.slices.map((s) => s.id)).toEqual(['S-01b', 'S-02', 'S-03', 'S-01a']);
      expect(p.slices.find((s) => s.id === 'S-01a')).toMatchObject({
        inFlight: false,
        status: null,
      });
    });

    it('flags the blocked slice by name, and the pipeline with it', async () => {
      const repo = join(root, 'repo');
      const dir = await makePipeline(repo, 'demo', PARALLEL_STATE);
      await makeSlice(dir, 'S-02', '# STATE — S-02\nphase: 1\nstep: plan\n');
      const blocked = await makeSlice(dir, 'S-03', '# STATE — S-03\nphase: 2\nstep: fog\n');
      await writeFile(join(blocked, 'BLOCKED.md'), 'route review did not converge');

      const p = (await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1')).pipelines[0]!;

      expect(p.blocked).toBe(true);
      expect(p.slices.find((s) => s.id === 'S-03')!.blocked).toBe(true);
      expect(p.slices.find((s) => s.id === 'S-02')!.blocked).toBe(false);
    });

    it('keeps each slice with its own tickets and artefacts', async () => {
      const repo = join(root, 'repo');
      const dir = await makePipeline(repo, 'demo', PARALLEL_STATE);
      const one = await makeSlice(dir, 'S-01b', '# STATE — S-01b\nphase: 3\nstep: ready\n');
      await writeFile(join(one, 'SPEC.md'), 'the spec');
      await mkdir(join(one, 'tickets'), { recursive: true });
      await writeFile(join(one, 'tickets', 'T-001.md'), '# T-001 — first\ntype: build\nstatus: done\n');
      const two = await makeSlice(dir, 'S-02', '# STATE — S-02\nphase: 1\nstep: plan\n');
      await mkdir(join(two, 'tickets'), { recursive: true });
      await writeFile(join(two, 'tickets', 'T-009.md'), '# T-009 — other\ntype: build\nstatus: open\n');

      const p = (await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1')).pipelines[0]!;

      const s1 = p.slices.find((s) => s.id === 'S-01b')!;
      expect(s1.tickets.map((t) => t.id)).toEqual(['T-001']);
      expect(s1.ticketsDir).toBe(join(one, 'tickets'));
      expect(s1.artefacts.map((a) => a.name).sort()).toEqual(['SPEC.md', 'STATE.md']);
      expect(p.slices.find((s) => s.id === 'S-02')!.tickets.map((t) => t.id)).toEqual(['T-009']);
    });

    it('names the foreground slice as the pipeline’s current one', async () => {
      // Root STATE.md no longer carries `slice:` once a pipeline goes parallel,
      // so the badge's "where is it" has to come from the table.
      const repo = join(root, 'repo');
      await makePipeline(repo, 'demo', PARALLEL_STATE);

      const p = (await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1')).pipelines[0]!;

      expect(p.slice).toBe('S-01b');
      expect(p.phase).toBe('3');
      expect(p.step).toBe('ready');
    });
  });

  it('dedupes a pipeline reachable from two roots', async () => {
    const repo = join(root, 'repo');
    await makePipeline(repo, 'demo');

    const res = await scanner({
      allowedDirs: [root],
      dirs: [repo, repo],
      worktrees: { [repo]: [repo] },
    }).scan('s1');

    expect(res.pipelines).toHaveLength(1);
  });
});
