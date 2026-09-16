import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { ConductorScanner, parseStateFile } from '../conductor.js';

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
    expect(p.sliceArtefacts.map((a) => a.name).sort()).toEqual(['BLOCKED.md', 'SPEC.md']);
  });

  it('reads a pre-slices pipeline without inventing slice fields', async () => {
    const repo = join(root, 'repo');
    await makePipeline(repo, 'old', '# STATE — old\nphase: 3\nstep: ticket\n');

    const res = await scanner({ allowedDirs: [root], dirs: [repo] }).scan('s1');

    const p = res.pipelines[0]!;
    expect(p.phase).toBe('3');
    expect(p.slice).toBeNull();
    expect(p.slicesTotal).toBeNull();
    expect(p.sliceArtefacts).toEqual([]);
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

    const t = res.pipelines[0]!.tickets;
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

    expect(res.pipelines[0]!.tickets[0]).toMatchObject({
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

    expect(res.pipelines[0]!.tickets[0]).toMatchObject({
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
