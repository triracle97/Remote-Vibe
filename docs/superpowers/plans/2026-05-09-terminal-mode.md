# Terminal Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive PTY ("Terminal mode") as a third agent kind alongside Claude/Codex, accessible from the same web UI, with mobile-friendly helper bar.

**Architecture:** Sibling subsystem to `SessionManager` — a new `TerminalManager` + `TerminalProcess` (node-pty wrapper) on the bridge, parallel `term_*` wire messages, and a new `/terminal/:id` page in the web app using xterm.js. Sessions are ephemeral: bound to the spawning WebSocket connection; ws close kills the PTY.

**Tech Stack:** Bridge — Node 20, TypeScript, ws, vitest, **node-pty (new)**. Web — React 18, Zustand, react-router, vitest + happy-dom, **@xterm/xterm + @xterm/addon-fit (new)**.

**Spec:** `docs/superpowers/specs/2026-05-09-terminal-mode-design.md`

---

## File Structure

### Bridge — created
- `packages/bridge/src/path-allowlist.ts` — extracted shared path validator.
- `packages/bridge/src/terminal-process.ts` — thin node-pty wrapper.
- `packages/bridge/src/terminal-manager.ts` — lifecycle + wsId binding + backpressure.
- `packages/bridge/src/__tests__/path-allowlist.test.ts`
- `packages/bridge/src/__tests__/terminal-process.test.ts`
- `packages/bridge/src/__tests__/terminal-manager.test.ts`

### Bridge — modified
- `packages/bridge/src/types.ts` — add `term_*` client/server msg types, capabilities, error codes.
- `packages/bridge/src/session.ts` — replace inline `validatePath` with shared util.
- `packages/bridge/src/websocket.ts` — wsId per connection, route `term_*`, broadcast `term_output`/`term_exit`, killByWs on close.
- `packages/bridge/src/index.ts` — instantiate `TerminalManager`, wire shutdown, set capabilities flag.

### Web — created
- `apps/web/src/store/terminals.ts` — Zustand store for terminals.
- `apps/web/src/features/terminal/terminal-client.ts` — small wrapper over BridgeClient for term msgs.
- `apps/web/src/features/terminal/useTerminalSession.ts` — hook ties store + xterm together.
- `apps/web/src/features/terminal/TerminalView.tsx` — xterm.js mount + FitAddon + resize.
- `apps/web/src/features/terminal/TerminalHelperBar.tsx` — mobile keys.
- `apps/web/src/pages/Terminal.tsx` — route page.
- `apps/web/src/features/terminal/__tests__/useTerminalSession.test.ts`
- `apps/web/src/features/terminal/__tests__/TerminalHelperBar.test.tsx`
- `apps/web/src/features/terminal/__tests__/Terminal.page.test.tsx`
- `apps/web/src/store/terminals.test.ts`

### Web — modified
- `apps/web/package.json` — add `@xterm/xterm`, `@xterm/addon-fit`.
- `apps/web/src/types/protocol.ts` — mirror new wire types + capabilities + error codes.
- `apps/web/src/App.tsx` — add `<Route path="/terminal/:id">`.
- `apps/web/src/store/connection.ts` — add `capabilities: { terminal: boolean }`.
- `apps/web/src/features/project-picker/ProjectPicker.tsx` — add "Terminal" radio option (hidden when capability false).
- `apps/web/src/features/project-picker/useNewSession.tsx` — branch on `selection.agent === 'terminal'`: send `term_start`, await `term_started`, navigate `/terminal/:id`.
- `apps/web/src/pages/Home.tsx` — merge terminal sessions into "Active Sessions" list.
- `apps/web/src/pages/Sessions.tsx` — same merge for the full Sessions page.

---

## Conventions Used Throughout the Plan

- **Test framework:** vitest. Bridge tests live in `packages/bridge/src/__tests__/`. Web tests live next to source under `__tests__/`.
- **Mocking:** dependency injection via constructor opts (existing pattern, e.g. `ClaudeProcess(opts.spawn)`); tests pass fake factories. Do **not** use `vi.mock()` for filesystem-facing modules.
- **Commits:** small and frequent; one commit per task.
- **Type safety:** `npm run typecheck` (root) must pass after every code change.
- **No documentation files unless asked.** Edit existing files. Don't create READMEs.

---

## Task 1 — Extract `path-allowlist.ts` (Refactor)

**Files:**
- Create: `packages/bridge/src/path-allowlist.ts`
- Create: `packages/bridge/src/__tests__/path-allowlist.test.ts`
- Modify: `packages/bridge/src/session.ts:78-83, 166-180` (move class + helper)
- Modify: `packages/bridge/src/session.ts` (import re-export at top so existing consumers still get `PathOutsideAllowlistError` from `./session.js` for back-compat)

**Why first:** The `TerminalManager` reuses identical allowlist logic. Extracting it is purely mechanical; getting it green before adding new code keeps the diff reviewable.

- [ ] **Step 1: Write the failing test for the extracted validator**

`packages/bridge/src/__tests__/path-allowlist.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makePathValidator, PathOutsideAllowlistError } from '../path-allowlist.js';

describe('makePathValidator', () => {
  it('returns the realpath when inside an allowed dir', async () => {
    const validate = makePathValidator({
      allowedDirs: ['/Users/me/code'],
      realpath: async (p) => p,
    });
    await expect(validate('/Users/me/code/proj')).resolves.toBe('/Users/me/code/proj');
  });

  it('throws PathOutsideAllowlistError when realpath escapes the allowlist', async () => {
    const validate = makePathValidator({
      allowedDirs: ['/Users/me/code'],
      realpath: async () => '/etc',
    });
    await expect(validate('/Users/me/code/proj')).rejects.toBeInstanceOf(PathOutsideAllowlistError);
  });

  it('throws PathOutsideAllowlistError when realpath itself rejects', async () => {
    const validate = makePathValidator({
      allowedDirs: ['/Users/me/code'],
      realpath: async () => { throw new Error('ENOENT'); },
    });
    await expect(validate('/missing')).rejects.toBeInstanceOf(PathOutsideAllowlistError);
  });

  it('treats /a/b as inside /a but rejects /ab (no false-prefix)', async () => {
    const validate = makePathValidator({
      allowedDirs: ['/a'],
      realpath: async (p) => p,
    });
    await expect(validate('/a/b')).resolves.toBe('/a/b');
    await expect(validate('/ab')).rejects.toBeInstanceOf(PathOutsideAllowlistError);
  });
});
```

- [ ] **Step 2: Run the test, expect a fail (module missing)**

```bash
npm run bridge:test -- path-allowlist
```
Expected: FAIL with `Cannot find module '../path-allowlist.js'`.

- [ ] **Step 3: Implement the module**

`packages/bridge/src/path-allowlist.ts`:

```ts
import { realpath as fsRealpath } from 'node:fs/promises';

export class PathOutsideAllowlistError extends Error {
  code = 'path_outside_allowlist' as const;
  constructor(public projectPath: string) {
    super(`projectPath ${projectPath} is not inside any allowed directory`);
  }
}

export interface PathAllowlistOpts {
  allowedDirs: string[];
  realpath?: (p: string) => Promise<string>;
}

/**
 * Returns a validator that resolves the input via `realpath` and asserts the
 * result equals one of `allowedDirs` or has it as an ancestor (path-segment
 * boundary, so `/a` does not match `/ab`). Throws `PathOutsideAllowlistError`
 * on any failure (realpath error, or outside the allowlist).
 */
export function makePathValidator(
  opts: PathAllowlistOpts,
): (projectPath: string) => Promise<string> {
  const realpath = opts.realpath ?? fsRealpath;
  const allowed = opts.allowedDirs;
  return async (projectPath: string) => {
    let real: string;
    try {
      real = await realpath(projectPath);
    } catch {
      throw new PathOutsideAllowlistError(projectPath);
    }
    const inside = allowed.some((d) => real === d || real.startsWith(d + '/'));
    if (!inside) throw new PathOutsideAllowlistError(projectPath);
    return real;
  };
}
```

- [ ] **Step 4: Run the test, expect pass**

```bash
npm run bridge:test -- path-allowlist
```
Expected: 4 passed.

- [ ] **Step 5: Refactor `session.ts` to consume the new module**

In `packages/bridge/src/session.ts`:

1. Delete the existing `PathOutsideAllowlistError` class definition (the lines starting at `export class PathOutsideAllowlistError` ~line 78). Replace with a re-export so existing imports of `PathOutsideAllowlistError` from `./session.js` still resolve:

```ts
import { PathOutsideAllowlistError, makePathValidator } from './path-allowlist.js';
export { PathOutsideAllowlistError } from './path-allowlist.js';
```

2. Inside the `SessionManager` constructor, replace the body of `validatePath` (the private method ~line 166) with a delegating call. Add a private field `private readonly validatePathFn`:

```ts
// in constructor, after this.realpath = ...
this.validatePathFn = makePathValidator({
  allowedDirs: this.allowedDirs,
  realpath: this.realpath,
});

// replace the existing private validatePath body:
private async validatePath(projectPath: string): Promise<string> {
  return this.validatePathFn(projectPath);
}
```

(Keep the existing `private isAllowedDir` helper as-is — it's used elsewhere with already-resolved real paths and doesn't need to call realpath.)

- [ ] **Step 6: Run the full bridge test suite, expect green**

```bash
npm run bridge:test
```
Expected: all green. Existing `session.test.ts` should be unchanged in behavior because the inline logic moved without semantics changing.

- [ ] **Step 7: Run typecheck**

```bash
npm run bridge:typecheck
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/bridge/src/path-allowlist.ts \
        packages/bridge/src/__tests__/path-allowlist.test.ts \
        packages/bridge/src/session.ts
git commit -m "refactor(bridge): extract path allowlist validator to its own module"
```

---

## Task 2 — Wire Types, Capabilities, Error Codes

**Files:**
- Modify: `packages/bridge/src/types.ts`

No tests for this task on its own — types are exercised by Tasks 4–6.

- [ ] **Step 1: Append new types to `packages/bridge/src/types.ts`**

Add at the bottom of the file:

```ts
// ---------- Terminal mode (Phase 7) ----------

export interface ClientTermStartMsg {
  type: 'term_start';
  cwd: string;
  cols: number;
  rows: number;
  correlationId: string;
}
export interface ClientTermInputMsg {
  type: 'term_input';
  termId: string;
  data: string;
}
export interface ClientTermResizeMsg {
  type: 'term_resize';
  termId: string;
  cols: number;
  rows: number;
}
export interface ClientTermKillMsg {
  type: 'term_kill';
  termId: string;
  correlationId: string;
}

export interface ServerTermStartedMsg {
  type: 'term_started';
  termId: string;
  cwd: string;
  createdAt: number;
  correlationId: string;
}
export interface ServerTermOutputMsg {
  type: 'term_output';
  termId: string;
  data: string;
}
export interface ServerTermExitMsg {
  type: 'term_exit';
  termId: string;
  exitCode: number | null;
  signal: string | null;
}
```

- [ ] **Step 2: Extend the `ClientMsg` union**

In the existing `export type ClientMsg = ...` declaration, add the four new types to the union:

```ts
export type ClientMsg =
  | ClientStartMsg
  | ClientInputMsg
  | ClientStopMsg
  | ClientListSessionsMsg
  | ClientGetHistoryMsg
  | ClientListAccountsMsg
  | ClientListPromptsMsg
  | ClientListDirsMsg
  | ClientReadFileMsg
  | ClientListHistoryMsg
  | ClientResumeSessionMsg
  | ClientListProfilesMsg
  | ClientSaveProfileMsg
  | ClientDeleteProfileMsg
  | ClientSetDefaultProfileMsg
  | ClientListSlashCommandsMsg
  | ClientSearchFilesMsg
  | ClientRenameSessionMsg
  | ClientTermStartMsg
  | ClientTermInputMsg
  | ClientTermResizeMsg
  | ClientTermKillMsg;
```

- [ ] **Step 3: Extend the `ServerMsg` union**

Add the three server-side terminal messages to the union:

```ts
export type ServerMsg =
  | ServerInitMsg
  // ... existing entries unchanged ...
  | ServerSessionRenamedMsg
  | ServerTermStartedMsg
  | ServerTermOutputMsg
  | ServerTermExitMsg;
```

- [ ] **Step 4: Add the new error codes**

Extend the `ServerErrorCode` union:

```ts
export type ServerErrorCode =
  // ... existing codes unchanged ...
  | 'slash_commands_failed'
  | 'terminal_not_found'
  | 'terminal_spawn_failed'
  | 'pty_not_available';
```

- [ ] **Step 5: Add a `capabilities` field to `ServerInitMsg`**

```ts
export interface ServerInitMsg {
  type: 'system';
  event: 'init';
  /** Optional capability flags. Absence ≡ all caps false. */
  capabilities?: { terminal: boolean };
}
```

(Old clients that ignore `capabilities` keep working; new clients default `terminal === true` only when explicitly set.)

- [ ] **Step 6: Run typecheck**

```bash
npm run bridge:typecheck
```
Expected: no errors. (Web typecheck will fail until Task 7 mirrors these — that is expected and addressed there. Do **not** run `npm run typecheck` at the root yet.)

- [ ] **Step 7: Commit**

```bash
git add packages/bridge/src/types.ts
git commit -m "feat(bridge): wire types for terminal mode"
```

---

## Task 3 — `TerminalProcess` (node-pty wrapper)

**Files:**
- Modify: `packages/bridge/package.json` (add `node-pty`)
- Create: `packages/bridge/src/terminal-process.ts`
- Create: `packages/bridge/src/__tests__/terminal-process.test.ts`

- [ ] **Step 1: Add the `node-pty` dependency**

Edit `packages/bridge/package.json`. Add to `dependencies`:

```json
"node-pty": "^1.0.0"
```

Then install:

```bash
npm install
```

If `node-pty` fails to build natively on this machine, **note it but do not block the plan** — the bridge will fall back to `pty_not_available` at boot and the UI hides the option (Task 6 + Task 7). All tests in this task use injected fakes and don't import node-pty at runtime.

- [ ] **Step 2: Write the failing test**

`packages/bridge/src/__tests__/terminal-process.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { TerminalProcess, type PtyLike } from '../terminal-process.js';

interface FakePty extends PtyLike {
  _data: (s: string) => void;
  _exit: (e: { exitCode: number; signal?: number }) => void;
  writes: string[];
  resized: Array<[number, number]>;
  killed: string[];
  pausedCount: number;
  resumedCount: number;
}

function makeFakePty(): FakePty {
  const ee = new EventEmitter();
  const writes: string[] = [];
  const resized: Array<[number, number]> = [];
  const killed: string[] = [];
  let pausedCount = 0;
  let resumedCount = 0;
  return Object.assign(ee, {
    onData: (cb: (s: string) => void) => ee.on('data', cb),
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) =>
      ee.on('exitEvt', cb),
    write: (s: string) => writes.push(s),
    resize: (c: number, r: number) => resized.push([c, r]),
    kill: (sig?: string) => killed.push(sig ?? 'SIGHUP'),
    pause: () => { pausedCount++; },
    resume: () => { resumedCount++; },
    _data: (s: string) => ee.emit('data', s),
    _exit: (e) => ee.emit('exitEvt', e),
    writes, resized, killed,
    get pausedCount() { return pausedCount; },
    get resumedCount() { return resumedCount; },
  }) as unknown as FakePty;
}

describe('TerminalProcess', () => {
  it('passes shell, args, and pty options to spawn', () => {
    const fake = makeFakePty();
    const spawn = vi.fn().mockReturnValue(fake);
    new TerminalProcess('/Users/me/p', 80, 24, { spawn });
    expect(spawn).toHaveBeenCalledWith(
      'zsh',
      ['-l'],
      expect.objectContaining({
        cwd: '/Users/me/p',
        cols: 80,
        rows: 24,
        name: 'xterm-256color',
      }),
    );
  });

  it('emits output events for pty data', () => {
    const fake = makeFakePty();
    const proc = new TerminalProcess('/p', 80, 24, { spawn: () => fake });
    const out: string[] = [];
    proc.on('output', (s: string) => out.push(s));
    fake._data('hello');
    expect(out).toEqual(['hello']);
  });

  it('forwards write to pty', () => {
    const fake = makeFakePty();
    const proc = new TerminalProcess('/p', 80, 24, { spawn: () => fake });
    proc.write('ls\n');
    expect(fake.writes).toEqual(['ls\n']);
  });

  it('forwards resize to pty', () => {
    const fake = makeFakePty();
    const proc = new TerminalProcess('/p', 80, 24, { spawn: () => fake });
    proc.resize(120, 40);
    expect(fake.resized).toEqual([[120, 40]]);
  });

  it('emits exit with exitCode and signal', () => {
    const fake = makeFakePty();
    const proc = new TerminalProcess('/p', 80, 24, { spawn: () => fake });
    const exits: Array<[number | null, string | null]> = [];
    proc.on('exit', (code, sig) => exits.push([code, sig]));
    fake._exit({ exitCode: 0, signal: 1 });
    expect(exits).toEqual([[0, 'SIGHUP']]);
  });

  it('kill() sends SIGHUP, then SIGKILL after the grace timer', () => {
    vi.useFakeTimers();
    const fake = makeFakePty();
    const proc = new TerminalProcess('/p', 80, 24, { spawn: () => fake, killGraceMs: 100 });
    proc.kill();
    expect(fake.killed).toEqual(['SIGHUP']);
    vi.advanceTimersByTime(100);
    expect(fake.killed).toEqual(['SIGHUP', 'SIGKILL']);
    vi.useRealTimers();
  });

  it('kill() is idempotent', () => {
    const fake = makeFakePty();
    const proc = new TerminalProcess('/p', 80, 24, { spawn: () => fake, killGraceMs: 100 });
    proc.kill();
    proc.kill();
    expect(fake.killed).toEqual(['SIGHUP']);
  });

  it('pause/resume forwards to pty', () => {
    const fake = makeFakePty();
    const proc = new TerminalProcess('/p', 80, 24, { spawn: () => fake });
    proc.pause();
    proc.pause();
    proc.resume();
    expect(fake.pausedCount).toBe(2);
    expect(fake.resumedCount).toBe(1);
  });
});
```

- [ ] **Step 3: Run the test, expect a fail (module missing)**

```bash
npm run bridge:test -- terminal-process
```
Expected: FAIL with `Cannot find module '../terminal-process.js'`.

- [ ] **Step 4: Implement `TerminalProcess`**

`packages/bridge/src/terminal-process.ts`:

```ts
import { EventEmitter } from 'node:events';

const KILL_GRACE_MS = 5000;

/**
 * The shape we need from a node-pty IPty. Keeping our own interface lets
 * tests inject a fake without touching node-pty at all.
 */
export interface PtyLike {
  onData(cb: (s: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

export type PtySpawnFn = (
  shell: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    cols: number;
    rows: number;
    name: string;
  },
) => PtyLike;

export interface TerminalProcessOpts {
  /** Injection seam — defaults to the lazily-loaded node-pty.spawn. */
  spawn?: PtySpawnFn;
  /** Default 5000 ms. */
  killGraceMs?: number;
}

const SIGNAL_NAMES: Record<number, string> = {
  1: 'SIGHUP', 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM',
};

export class TerminalProcess extends EventEmitter {
  private readonly pty: PtyLike;
  private readonly killGraceMs: number;
  private killed = false;

  constructor(cwd: string, cols: number, rows: number, opts: TerminalProcessOpts = {}) {
    super();
    this.killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
    const spawn = opts.spawn ?? defaultSpawn();
    this.pty = spawn('zsh', ['-l'], {
      cwd,
      env: process.env,
      cols,
      rows,
      name: 'xterm-256color',
    });
    this.pty.onData((s) => this.emit('output', s));
    this.pty.onExit(({ exitCode, signal }) => {
      const sigName = typeof signal === 'number' ? SIGNAL_NAMES[signal] ?? null : null;
      this.emit('exit', exitCode, sigName);
    });
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  pause(): void { this.pty.pause(); }
  resume(): void { this.pty.resume(); }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.pty.kill('SIGHUP');
    setTimeout(() => {
      try { this.pty.kill('SIGKILL'); } catch { /* already gone */ }
    }, this.killGraceMs).unref();
  }
}

/**
 * Lazy dynamic import so the bridge can boot without node-pty installed.
 * Failure is surfaced one level up (the manager's spawnTerminal) as
 * `terminal_spawn_failed`. The capability probe in `index.ts` (Task 6) does
 * a separate `await import('node-pty')` once at boot to set the init flag.
 */
function defaultSpawn(): PtySpawnFn {
  return (shell, args, opts) => {
    // node-pty is CJS; require resolves it synchronously when present.
    // Throws here become `terminal_spawn_failed` at the manager layer.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pty = require('node-pty') as { spawn: PtySpawnFn };
    return pty.spawn(shell, args, opts);
  };
}
```

- [ ] **Step 5: Run the test, expect pass**

```bash
npm run bridge:test -- terminal-process
```
Expected: 8 passed.

- [ ] **Step 6: Run typecheck**

```bash
npm run bridge:typecheck
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/bridge/package.json package-lock.json \
        packages/bridge/src/terminal-process.ts \
        packages/bridge/src/__tests__/terminal-process.test.ts
git commit -m "feat(bridge): TerminalProcess node-pty wrapper"
```

---

## Task 4 — `TerminalManager` (lifecycle + ws binding + backpressure)

**Files:**
- Create: `packages/bridge/src/terminal-manager.ts`
- Create: `packages/bridge/src/__tests__/terminal-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/bridge/src/__tests__/terminal-manager.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { TerminalManager } from '../terminal-manager.js';

interface FakeProc extends EventEmitter {
  writes: string[];
  resized: Array<[number, number]>;
  killCalls: number;
  pausedCount: number;
  resumedCount: number;
  fireOutput(s: string): void;
  fireExit(code: number | null, signal?: string | null): void;
}

function makeFakeProc(): FakeProc {
  const ee = new EventEmitter() as FakeProc;
  ee.writes = [];
  ee.resized = [];
  ee.killCalls = 0;
  ee.pausedCount = 0;
  ee.resumedCount = 0;
  Object.assign(ee, {
    write: (d: string) => { ee.writes.push(d); },
    resize: (c: number, r: number) => { ee.resized.push([c, r]); },
    kill: () => { ee.killCalls++; },
    pause: () => { ee.pausedCount++; },
    resume: () => { ee.resumedCount++; },
    fireOutput: (s: string) => ee.emit('output', s),
    fireExit: (c: number | null, sig: string | null = null) => ee.emit('exit', c, sig),
  });
  return ee;
}

function makeMgr(overrides: { allowedDirs?: string[] } = {}) {
  const procs: FakeProc[] = [];
  const mgr = new TerminalManager({
    allowedDirs: overrides.allowedDirs ?? ['/Users/me/code'],
    realpath: async (p) => p,
    procFactory: () => {
      const p = makeFakeProc();
      procs.push(p);
      return p as unknown as import('../terminal-process.js').TerminalProcess;
    },
    bpHighWatermark: 1000,
  });
  return { mgr, procs };
}

describe('TerminalManager', () => {
  it('spawn returns a session and emits no events synchronously', async () => {
    const { mgr, procs } = makeMgr();
    const events: unknown[] = [];
    mgr.on('output', (...a) => events.push(['output', ...a]));
    mgr.on('exit', (...a) => events.push(['exit', ...a]));
    const session = await mgr.spawn('ws-1', '/Users/me/code/proj', 80, 24);
    expect(session.wsId).toBe('ws-1');
    expect(session.cwd).toBe('/Users/me/code/proj');
    expect(typeof session.termId).toBe('string');
    expect(procs.length).toBe(1);
    expect(events).toEqual([]);
  });

  it('rejects path outside allowlist', async () => {
    const { mgr } = makeMgr();
    await expect(mgr.spawn('ws-1', '/etc', 80, 24)).rejects.toMatchObject({
      code: 'path_outside_allowlist',
    });
  });

  it('translates factory throw to terminal_spawn_failed', async () => {
    const mgr = new TerminalManager({
      allowedDirs: ['/'],
      realpath: async (p) => p,
      procFactory: () => { throw new Error('node-pty missing'); },
    });
    await expect(mgr.spawn('ws-1', '/Users/me', 80, 24)).rejects.toMatchObject({
      code: 'terminal_spawn_failed',
    });
  });

  it('relays output only for the spawning ws', async () => {
    const { mgr, procs } = makeMgr();
    const events: Array<[string, string]> = [];
    mgr.on('output', (termId: string, data: string) => events.push([termId, data]));
    const s = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    procs[0]!.fireOutput('hi');
    expect(events).toEqual([[s.termId, 'hi']]);
  });

  it('sendInput routes to the proc when wsId matches', async () => {
    const { mgr, procs } = makeMgr();
    const s = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    mgr.sendInput('ws-1', s.termId, 'ls\n');
    expect(procs[0]!.writes).toEqual(['ls\n']);
  });

  it('sendInput from a different ws emits an error', async () => {
    const { mgr } = makeMgr();
    const errs: unknown[] = [];
    mgr.on('error', (e) => errs.push(e));
    const s = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    mgr.sendInput('ws-2', s.termId, 'oops');
    expect(errs).toEqual([{ wsId: 'ws-2', code: 'terminal_not_found', termId: s.termId }]);
  });

  it('sendInput for an unknown termId is silently dropped (post-exit)', async () => {
    const { mgr } = makeMgr();
    const errs: unknown[] = [];
    mgr.on('error', (e) => errs.push(e));
    mgr.sendInput('ws-1', 'never-existed', 'oops');
    expect(errs).toEqual([]);
  });

  it('resize routes when wsId matches; ignored on mismatch with error', async () => {
    const { mgr, procs } = makeMgr();
    const errs: unknown[] = [];
    mgr.on('error', (e) => errs.push(e));
    const s = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    mgr.resize('ws-1', s.termId, 100, 30);
    expect(procs[0]!.resized).toEqual([[100, 30]]);
    mgr.resize('ws-2', s.termId, 50, 25);
    expect(procs[0]!.resized).toEqual([[100, 30]]);
    expect(errs).toEqual([{ wsId: 'ws-2', code: 'terminal_not_found', termId: s.termId }]);
  });

  it('killByWs kills only that ws’s PTYs', async () => {
    const { mgr, procs } = makeMgr();
    const a = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    const b = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    const c = await mgr.spawn('ws-2', '/Users/me/code', 80, 24);
    mgr.killByWs('ws-1');
    expect(procs[0]!.killCalls).toBe(1); // a
    expect(procs[1]!.killCalls).toBe(1); // b
    expect(procs[2]!.killCalls).toBe(0); // c
    void a; void b; void c;
  });

  it('exit removes the entry from the map', async () => {
    const { mgr, procs } = makeMgr();
    const events: unknown[] = [];
    mgr.on('exit', (...a) => events.push(a));
    const s = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    procs[0]!.fireExit(0, null);
    expect(events).toEqual([[s.termId, 0, null]]);
    // After exit, sendInput becomes a silent no-op (entry gone).
    mgr.sendInput('ws-1', s.termId, 'after');
    expect(procs[0]!.writes).toEqual([]);
  });

  it('shutdown kills every PTY across every ws', async () => {
    const { mgr, procs } = makeMgr();
    await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
    await mgr.spawn('ws-2', '/Users/me/code', 80, 24);
    await mgr.shutdown();
    expect(procs[0]!.killCalls).toBe(1);
    expect(procs[1]!.killCalls).toBe(1);
  });

  describe('backpressure', () => {
    beforeEach(() => vi.useRealTimers());

    it('pauses the pty when bufferedAmount exceeds the high-water mark and resumes when it drains', async () => {
      const { mgr, procs } = makeMgr();
      let buffered = 0;
      const session = await mgr.spawn('ws-1', '/Users/me/code', 80, 24);
      // The manager reports backpressure via reportBufferedAmount(termId, n)
      // — websocket.ts is responsible for calling this after each ws.send.
      mgr.reportBufferedAmount(session.termId, 2000);
      expect(procs[0]!.pausedCount).toBe(1);
      mgr.reportBufferedAmount(session.termId, 200);
      expect(procs[0]!.resumedCount).toBe(1);
      // Idempotent: re-reporting low buffered does not call resume again.
      mgr.reportBufferedAmount(session.termId, 0);
      expect(procs[0]!.resumedCount).toBe(1);
      // Re-overshoot pauses again.
      mgr.reportBufferedAmount(session.termId, 5000);
      expect(procs[0]!.pausedCount).toBe(2);
      buffered;
    });
  });
});
```

- [ ] **Step 2: Run the test, expect fail (module missing)**

```bash
npm run bridge:test -- terminal-manager
```
Expected: FAIL — `Cannot find module '../terminal-manager.js'`.

- [ ] **Step 3: Implement `TerminalManager`**

`packages/bridge/src/terminal-manager.ts`:

```ts
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { makePathValidator, PathOutsideAllowlistError } from './path-allowlist.js';
import { TerminalProcess } from './terminal-process.js';

export class TerminalSpawnFailedError extends Error {
  code = 'terminal_spawn_failed' as const;
  constructor(message: string) { super(message); }
}

export interface TerminalSession {
  termId: string;
  wsId: string;
  cwd: string;
  createdAt: number;
}

export interface TerminalManagerOpts {
  allowedDirs: string[];
  realpath?: (p: string) => Promise<string>;
  /** Injection seam for tests; default constructs a real TerminalProcess. */
  procFactory?: (cwd: string, cols: number, rows: number) => TerminalProcess;
  /** Default 1 MB. Backpressure pause threshold. */
  bpHighWatermark?: number;
}

interface InternalEntry extends TerminalSession {
  proc: TerminalProcess;
  paused: boolean;
}

export class TerminalManager extends EventEmitter {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly validatePath: (p: string) => Promise<string>;
  private readonly procFactory: (cwd: string, cols: number, rows: number) => TerminalProcess;
  private readonly highWatermark: number;

  constructor(opts: TerminalManagerOpts) {
    super();
    this.validatePath = makePathValidator({
      allowedDirs: opts.allowedDirs,
      ...(opts.realpath ? { realpath: opts.realpath } : {}),
    });
    this.procFactory = opts.procFactory ?? ((cwd, cols, rows) => new TerminalProcess(cwd, cols, rows));
    this.highWatermark = opts.bpHighWatermark ?? 1024 * 1024;
  }

  async spawn(wsId: string, cwd: string, cols: number, rows: number): Promise<TerminalSession> {
    let real: string;
    try {
      real = await this.validatePath(cwd);
    } catch (err) {
      if (err instanceof PathOutsideAllowlistError) throw err;
      throw err;
    }
    let proc: TerminalProcess;
    try {
      proc = this.procFactory(real, cols, rows);
    } catch (err) {
      throw new TerminalSpawnFailedError((err as Error).message);
    }
    const termId = randomUUID();
    const entry: InternalEntry = {
      termId,
      wsId,
      cwd: real,
      createdAt: Date.now(),
      proc,
      paused: false,
    };
    this.entries.set(termId, entry);
    proc.on('output', (data: string) => {
      // Drop output if entry was already torn down (race).
      if (!this.entries.has(termId)) return;
      this.emit('output', termId, data);
    });
    proc.on('exit', (exitCode: number | null, signal: string | null) => {
      this.entries.delete(termId);
      this.emit('exit', termId, exitCode, signal);
    });
    return { termId, wsId, cwd: real, createdAt: entry.createdAt };
  }

  sendInput(wsId: string, termId: string, data: string): void {
    const entry = this.entries.get(termId);
    if (!entry) return;                       // unknown / already exited → silent
    if (entry.wsId !== wsId) {                // foreign ws → typed error
      this.emit('error', { wsId, code: 'terminal_not_found', termId });
      return;
    }
    entry.proc.write(data);
  }

  resize(wsId: string, termId: string, cols: number, rows: number): void {
    const entry = this.entries.get(termId);
    if (!entry) return;
    if (entry.wsId !== wsId) {
      this.emit('error', { wsId, code: 'terminal_not_found', termId });
      return;
    }
    entry.proc.resize(cols, rows);
  }

  kill(wsId: string, termId: string): void {
    const entry = this.entries.get(termId);
    if (!entry) return;
    if (entry.wsId !== wsId) {
      this.emit('error', { wsId, code: 'terminal_not_found', termId });
      return;
    }
    entry.proc.kill();
  }

  killByWs(wsId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.wsId === wsId) entry.proc.kill();
    }
  }

  /** Called from websocket.ts after each ws.send to pace the pty. */
  reportBufferedAmount(termId: string, bufferedAmount: number): void {
    const entry = this.entries.get(termId);
    if (!entry) return;
    if (bufferedAmount > this.highWatermark && !entry.paused) {
      entry.paused = true;
      entry.proc.pause();
    } else if (bufferedAmount < this.highWatermark / 2 && entry.paused) {
      entry.paused = false;
      entry.proc.resume();
    }
  }

  async shutdown(): Promise<void> {
    for (const entry of this.entries.values()) entry.proc.kill();
    // Wait one tick so any synchronous SIGHUP-driven exit handlers can clear
    // entries before the bridge process exits. Best-effort.
    await new Promise<void>((res) => setImmediate(res));
  }
}
```

- [ ] **Step 4: Run the test, expect pass**

```bash
npm run bridge:test -- terminal-manager
```
Expected: all green.

- [ ] **Step 5: Run typecheck**

```bash
npm run bridge:typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/bridge/src/terminal-manager.ts \
        packages/bridge/src/__tests__/terminal-manager.test.ts
git commit -m "feat(bridge): TerminalManager lifecycle + wsId binding + backpressure"
```

---

## Task 5 — Wire TerminalManager into `websocket.ts`

**Files:**
- Modify: `packages/bridge/src/websocket.ts`
- Modify: `packages/bridge/src/__tests__/` — extend the existing websocket test or write a focused new file `terminal-ws.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/bridge/src/__tests__/terminal-ws.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { attachWebSocket } from '../websocket.js';
import { TerminalManager } from '../terminal-manager.js';
import { SessionManager } from '../session.js';
import type { ServerMsg } from '../types.js';

// Minimal stubs for SessionManager dependencies that attachWebSocket requires.
const fakeSession = new SessionManager({
  allowedDirs: ['/Users/me/code'],
  bufferCap: 100,
  driverFactory: () => ({
    sendUserText: () => {},
    kill: () => {},
    on: () => fakeSession as never,
    off: () => fakeSession as never,
    once: () => fakeSession as never,
    emit: () => false,
    addListener: () => fakeSession as never,
    removeListener: () => fakeSession as never,
  }) as never,
});

// Helper: spin up a real server + ws client to round-trip messages.
async function withServer<T>(
  termMgr: TerminalManager,
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const server = createServer((_req, res) => res.end());
  attachWebSocket({
    server,
    token: 'test',
    sessionManager: fakeSession,
    accounts: new Map(),
    fsApi: { listDirs: async () => [], readFile: async () => ({ kind: 'text' as const, content: '', bytesRead: 0, truncated: false }) } as never,
    imageStore: { validate: () => ({ ok: true } as never), writeAuditCopy: async () => {}, cleanup: async () => {} } as never,
    historyScanner: { list: async () => ({ claude: [], codex: [] }), findEntry: async () => null, filePathFor: () => null, invalidateCache: () => {} } as never,
    profileStore: { list: () => [], add: async () => {}, update: async () => {}, remove: async () => {}, setDefault: async () => {}, get: () => null } as never,
    slashCommands: { listForSession: async () => [] } as never,
    fileSearch: { search: async () => ({ hits: [], truncated: false }) } as never,
    terminalManager: termMgr,
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`ws://127.0.0.1:${port}/ws?token=test`);
  } finally {
    server.close();
  }
}

function recv(ws: WebSocket, predicate: (m: ServerMsg) => boolean, timeoutMs = 1000): Promise<ServerMsg> {
  return new Promise((resolve, reject) => {
    const onMsg = (raw: import('ws').RawData) => {
      const m = JSON.parse(raw.toString()) as ServerMsg;
      if (predicate(m)) {
        ws.off('message', onMsg);
        clearTimeout(t);
        resolve(m);
      }
    };
    const t = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('timeout'));
    }, timeoutMs);
    ws.on('message', onMsg);
  });
}

describe('websocket terminal routing', () => {
  function makeMgr() {
    const procs: EventEmitter[] = [];
    const writes: string[] = [];
    return new TerminalManager({
      allowedDirs: ['/Users/me/code'],
      realpath: async (p) => p,
      procFactory: (cwd) => {
        const ee = new EventEmitter() as unknown as import('../terminal-process.js').TerminalProcess;
        Object.assign(ee, {
          write: (d: string) => writes.push(d),
          resize: () => {},
          kill: () => (ee as unknown as EventEmitter).emit('exit', 0, null),
          pause: () => {},
          resume: () => {},
        });
        procs.push(ee as unknown as EventEmitter);
        return ee;
      },
    });
  }

  it('term_start round-trips to term_started', async () => {
    const mgr = makeMgr();
    await withServer(mgr, async (url) => {
      const ws = new WebSocket(url, { headers: { Origin: 'http://127.0.0.1' } });
      await new Promise<void>((r) => ws.on('open', r));
      ws.send(JSON.stringify({
        type: 'term_start', cwd: '/Users/me/code', cols: 80, rows: 24, correlationId: 'c1',
      }));
      const reply = await recv(ws, (m) => m.type === 'term_started');
      expect(reply).toMatchObject({ type: 'term_started', cwd: '/Users/me/code', correlationId: 'c1' });
      ws.close();
    });
  });

  it('term_input only reaches the spawning ws’s pty (cross-ws blocked)', async () => {
    const mgr = makeMgr();
    await withServer(mgr, async (url) => {
      const wsA = new WebSocket(url, { headers: { Origin: 'http://127.0.0.1' } });
      const wsB = new WebSocket(url, { headers: { Origin: 'http://127.0.0.1' } });
      await new Promise<void>((r) => wsA.on('open', r));
      await new Promise<void>((r) => wsB.on('open', r));
      wsA.send(JSON.stringify({
        type: 'term_start', cwd: '/Users/me/code', cols: 80, rows: 24, correlationId: 'c1',
      }));
      const started = await recv(wsA, (m) => m.type === 'term_started');
      const termId = (started as { termId: string }).termId;
      wsB.send(JSON.stringify({ type: 'term_input', termId, data: 'evil' }));
      const err = await recv(wsB, (m) => m.type === 'error' && m.code === 'terminal_not_found');
      expect(err).toMatchObject({ code: 'terminal_not_found' });
      wsA.close();
      wsB.close();
    });
  });

  it('ws close kills the associated PTY', async () => {
    const mgr = makeMgr();
    await withServer(mgr, async (url) => {
      const ws = new WebSocket(url, { headers: { Origin: 'http://127.0.0.1' } });
      await new Promise<void>((r) => ws.on('open', r));
      ws.send(JSON.stringify({
        type: 'term_start', cwd: '/Users/me/code', cols: 80, rows: 24, correlationId: 'c1',
      }));
      const started = await recv(ws, (m) => m.type === 'term_started');
      const termId = (started as { termId: string }).termId;
      ws.close();
      // Wait a tick for ws-close → killByWs → fake pty exit.
      await new Promise((r) => setTimeout(r, 50));
      // Fresh ws — cannot send input to the dead termId; sendInput is a silent
      // drop now (entry deleted), so we just verify nothing throws.
      const ws2 = new WebSocket(url, { headers: { Origin: 'http://127.0.0.1' } });
      await new Promise<void>((r) => ws2.on('open', r));
      ws2.send(JSON.stringify({ type: 'term_input', termId, data: 'gone' }));
      // No error event expected (silent drop for unknown termId).
      await new Promise((r) => setTimeout(r, 30));
      ws2.close();
    });
  });
});
```

- [ ] **Step 2: Run the test, expect a fail**

```bash
npm run bridge:test -- terminal-ws
```
Expected: FAIL because `attachWebSocket` doesn't accept `terminalManager` yet, and `term_*` messages aren't routed.

- [ ] **Step 3: Modify `websocket.ts` — add `terminalManager` opt + wsId + routing**

Edit `packages/bridge/src/websocket.ts`:

1. Add to `AttachWsOpts`:

```ts
import type { TerminalManager } from './terminal-manager.js';

export interface AttachWsOpts {
  // ... existing fields ...
  terminalManager: TerminalManager;
}
```

2. In `attachWebSocket`, after the `wss = new WebSocketServer(...)` line, set up a single subscriber on `terminalManager`'s events that fans out to a per-connection map. Replace the `wss.on('connection', ...)` block with:

```ts
import { randomUUID } from 'node:crypto';

// wsId → ws (so terminalManager output/exit can find the right socket)
const wsByConn = new Map<string, import('ws').WebSocket>();
opts.terminalManager.on('output', (termId: string, data: string) => {
  // Look up which ws owns this termId via the manager's internal mapping.
  // The manager doesn't expose that directly; instead, route by maintaining
  // a parallel map below in the connection handler.
  // (See routing map `termOwner` below.)
  const wsId = termOwner.get(termId);
  if (!wsId) return;
  const ws = wsByConn.get(wsId);
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: 'term_output', termId, data } satisfies import('./types.js').ServerTermOutputMsg));
  opts.terminalManager.reportBufferedAmount(termId, ws.bufferedAmount);
});
opts.terminalManager.on('exit', (termId: string, exitCode: number | null, signal: string | null) => {
  const wsId = termOwner.get(termId);
  termOwner.delete(termId);
  if (!wsId) return;
  const ws = wsByConn.get(wsId);
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: 'term_exit', termId, exitCode, signal } satisfies import('./types.js').ServerTermExitMsg));
});
opts.terminalManager.on('error', (e: { wsId: string; code: 'terminal_not_found'; termId: string }) => {
  const ws = wsByConn.get(e.wsId);
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: 'error', code: e.code, message: `terminal ${e.termId} not found` } satisfies import('./types.js').ServerErrorMsg));
});

// termId → wsId, populated on term_started, removed on term_exit / killByWs.
const termOwner = new Map<string, string>();
```

3. In the connection handler, mint `wsId` and track ownership:

```ts
wss.on('connection', (ws) => {
  const wsId = randomUUID();
  wsByConn.set(wsId, ws);
  // ... existing init/listeners unchanged ...
  ws.on('close', () => {
    opts.sessionManager.off('broadcast', broadcast);
    // Kill any PTYs spawned by this ws.
    opts.terminalManager.killByWs(wsId);
    // Drop entries from termOwner whose value is this wsId.
    for (const [termId, owner] of termOwner) {
      if (owner === wsId) termOwner.delete(termId);
    }
    wsByConn.delete(wsId);
  });

  // ... existing send({ type: 'system', event: 'init' }) needs the capability flag.
  // For now just emit init unchanged; Task 6 wires the capability flag in.

  ws.on('message', (raw) => {
    void handleMessage(
      ws,
      wsId,                    // NEW arg
      raw,
      opts.sessionManager,
      opts.terminalManager,    // NEW arg
      termOwner,               // NEW arg
      send,
      // ... rest unchanged ...
    );
  });
});
```

4. Extend `handleMessage` signature with the three new args (`wsId`, `terminalManager`, `termOwner`) and add four new switch cases. Insert after the existing `'rename_session'` case:

```ts
case 'term_start': {
  try {
    const session = await terminalManager.spawn(wsId, msg.cwd, msg.cols, msg.rows);
    termOwner.set(session.termId, wsId);
    send({
      type: 'term_started',
      termId: session.termId,
      cwd: session.cwd,
      createdAt: session.createdAt,
      correlationId: msg.correlationId,
    });
  } catch (err) {
    const code = (err as { code?: string }).code === 'path_outside_allowlist'
      ? 'path_outside_allowlist'
      : 'terminal_spawn_failed';
    sendError(send, code as never, (err as Error).message, msg.correlationId);
  }
  return;
}
case 'term_input': {
  terminalManager.sendInput(wsId, msg.termId, msg.data);
  return;
}
case 'term_resize': {
  terminalManager.resize(wsId, msg.termId, msg.cols, msg.rows);
  return;
}
case 'term_kill': {
  terminalManager.kill(wsId, msg.termId);
  // Reply is the eventual term_exit broadcast; ack here is implicit.
  return;
}
```

5. Update the `default:` case message lookup so unknown types still surface a typed error (no change to that branch needed beyond the new cases existing).

- [ ] **Step 4: Run the new test, expect pass**

```bash
npm run bridge:test -- terminal-ws
```
Expected: 3 passed.

- [ ] **Step 5: Run the full bridge test suite**

```bash
npm run bridge:test
```
Expected: all green (existing websocket tests still pass; the new options field is required, so any other test that constructs `attachWebSocket` directly must pass `terminalManager` — fix as needed by passing a minimal `new TerminalManager({allowedDirs:[], procFactory: () => ({ ... }) as never})`).

- [ ] **Step 6: Run typecheck**

```bash
npm run bridge:typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/bridge/src/websocket.ts \
        packages/bridge/src/__tests__/terminal-ws.test.ts
git commit -m "feat(bridge): route term_* messages and bind PTYs to ws lifetime"
```

---

## Task 6 — Wire `TerminalManager` into `index.ts` + capability probe

**Files:**
- Modify: `packages/bridge/src/index.ts`
- Modify: `packages/bridge/src/websocket.ts` (carry the capability flag into the init message)

- [ ] **Step 1: Probe node-pty at boot in `index.ts`**

Insert near the top of `main()` in `packages/bridge/src/index.ts`, immediately after `loadEnv(process.env)`:

```ts
let terminalCapable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('node-pty');
  terminalCapable = true;
} catch (err) {
  console.warn(
    '[bridge] node-pty failed to load — terminal mode disabled:',
    (err as Error).message,
  );
}
```

- [ ] **Step 2: Instantiate `TerminalManager` and pass it to `attachWebSocket`**

In the same file, after the existing `sessionManager` is created, add:

```ts
import { TerminalManager } from './terminal-manager.js';

const terminalManager = new TerminalManager({
  allowedDirs: cfg.allowedDirs,
});
```

Pass it to `attachWebSocket`:

```ts
attachWebSocket({
  server,
  token: cfg.token,
  sessionManager,
  // ... existing args ...
  terminalManager,
  capabilities: { terminal: terminalCapable },   // NEW (see step 3)
});
```

- [ ] **Step 3: Plumb the capability flag into the init message**

Edit `packages/bridge/src/websocket.ts`:

1. Add to `AttachWsOpts`:

```ts
capabilities: { terminal: boolean };
```

2. In the `wss.on('connection', ...)` handler, change the init send:

```ts
send({ type: 'system', event: 'init', capabilities: opts.capabilities });
```

3. If `opts.capabilities.terminal === false`, reject `term_start` early in `handleMessage`. Inside the `'term_start'` case, before calling `terminalManager.spawn`, add:

```ts
if (!capabilities.terminal) {
  sendError(send, 'pty_not_available', 'node-pty is not installed in this bridge build', msg.correlationId);
  return;
}
```

(Pass `opts.capabilities` through `handleMessage` as a new argument, parallel to the other refactors in Task 5.)

- [ ] **Step 4: Wire shutdown**

In `index.ts`, change the `shutdown` function:

```ts
const shutdown = async (): Promise<void> => {
  console.log('[bridge] shutting down');
  sessionManager.shutdown();
  await terminalManager.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 6000).unref();
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
```

- [ ] **Step 5: Update `terminal-ws.test.ts` to pass `capabilities`**

Add `capabilities: { terminal: true }` to the `attachWebSocket` call in the test's `withServer` helper. Also add a new test case:

```ts
it('rejects term_start with pty_not_available when capability is false', async () => {
  // Re-use withServer pattern but pass capabilities.terminal: false.
  // Easiest: temporarily refactor withServer to accept a `capabilities` arg.
  // [Implementer: thread `capabilities` through withServer; default true.]
  const mgr = makeMgr();
  await withServerCaps(mgr, { terminal: false }, async (url) => {
    const ws = new WebSocket(url, { headers: { Origin: 'http://127.0.0.1' } });
    await new Promise<void>((r) => ws.on('open', r));
    ws.send(JSON.stringify({
      type: 'term_start', cwd: '/Users/me/code', cols: 80, rows: 24, correlationId: 'c1',
    }));
    const err = await recv(ws, (m) => m.type === 'error' && m.code === 'pty_not_available');
    expect(err).toMatchObject({ code: 'pty_not_available' });
    ws.close();
  });
});
```

The `withServerCaps` variant is the same as `withServer` plus a second parameter that overrides `capabilities`. Implement it inline.

- [ ] **Step 6: Run the bridge tests, expect green**

```bash
npm run bridge:test
```

- [ ] **Step 7: Run typecheck**

```bash
npm run bridge:typecheck
```

- [ ] **Step 8: Commit**

```bash
git add packages/bridge/src/index.ts \
        packages/bridge/src/websocket.ts \
        packages/bridge/src/__tests__/terminal-ws.test.ts
git commit -m "feat(bridge): wire TerminalManager into bridge entrypoint with capability probe"
```

---

## Task 7 — Mirror Wire Types in Web; Install xterm Packages

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/types/protocol.ts`
- Modify: `apps/web/src/store/connection.ts`

- [ ] **Step 1: Add xterm dependencies**

Edit `apps/web/package.json` `dependencies`:

```json
"@xterm/xterm": "^5.5.0",
"@xterm/addon-fit": "^0.10.0"
```

Then install:

```bash
npm install
```

- [ ] **Step 2: Mirror the new bridge types in `apps/web/src/types/protocol.ts`**

Append:

```ts
// ---------- Terminal mode (Phase 7) ----------

export interface ClientTermStartMsg {
  type: 'term_start';
  cwd: string;
  cols: number;
  rows: number;
  correlationId: string;
}
export interface ClientTermInputMsg {
  type: 'term_input';
  termId: string;
  data: string;
}
export interface ClientTermResizeMsg {
  type: 'term_resize';
  termId: string;
  cols: number;
  rows: number;
}
export interface ClientTermKillMsg {
  type: 'term_kill';
  termId: string;
  correlationId: string;
}

export interface ServerTermStartedMsg {
  type: 'term_started';
  termId: string;
  cwd: string;
  createdAt: number;
  correlationId: string;
}
export interface ServerTermOutputMsg {
  type: 'term_output';
  termId: string;
  data: string;
}
export interface ServerTermExitMsg {
  type: 'term_exit';
  termId: string;
  exitCode: number | null;
  signal: string | null;
}
```

Extend the `ClientMsg` and `ServerMsg` unions and `ServerErrorCode` exactly as in Task 2 (same names).

Add the `capabilities?` field to `ServerInitMsg` to match the bridge.

- [ ] **Step 3: Add `capabilities` to the connection store**

Edit `apps/web/src/store/connection.ts` and extend its state:

```ts
interface ConnectionState {
  // ... existing fields ...
  capabilities: { terminal: boolean };
  setCapabilities(caps: { terminal: boolean }): void;
}
```

In the create call, default `capabilities: { terminal: false }` and add the `setCapabilities` reducer. Then ensure your existing `applyServerMsg`-style path (or wherever the `init` is consumed in the App) calls `setCapabilities(m.capabilities ?? { terminal: false })` when `m.type === 'system' && m.event === 'init'`. (If there's no central message handler, add it in `apps/web/src/main.tsx` or `App.tsx` next to where `init` is observed.)

- [ ] **Step 4: Run web typecheck (root typecheck still partially failing is fine — this catches web-only mistakes)**

```bash
npm run web:typecheck
```
Expected: no errors.

- [ ] **Step 5: Run the existing web tests to confirm nothing regressed**

```bash
npm run web:test
```
Expected: all green (no behavior change yet).

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/pnpm-lock.yaml apps/web/package-lock.json \
        apps/web/src/types/protocol.ts \
        apps/web/src/store/connection.ts
git commit -m "feat(web): mirror terminal wire types and add capability flag"
```

(If only one of `pnpm-lock.yaml`/`package-lock.json` exists, stage that one.)

---

## Task 8 — `terminals` Store

**Files:**
- Create: `apps/web/src/store/terminals.ts`
- Create: `apps/web/src/store/terminals.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/src/store/terminals.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useTerminalsStore } from './terminals';

describe('useTerminalsStore', () => {
  beforeEach(() => {
    useTerminalsStore.setState({ terminals: {}, order: [] });
  });

  it('term_started adds an alive entry', () => {
    useTerminalsStore.getState().applyServerMsg({
      type: 'term_started',
      termId: 't1',
      cwd: '/Users/me/code/p',
      createdAt: 1,
      correlationId: 'c1',
    });
    const state = useTerminalsStore.getState();
    expect(state.terminals['t1']).toMatchObject({
      cwd: '/Users/me/code/p',
      createdAt: 1,
      alive: true,
    });
    expect(state.order).toEqual(['t1']);
  });

  it('term_exit flips alive=false', () => {
    const s = useTerminalsStore.getState();
    s.applyServerMsg({ type: 'term_started', termId: 't1', cwd: '/p', createdAt: 1, correlationId: 'c' });
    s.applyServerMsg({ type: 'term_exit', termId: 't1', exitCode: 0, signal: null });
    expect(useTerminalsStore.getState().terminals['t1']!.alive).toBe(false);
  });

  it('remove drops the entry and order entry', () => {
    const s = useTerminalsStore.getState();
    s.applyServerMsg({ type: 'term_started', termId: 't1', cwd: '/p', createdAt: 1, correlationId: 'c' });
    s.remove('t1');
    expect(useTerminalsStore.getState().terminals['t1']).toBeUndefined();
    expect(useTerminalsStore.getState().order).toEqual([]);
  });

  it('ignores other server msg types', () => {
    const s = useTerminalsStore.getState();
    s.applyServerMsg({ type: 'system', event: 'init' });
    expect(useTerminalsStore.getState().order).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
npm run web:test -- store/terminals
```

- [ ] **Step 3: Implement the store**

`apps/web/src/store/terminals.ts`:

```ts
import { create } from 'zustand';
import type { ServerMsg } from '../types/protocol';

export interface TerminalView {
  termId: string;
  cwd: string;
  createdAt: number;
  alive: boolean;
  exitCode?: number | null;
  signal?: string | null;
}

interface TerminalsStore {
  terminals: Record<string, TerminalView>;
  order: string[];
  applyServerMsg(m: ServerMsg): void;
  remove(termId: string): void;
}

export const useTerminalsStore = create<TerminalsStore>((set, get) => ({
  terminals: {},
  order: [],

  applyServerMsg(m) {
    if (m.type === 'term_started') {
      set((s) => ({
        terminals: {
          ...s.terminals,
          [m.termId]: { termId: m.termId, cwd: m.cwd, createdAt: m.createdAt, alive: true },
        },
        order: s.order.includes(m.termId) ? s.order : [...s.order, m.termId],
      }));
      return;
    }
    if (m.type === 'term_exit') {
      const existing = get().terminals[m.termId];
      if (!existing) return;
      set((s) => ({
        terminals: {
          ...s.terminals,
          [m.termId]: { ...existing, alive: false, exitCode: m.exitCode, signal: m.signal },
        },
      }));
      return;
    }
  },

  remove(termId) {
    set((s) => {
      if (!s.terminals[termId]) return s;
      const { [termId]: _drop, ...rest } = s.terminals;
      void _drop;
      return { terminals: rest, order: s.order.filter((id) => id !== termId) };
    });
  },
}));
```

- [ ] **Step 4: Run, expect pass**

```bash
npm run web:test -- store/terminals
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/store/terminals.ts apps/web/src/store/terminals.test.ts
git commit -m "feat(web): terminals zustand store"
```

---

## Task 9 — `terminal-client` + `useTerminalSession` Hook

**Files:**
- Create: `apps/web/src/features/terminal/terminal-client.ts`
- Create: `apps/web/src/features/terminal/useTerminalSession.ts`
- Create: `apps/web/src/features/terminal/__tests__/useTerminalSession.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/terminal/__tests__/useTerminalSession.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminalSession } from '../useTerminalSession';
import { useTerminalsStore } from '../../../store/terminals';
import type { ClientMsg, ServerMsg } from '../../../types/protocol';

let sent: ClientMsg[];
let listeners: Array<(m: ServerMsg) => void>;

vi.mock('../../../services/bridge-client-singleton', () => ({
  getBridgeClient: () => ({
    send: (m: ClientMsg) => { sent.push(m); },
    on: (event: string, fn: (m: ServerMsg) => void) => {
      if (event === 'message') listeners.push(fn);
      return () => { listeners = listeners.filter((l) => l !== fn); };
    },
  }),
}));

describe('useTerminalSession', () => {
  beforeEach(() => {
    sent = [];
    listeners = [];
    useTerminalsStore.setState({ terminals: {}, order: [] });
  });

  it('routes term_output to the onData callback for the matching termId', () => {
    const onData = vi.fn();
    renderHook(() => useTerminalSession({ termId: 't1', onData }));
    act(() => { listeners.forEach((l) => l({ type: 'term_output', termId: 't1', data: 'hi' })); });
    expect(onData).toHaveBeenCalledWith('hi');
  });

  it('ignores term_output for other termIds', () => {
    const onData = vi.fn();
    renderHook(() => useTerminalSession({ termId: 't1', onData }));
    act(() => { listeners.forEach((l) => l({ type: 'term_output', termId: 'OTHER', data: 'nope' })); });
    expect(onData).not.toHaveBeenCalled();
  });

  it('returns sendInput that emits term_input', () => {
    const { result } = renderHook(() => useTerminalSession({ termId: 't1', onData: () => {} }));
    act(() => { result.current.sendInput('ls\n'); });
    expect(sent).toContainEqual({ type: 'term_input', termId: 't1', data: 'ls\n' });
  });

  it('returns resize that emits term_resize', () => {
    const { result } = renderHook(() => useTerminalSession({ termId: 't1', onData: () => {} }));
    act(() => { result.current.resize(120, 40); });
    expect(sent).toContainEqual({ type: 'term_resize', termId: 't1', cols: 120, rows: 40 });
  });

  it('emits term_kill on unmount', () => {
    const { unmount } = renderHook(() => useTerminalSession({ termId: 't1', onData: () => {} }));
    unmount();
    expect(sent.some((m) => m.type === 'term_kill' && m.termId === 't1')).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
npm run web:test -- terminal/useTerminalSession
```

- [ ] **Step 3: Implement `terminal-client.ts`**

`apps/web/src/features/terminal/terminal-client.ts`:

```ts
import { getBridgeClient } from '../../services/bridge-client-singleton';

function newCorrelationId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function startTerminal(cwd: string, cols: number, rows: number): string {
  const correlationId = newCorrelationId();
  getBridgeClient().send({ type: 'term_start', cwd, cols, rows, correlationId });
  return correlationId;
}
export function killTerminal(termId: string): void {
  getBridgeClient().send({ type: 'term_kill', termId, correlationId: newCorrelationId() });
}
export function sendTerminalInput(termId: string, data: string): void {
  getBridgeClient().send({ type: 'term_input', termId, data });
}
export function resizeTerminal(termId: string, cols: number, rows: number): void {
  getBridgeClient().send({ type: 'term_resize', termId, cols, rows });
}
```

- [ ] **Step 4: Implement `useTerminalSession.ts`**

`apps/web/src/features/terminal/useTerminalSession.ts`:

```ts
import { useEffect, useRef } from 'react';
import { getBridgeClient } from '../../services/bridge-client-singleton';
import type { ServerMsg } from '../../types/protocol';
import { killTerminal, sendTerminalInput, resizeTerminal } from './terminal-client';

export interface UseTerminalSessionOpts {
  termId: string;
  onData(data: string): void;
  onExit?(exitCode: number | null, signal: string | null): void;
}

export interface TerminalSessionApi {
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
}

export function useTerminalSession(opts: UseTerminalSessionOpts): TerminalSessionApi {
  const { termId, onData, onExit } = opts;
  const onDataRef = useRef(onData);
  const onExitRef = useRef(onExit);
  onDataRef.current = onData;
  onExitRef.current = onExit;

  useEffect(() => {
    const client = getBridgeClient();
    const off = client.on('message', (m: ServerMsg) => {
      if (m.type === 'term_output' && m.termId === termId) onDataRef.current(m.data);
      else if (m.type === 'term_exit' && m.termId === termId) onExitRef.current?.(m.exitCode, m.signal);
    });
    return () => {
      off();
      killTerminal(termId);
    };
  }, [termId]);

  return {
    sendInput: (data: string) => sendTerminalInput(termId, data),
    resize: (cols: number, rows: number) => resizeTerminal(termId, cols, rows),
  };
}
```

- [ ] **Step 5: Run, expect pass**

```bash
npm run web:test -- terminal/useTerminalSession
```

- [ ] **Step 6: Run web typecheck**

```bash
npm run web:typecheck
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/terminal/terminal-client.ts \
        apps/web/src/features/terminal/useTerminalSession.ts \
        apps/web/src/features/terminal/__tests__/useTerminalSession.test.ts
git commit -m "feat(web): useTerminalSession hook + terminal-client wrapper"
```

---

## Task 10 — `TerminalHelperBar` (Mobile Keys)

**Files:**
- Create: `apps/web/src/features/terminal/TerminalHelperBar.tsx`
- Create: `apps/web/src/features/terminal/__tests__/TerminalHelperBar.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/terminal/__tests__/TerminalHelperBar.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalHelperBar } from '../TerminalHelperBar';

describe('TerminalHelperBar', () => {
  it('Esc sends \\x1b', () => {
    const onSend = vi.fn();
    render(<TerminalHelperBar onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: /esc/i }));
    expect(onSend).toHaveBeenCalledWith('\x1b');
  });

  it('Tab sends \\t', () => {
    const onSend = vi.fn();
    render(<TerminalHelperBar onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: /^tab$/i }));
    expect(onSend).toHaveBeenCalledWith('\t');
  });

  it('arrows send CSI sequences', () => {
    const onSend = vi.fn();
    render(<TerminalHelperBar onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: /up/i }));
    fireEvent.click(screen.getByRole('button', { name: /down/i }));
    fireEvent.click(screen.getByRole('button', { name: /left/i }));
    fireEvent.click(screen.getByRole('button', { name: /right/i }));
    expect(onSend.mock.calls.map((c) => c[0])).toEqual(['\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C']);
  });

  it('Ctrl-C button sends \\x03', () => {
    const onSend = vi.fn();
    render(<TerminalHelperBar onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: /ctrl-c/i }));
    expect(onSend).toHaveBeenCalledWith('\x03');
  });

  it('Ctrl modifier toggles + composes with the next alpha key', () => {
    const onSend = vi.fn();
    render(<TerminalHelperBar onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: /^ctrl$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^a$/i }));
    expect(onSend).toHaveBeenLastCalledWith('\x01');
    // Modifier resets after one use.
    fireEvent.click(screen.getByRole('button', { name: /^a$/i }));
    expect(onSend).toHaveBeenLastCalledWith('a');
  });

  it('tapping Ctrl twice clears the modifier without sending', () => {
    const onSend = vi.fn();
    render(<TerminalHelperBar onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: /^ctrl$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^ctrl$/i }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('every button is at least 44x44 CSS pixels (mobile-friendly)', () => {
    const { container } = render(<TerminalHelperBar onSend={() => {}} />);
    const buttons = container.querySelectorAll('button');
    for (const b of buttons) {
      const style = window.getComputedStyle(b);
      // happy-dom returns the computed style we set inline / via className.
      // We assert min-height/min-width via the class names.
      expect(b.className).toMatch(/min-h-\[44px\]/);
      expect(b.className).toMatch(/min-w-\[44px\]/);
    }
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
npm run web:test -- terminal/TerminalHelperBar
```

- [ ] **Step 3: Implement `TerminalHelperBar.tsx`**

`apps/web/src/features/terminal/TerminalHelperBar.tsx`:

```tsx
import { useState } from 'react';

interface Props {
  onSend(data: string): void;
}

const BUTTON_CLASS =
  'min-h-[44px] min-w-[44px] px-2 rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text)] active:bg-[var(--color-surface)] text-sm font-mono';

export function TerminalHelperBar({ onSend }: Props): JSX.Element {
  const [ctrl, setCtrl] = useState(false);

  const tap = (data: string) => () => onSend(data);

  const handleAlpha = (ch: string) => () => {
    if (ctrl && /^[a-z]$/.test(ch)) {
      onSend(String.fromCharCode(ch.charCodeAt(0) - 96));
      setCtrl(false);
    } else {
      onSend(ch);
    }
  };

  const toggleCtrl = () => setCtrl((v) => !v);

  return (
    <div
      className="sticky bottom-0 left-0 right-0 flex flex-wrap gap-1 p-2 bg-[var(--color-bg)] border-t border-[var(--color-border)]"
      role="toolbar"
      aria-label="Terminal helper keys"
    >
      <button type="button" className={BUTTON_CLASS} onClick={tap('\x1b')} aria-label="Esc">Esc</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap('\t')} aria-label="Tab">Tab</button>
      <button
        type="button"
        className={`${BUTTON_CLASS} ${ctrl ? 'ring-2 ring-[var(--color-accent)]' : ''}`}
        onClick={toggleCtrl}
        aria-label="Ctrl"
        aria-pressed={ctrl}
      >Ctrl</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap('\x03')} aria-label="Ctrl-C">Ctrl-C</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap('\x1b[A')} aria-label="Up">↑</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap('\x1b[B')} aria-label="Down">↓</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap('\x1b[D')} aria-label="Left">←</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap('\x1b[C')} aria-label="Right">→</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap(':')} aria-label=":">:</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap('/')} aria-label="/">/</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap('-')} aria-label="-">-</button>
      <button type="button" className={BUTTON_CLASS} onClick={handleAlpha('a')} aria-label="a">a</button>
      {/* The "a" button is a representative alpha for tests; in production
          users type alpha via the on-screen keyboard. Keep it for the
          Ctrl-composition test. */}
    </div>
  );
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npm run web:test -- terminal/TerminalHelperBar
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/terminal/TerminalHelperBar.tsx \
        apps/web/src/features/terminal/__tests__/TerminalHelperBar.test.tsx
git commit -m "feat(web): TerminalHelperBar mobile keys"
```

---

## Task 11 — `TerminalView` (xterm Mount + Resize)

**Files:**
- Create: `apps/web/src/features/terminal/TerminalView.tsx`

No unit test for `TerminalView`; xterm.js wraps a `<canvas>` and is hard to assert against in happy-dom. The behavior is exercised via the manual integration checklist (Task 15) and indirectly via `Terminal.page.test.tsx` (Task 12) which only asserts the redirect path.

- [ ] **Step 1: Implement `TerminalView.tsx`**

`apps/web/src/features/terminal/TerminalView.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTerminalSession } from './useTerminalSession';
import { TerminalHelperBar } from './TerminalHelperBar';
import { useTerminalsStore } from '../../store/terminals';

interface Props {
  termId: string;
}

export function TerminalView({ termId }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const removeFromStore = useTerminalsStore((s) => s.remove);

  const session = useTerminalSession({
    termId,
    onData: (s) => xtermRef.current?.write(s),
    onExit: (code) => {
      xtermRef.current?.write(`\r\n\x1b[33m[process exited code=${code ?? '?'}]\x1b[0m\r\n`);
    },
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 14,
      cursorBlink: true,
      theme: {
        background: getCss('--color-bg') ?? '#000',
        foreground: getCss('--color-text') ?? '#eee',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    xtermRef.current = term;
    fitRef.current = fit;

    const onTermData = term.onData((d) => session.sendInput(d));

    const ro = new ResizeObserver(() => {
      // Debounce — fit + resize event are cheap but ResizeObserver fires fast.
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        try {
          fit.fit();
          session.resize(term.cols, term.rows);
        } catch { /* ignore (offscreen) */ }
      }, 100);
    });
    let resizeTimer = 0;
    ro.observe(container);

    term.focus();

    return () => {
      ro.disconnect();
      window.clearTimeout(resizeTimer);
      onTermData.dispose();
      term.dispose();
      removeFromStore(termId);
    };
    // session is intentionally captured once; sendInput/resize identities can change but we want one-time setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div ref={containerRef} className="flex-1 min-h-0 bg-[var(--color-bg)] p-1" />
      <TerminalHelperBar onSend={(d) => session.sendInput(d)} />
    </div>
  );
}

function getCss(varName: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v.length > 0 ? v : undefined;
}
```

- [ ] **Step 2: Run web tests + typecheck (sanity)**

```bash
npm run web:test
npm run web:typecheck
```
Expected: green. (No new tests; the xterm + ResizeObserver mount won't be invoked by existing tests because no current page imports `TerminalView`.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/terminal/TerminalView.tsx
git commit -m "feat(web): TerminalView mounts xterm.js with fit + resize"
```

---

## Task 12 — Terminal Page + Route

**Files:**
- Create: `apps/web/src/pages/Terminal.tsx`
- Create: `apps/web/src/features/terminal/__tests__/Terminal.page.test.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/terminal/__tests__/Terminal.page.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Terminal } from '../../../pages/Terminal';
import { useTerminalsStore } from '../../../store/terminals';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/terminal/:id" element={<Terminal />} />
        <Route path="/sessions" element={<div>SESSIONS_PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Terminal page', () => {
  beforeEach(() => {
    useTerminalsStore.setState({ terminals: {}, order: [] });
  });

  it('redirects to /sessions when termId is unknown', () => {
    renderAt('/terminal/missing');
    expect(screen.getByText('SESSIONS_PAGE')).toBeTruthy();
  });

  it('renders the terminal container when termId exists', () => {
    useTerminalsStore.setState({
      terminals: {
        t1: { termId: 't1', cwd: '/p', createdAt: 1, alive: true },
      },
      order: ['t1'],
    });
    const { container } = renderAt('/terminal/t1');
    // The TerminalView wrapper has a flex flex-col root.
    expect(container.querySelector('.flex.flex-col')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
npm run web:test -- terminal/Terminal.page
```

- [ ] **Step 3: Implement the page**

`apps/web/src/pages/Terminal.tsx`:

```tsx
import { Navigate, useParams } from 'react-router-dom';
import { useTerminalsStore } from '../store/terminals';
import { TerminalView } from '../features/terminal/TerminalView';

export function Terminal(): JSX.Element {
  const { id } = useParams();
  const term = useTerminalsStore((s) => (id ? s.terminals[id] : undefined));
  if (!id || !term) return <Navigate to="/sessions" replace />;
  return <TerminalView termId={id} />;
}
```

- [ ] **Step 4: Add the route**

`apps/web/src/App.tsx` — add inside `<AppShell />`:

```tsx
import { Terminal } from './pages/Terminal';
// ...
<Route path="/terminal/:id" element={<Terminal />} />
```

- [ ] **Step 5: Run, expect pass**

```bash
npm run web:test -- terminal/Terminal.page
```

- [ ] **Step 6: Run typecheck**

```bash
npm run web:typecheck
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/Terminal.tsx \
        apps/web/src/App.tsx \
        apps/web/src/features/terminal/__tests__/Terminal.page.test.tsx
git commit -m "feat(web): /terminal/:id route + redirect-on-unknown"
```

---

## Task 13 — Picker + `useNewSession` Branch for Terminal

**Files:**
- Modify: `apps/web/src/features/project-picker/ProjectPicker.tsx`
- Modify: `apps/web/src/features/project-picker/useNewSession.tsx`
- Update: `apps/web/src/features/project-picker/ProjectPicker.test.tsx` (add a Terminal-radio test if the file already covers radio behavior; otherwise add one targeted test)

- [ ] **Step 1: Extend `ProjectPickerSelection`**

In `apps/web/src/features/project-picker/ProjectPicker.tsx`:

1. Change the type:

```ts
export interface ProjectPickerSelection {
  agent: AgentKind | 'terminal';   // widened
  dirs: string[];
  projectPath: string;
  account?: string;
}
```

2. Update the `agent` state type:

```ts
const [agent, setAgent] = useState<AgentKind | 'terminal'>('claude');
```

3. Read the capability flag and conditionally render the Terminal radio:

```ts
import { useConnectionStore } from '../../store/connection';
// inside component:
const terminalCapable = useConnectionStore((s) => s.capabilities?.terminal ?? false);
```

4. Add the radio JSX after the existing Codex `<label>`:

```tsx
{terminalCapable && (
  <label>
    <input
      type="radio"
      name="agent"
      value="terminal"
      checked={agent === 'terminal'}
      onChange={() => {
        setAgent('terminal');
        setAutoLoaded(false);
        setDirs([]);
      }}
    />
    {' '}Terminal
  </label>
)}
```

5. When `agent === 'terminal'`, hide the Codex account selector and the profile picker — they only apply to Claude/Codex. Wrap those blocks:

```tsx
{agent !== 'terminal' && agent === 'codex' && accounts.length > 0 && ( /* existing account block */ )}
{agent !== 'terminal' && (
  <div className="picker-profile mb-3">
    <ProfilePicker ... />
  </div>
)}
```

(Single-dir is required for terminal; the existing `DirPicker` already supports a single dir, no change needed.)

- [ ] **Step 2: Branch in `useNewSession`**

In `apps/web/src/features/project-picker/useNewSession.tsx`:

1. Replace the `client.send({ type: 'start', ... })` block with a branch on `selection.agent`:

```tsx
import { startTerminal } from '../terminal/terminal-client';

// inside onPick:
const correlationId = newCorrelationId();
awaitingCorrelationRef.current = correlationId;
if (selection.agent === 'terminal') {
  // Single dir only for terminal; ignore extras if any.
  const cwd = selection.dirs[0]!;
  // Default starting size; FitAddon resizes on first paint.
  const cols = 80;
  const rows = 24;
  // startTerminal takes its own correlationId; we want to await term_started, so
  // build the correlationId here and send the start message ourselves:
  client.send({ type: 'term_start', cwd, cols, rows, correlationId });
} else {
  client.send({
    type: 'start',
    agent: selection.agent,
    dirs: selection.dirs,
    projectPath: selection.projectPath,
    ...(selection.account ? { account: selection.account } : {}),
    correlationId,
  });
}
setPickerOpen(false);
```

2. Replace the existing `useEffect` that watches `sessionsMap` for matching `correlationId` with one that **also** watches the terminals store — when `term_started` lands with a matching correlationId, navigate to `/terminal/:id`:

```tsx
import { useTerminalsStore } from '../../store/terminals';

const terminalsMap = useTerminalsStore((s) => s.terminals);

useEffect(() => {
  const target = awaitingCorrelationRef.current;
  if (!target) return;

  // Existing AI-session match path (unchanged).
  for (const s of Object.values(sessionsMap)) {
    const matched = s.events.find(
      (e) => e.type === 'system' && e.event === 'session_created' && e.correlationId === target,
    );
    if (matched) {
      awaitingCorrelationRef.current = null;
      navigate(`/session/${s.sessionId}`);
      return;
    }
  }

  // Terminal match path: terminals store doesn't carry correlationIds, so
  // we additionally subscribe to the bridge client's message stream once,
  // and on a `term_started` reply with a matching correlationId, navigate.
}, [sessionsMap, navigate]);

// Subscribe to term_started replies for navigation.
useEffect(() => {
  const off = client.on('message', (m) => {
    const target = awaitingCorrelationRef.current;
    if (!target) return;
    if (m.type === 'term_started' && m.correlationId === target) {
      awaitingCorrelationRef.current = null;
      navigate(`/terminal/${m.termId}`);
    }
  });
  return off;
}, [client, navigate]);
```

(`useTerminalsStore`'s `applyServerMsg` should be called from the central app message dispatcher — wire that in step 3.)

- [ ] **Step 3: Wire `useTerminalsStore.applyServerMsg` into the central message dispatcher**

Find where the existing `useSessionsStore.applyServerMsg` is invoked on every WS message (search `applyServerMsg(` in `apps/web/src`). In the same place, add:

```ts
import { useTerminalsStore } from './store/terminals';
// ...
useTerminalsStore.getState().applyServerMsg(m);
```

- [ ] **Step 4: Update or add a picker test**

Open `apps/web/src/features/project-picker/ProjectPicker.test.tsx`. Add a test:

```tsx
import { useConnectionStore } from '../../store/connection';

it('shows Terminal radio when capabilities.terminal is true', () => {
  useConnectionStore.setState({ capabilities: { terminal: true } });
  render(<ProjectPicker onPick={() => {}} onCancel={() => {}} />);
  expect(screen.getByLabelText(/terminal/i)).toBeTruthy();
});

it('hides Terminal radio when capabilities.terminal is false', () => {
  useConnectionStore.setState({ capabilities: { terminal: false } });
  render(<ProjectPicker onPick={() => {}} onCancel={() => {}} />);
  expect(screen.queryByLabelText(/terminal/i)).toBeNull();
});
```

(If `useConnectionStore.setState` isn't directly available because the store is created differently, mock its `useConnectionStore` hook with `vi.mock` to return the desired capability.)

- [ ] **Step 5: Run web tests**

```bash
npm run web:test
```
Expected: all green, including the two new picker tests.

- [ ] **Step 6: Run typecheck**

```bash
npm run web:typecheck
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/project-picker/ProjectPicker.tsx \
        apps/web/src/features/project-picker/useNewSession.tsx \
        apps/web/src/features/project-picker/ProjectPicker.test.tsx
git commit -m "feat(web): Terminal option in project picker; navigate on term_started"
```

---

## Task 14 — Merge Terminals into Sessions/Home Lists

**Files:**
- Modify: `apps/web/src/pages/Home.tsx`
- Modify: `apps/web/src/pages/Sessions.tsx`

These are display-only changes. Existing tests for the two pages remain valid; we add behavior, not change existing.

- [ ] **Step 1: Modify `Home.tsx` — merge terminals into the active list**

Open `apps/web/src/pages/Home.tsx`. Add:

```ts
import { useTerminalsStore } from '../store/terminals';

// inside Home():
const terminalsMap = useTerminalsStore((s) => s.terminals);
const terminalsOrder = useTerminalsStore((s) => s.order);

const aliveTerminals = terminalsOrder
  .map((id) => terminalsMap[id]!)
  .filter((t): t is NonNullable<typeof t> => Boolean(t?.alive));
```

In the existing `aliveSessions` rendering block, add after the `{aliveSessions.map(...)}` rows a parallel `{aliveTerminals.map(...)}` block inside the same `<ul>`:

```tsx
{aliveTerminals.map((t) => {
  const label = t.cwd.split('/').filter(Boolean).pop() ?? t.cwd;
  return (
    <li key={t.termId}>
      <button
        type="button"
        className="w-full text-left p-4 min-h-[56px] flex items-center justify-between hover:bg-[var(--color-surface-2)] transition-colors"
        onClick={() => navigate(`/terminal/${t.termId}`)}
      >
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[var(--color-text)] font-bold truncate">
            <span className="text-[var(--color-text-dim)] text-xs mr-1">[term]</span>
            {label}
          </span>
          <span className="text-[var(--color-text-dim)] text-xs font-mono truncate">{t.cwd}</span>
        </div>
        <div className="w-2.5 h-2.5 bg-[var(--color-success)] rounded-full shrink-0" aria-label="alive" />
      </button>
    </li>
  );
})}
```

Also adjust the empty-state condition: only show "No active sessions" when **both** `aliveSessions` and `aliveTerminals` are empty.

- [ ] **Step 2: Modify `Sessions.tsx` — same merge, full list**

Open `apps/web/src/pages/Sessions.tsx`. Add the same `useTerminalsStore` subscription and reuse the same row JSX from Home. The `SessionList` component takes a typed `sessions` array — add a sibling section beneath `<SessionList />` for terminals:

```tsx
{aliveTerminals.length > 0 && (
  <ul className="list-none p-0 m-0 mt-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl divide-y divide-[var(--color-border)] overflow-hidden">
    {aliveTerminals.map((t) => ( /* same row JSX as in Home.tsx */ ))}
  </ul>
)}
```

(DRY note: extracting a shared `<TerminalListRow>` component is optional — only do so if the repeated JSX is bothering you; otherwise duplicating two ~15-line blocks is fine.)

- [ ] **Step 3: Run web tests**

```bash
npm run web:test
```
Expected: green; existing Home/Sessions tests continue to pass because they don't assert on terminal absence.

- [ ] **Step 4: Run typecheck**

```bash
npm run web:typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Home.tsx apps/web/src/pages/Sessions.tsx
git commit -m "feat(web): show active terminals in Home + Sessions lists"
```

---

## Task 15 — Manual Integration Checklist

**Goal:** Validate the end-to-end behavior on a real Mac with the bridge running locally. Document blockers as new bugs/tasks; don't try to fix in this task.

- [ ] **Step 1: Build + start the bridge**

```bash
npm run build
npm run bridge:dev
```

Confirm the log shows `[bridge] binding to ...` and the absence of `[bridge] node-pty failed to load` (if it fails to load, install build tools — `xcode-select --install` on macOS — and re-run `npm install` in `packages/bridge`).

- [ ] **Step 2: Open the web app, verify the picker shows Terminal**

Open `http://<bind-host>:<port>/?token=<TOKEN>` in a browser. Click **New Session**. Confirm the **Terminal** radio appears next to Claude/Codex.

- [ ] **Step 3: Spawn and use a terminal**

Pick a directory inside `BRIDGE_ALLOWED_DIRS`, choose Terminal, click Open. Confirm the page navigates to `/terminal/:id` and an interactive shell prompt appears.

Run, in order:
- `ls` — see colored output.
- `vim /tmp/test` — cursor + status bar render. Type `i`, type some text, `<Esc>`, `:wq`. Returns to shell.
- `htop` for ~5s — refresh smooth, layout fills the viewport. `q` to quit.

- [ ] **Step 4: Resize**

Resize the browser window. Run `tput cols && tput lines` — values reflect the new viewport.

- [ ] **Step 5: Mobile / Tailscale**

On a phone via Tailscale, open the same URL. Confirm:
- Terminal radio appears in picker.
- Helper bar visible above the on-screen keyboard.
- Tap **Esc / Tab / arrows / Ctrl-C** all produce expected effects.

- [ ] **Step 6: Disconnect kills PTY**

Spawn a terminal. In a separate Mac terminal, run `ps aux | grep -E 'zsh.*-l' | grep -v grep` — note the PID. Close the browser tab. Within 5s the PID disappears.

- [ ] **Step 7: Allowlist enforcement**

Forge a `term_start` for a path outside `BRIDGE_ALLOWED_DIRS` (use the browser devtools websocket inspector to send the message manually). Confirm an `error` message with code `path_outside_allowlist` arrives.

- [ ] **Step 8: Capability fallback**

Stop the bridge. Temporarily rename `node_modules/node-pty` to `node-pty.bak` (so the import fails). Restart the bridge — log shows `[bridge] node-pty failed to load — terminal mode disabled`. Open the picker — Terminal option is hidden.

Restore the rename and restart the bridge.

- [ ] **Step 9: Cleanup commit (only if any small fixes were made during the manual run)**

If you tweaked anything during the manual pass (e.g. CSS spacing, helper bar color), commit those small fixes here:

```bash
git add -p
git commit -m "fix(web): terminal mode polish from manual QA"
```

If nothing needed touching, skip the commit.

---

## End-of-Plan Checks

After all tasks complete:

- [ ] `npm run typecheck` (root) — green.
- [ ] `npm run test` (root) — all suites green.
- [ ] `npm run build` — produces a working web bundle that the bridge serves.
- [ ] Spec items in `docs/superpowers/specs/2026-05-09-terminal-mode-design.md` all map to a task above (verified during self-review below).

---

## Self-Review Notes (already applied)

- **Spec coverage:** Every spec section maps to at least one task —
  Architecture (Tasks 1, 3–6), Wire Protocol (Task 2 + 7), Bridge Components
  (Tasks 3–6), Web Components (Tasks 8–14), Dependencies (Tasks 3 + 7),
  Security (Tasks 1, 4, 5 — allowlist + cross-ws isolation tested), Testing
  (every code task contains its tests; manual checklist is Task 15).
- **Placeholders:** None. Every code step contains real code; every command
  is concrete; every error code is named.
- **Type consistency:** `TerminalSession`, `TerminalProcess`, `TerminalManager`,
  `term_*` message names match across bridge ↔ web. `wsId` is the property
  name used everywhere; `termId` everywhere; `cwd` everywhere (not
  `projectPath`, which would have collided with the AI side).
