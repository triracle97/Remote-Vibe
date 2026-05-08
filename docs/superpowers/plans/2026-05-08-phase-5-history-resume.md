# Phase 5 — History Viewer + Session Resume + Banner Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make any past Claude/Codex CLI session resumable from the web UI — history panel of top-50 native CLI sessions per agent, single-click Resume button on dead sessions, and silent transcript fallback (no noisy `session_dead` banner).

**Architecture:** Bridge gains a disk-persisted `session-registry.ts` (`webSessionId → metadata` map surviving restart) plus `history-scanner.ts` that reads `~/.claude/projects/*/[id].jsonl` and `~/.codex/sessions/Y/M/D/*.jsonl`. Both Claude/Codex drivers gain a `cli_session_id_captured` event so SessionManager seeds the registry on first observation. Two new WS message types (`list_history` + `resume_session`); web adds `HistoryPanel` drawer, `ResumePrompt` inline banner, sessions-store actions for `resume(webSessionId)` and `resumeFromHistory(entry)`, and routes `error: session_dead` to per-session state instead of global error banner.

**Tech Stack:** Node 20 ESM (NodeNext, `exactOptionalPropertyTypes: true`), Vitest 1, React 18 + Zustand 4 + React Router 6 + Vite 5. No new web dependencies.

**Spec:** `docs/superpowers/specs/2026-05-08-phase-5-history-resume-design.md`

**Out of scope (per spec §2):** search/filter inside history list, pagination beyond top-50, turn count / token usage in rows, bulk-resume / archive / per-row delete, native-history JSONL → bridge transcript import, multi-account selection UI on resume.

---

## File Structure

### Bridge — new files

```
packages/bridge/src/
├── session-registry.ts             # disk-persisted webSessionId → metadata map
├── history-scanner.ts              # native CLI history scan (Claude + Codex dirs)
└── __tests__/
    ├── session-registry.test.ts
    └── history-scanner.test.ts
```

### Bridge — modified files

| File | Change |
|---|---|
| `packages/bridge/src/types.ts` | Add `ClientListHistoryMsg`, `ClientResumeSessionMsg`, `ServerHistoryListMsg`, `ServerSessionResumedMsg`, `HistoryEntry`. Extend `ServerErrorMsg.code` union with the seven new typed codes. |
| `packages/bridge/src/codex-process.ts` | The `session_id` parser branch (currently stores internally + `continue;`) now ALSO emits `cli_session_id_captured` upstream once per session lifetime. Idempotent. |
| `packages/bridge/src/claude-process.ts` | When the existing parser yields the Claude `system` init event with `session_id`, emit `cli_session_id_captured` upstream once. |
| `packages/bridge/src/session.ts` (`SessionManager`) | New `resume(webSessionId)` method (Claude: spawn-with-resume; Codex: re-instantiate driver seeded with codexSessionId). Subscribe to driver `cli_session_id_captured` to call `sessionRegistry.update()`. Up-front registry-entry creation on every fresh-session spawn. |
| `packages/bridge/src/websocket.ts` | New WS handlers for `list_history` (calls scanner with 60 s in-memory cache) and `resume_session` (calls `SessionManager.resume()`). |
| `packages/bridge/src/index.ts` | On boot: `await sessionRegistry.load()`. Initialize scanner (no-op until first request). |
| `packages/bridge/src/__tests__/codex-process.test.ts` (or session-process related) | Add test asserting the `cli_session_id_captured` event is emitted on session_id capture. |
| `packages/bridge/src/__tests__/claude-process.test.ts` | Add same test for Claude. |
| `packages/bridge/src/__tests__/session.test.ts` | Add tests for `resume()` happy path + each error code. |
| `packages/bridge/src/__tests__/websocket.test.ts` | Add WS tests for `list_history` and `resume_session` happy + error paths. |

### Web — new files

```
apps/web/src/features/history/
├── HistoryPanel.tsx                # collapsible drawer with Claude/Codex tabs
├── HistoryPanel.test.tsx
├── HistoryRow.tsx                  # one row: project basename + preview + relative time
├── historyStore.ts                 # zustand: list, loading, lastFetched, fetch()
├── historyStore.test.ts
└── history.css                     # tab styling, dense rows, hover tooltip

apps/web/src/features/chat/
├── ResumePrompt.tsx                # inline "session ended — Resume to continue"
└── ResumePrompt.test.tsx
```

### Web — modified files

| File | Change |
|---|---|
| `apps/web/src/types/protocol.ts` | Mirror bridge type additions byte-identically. |
| `apps/web/src/store/sessions.ts` | `error: session_dead` flips per-session `alive: false` (does NOT push to global errors). Add `resume(webSessionId)` and `resumeFromHistory(entry)` actions. |
| `apps/web/src/App.tsx` | Short-circuit `error: session_dead` BEFORE the global `setError()` call (around line 57-61). Other error codes still flow through to the global banner. |
| `apps/web/src/pages/Home.tsx` | Render `<HistoryPanel />` below live sessions list. |
| `apps/web/src/pages/Session.tsx` | Render `<ResumePrompt />` between message list and InputBox when `!alive`. Show transcript-unavailable variant when transcript yielded 0 events. |
| `apps/web/src/features/chat/Chat.tsx` | Pass alive + resume callbacks down to `<ResumePrompt />`. |
| `apps/web/src/features/chat/InputBox.tsx` | Auto-prompt-on-send: if `!alive` and user submits, swap inline ResumePrompt to "Resume + send" CTA; flush queued first message after resume succeeds. |
| `apps/web/src/main.tsx` | Add `import './features/history/history.css';`. |

---

## Task 1: Protocol type additions (bridge + web byte-identical)

**Files:**
- Modify: `packages/bridge/src/types.ts`
- Modify: `apps/web/src/types/protocol.ts`
- Test: none in this task — types are exercised by later task tests.

This task is pure type plumbing. Both files must stay byte-identical (same convention as Phases 1-4).

- [ ] **Step 1: Read both existing type files**

```bash
cat /Volumes/WDSSD/Code/mac-remote-terminal/packages/bridge/src/types.ts | head -80
cat /Volumes/WDSSD/Code/mac-remote-terminal/apps/web/src/types/protocol.ts | head -80
```

Note the existing `ServerErrorMsg` shape (uses single `code` field) and the existing client/server message union exports. Identify where new interfaces should slot in (typically alongside other `Client*Msg` and `Server*Msg` interfaces).

- [ ] **Step 2: Add new interfaces to `packages/bridge/src/types.ts`**

Insert these definitions alongside the existing message types:

```ts
// Phase 5 — history viewer + session resume

export interface HistoryEntry {
  agent: 'claude' | 'codex';
  /** CLI's own session uuid (Claude: filename without `.jsonl`; Codex: session_meta.payload.id). */
  sessionId: string;
  /** Ground-truth cwd extracted from file content. Entries with no parseable user message are dropped. */
  projectPath: string;
  /** ms since epoch */
  mtime: number;
  /** First user message text, truncated to 80 chars; "" if none parseable. */
  firstPrompt: string;
}

export interface ClientListHistoryMsg {
  type: 'list_history';
  correlationId: string;
}

/**
 * Resume — tagged union with two shapes:
 *   (a) Bridge-known: only webSessionId is required; bridge looks up the
 *       agent + projectPath + cliSessionId from its registry.
 *   (b) Native-history first-resume: agent + sessionId + projectPath required;
 *       bridge issues a new webSessionId.
 */
export type ClientResumeSessionMsg =
  | {
      type: 'resume_session';
      webSessionId: string;
      account?: string;
      correlationId: string;
    }
  | {
      type: 'resume_session';
      agent: 'claude' | 'codex';
      sessionId: string;
      projectPath: string;
      account?: string;
      correlationId: string;
    };

export interface ServerHistoryListMsg {
  type: 'history_list';
  claude: HistoryEntry[];
  codex: HistoryEntry[];
  correlationId: string;
}

export interface ServerSessionResumedMsg {
  type: 'session_resumed';
  webSessionId: string;
  alive: true;
  correlationId: string;
}
```

Locate the existing `ServerErrorMsg` interface and EXTEND its `code` union. Find the existing definition; it likely looks like:

```ts
export interface ServerErrorMsg {
  type: 'error';
  code: 'session_dead' | 'invalid_request' | /* ... */;
  message: string;
  sessionId?: string;
  correlationId?: string;
}
```

Add the seven new codes. After the edit it should include:

```ts
  code:
    | /* existing codes (preserved verbatim) */
    | 'history_session_not_found'
    | 'project_path_disallowed'
    | 'project_path_missing'
    | 'cli_session_id_unknown'
    | 'claude_resume_rejected'
    | 'codex_resume_rejected'
    | 'resume_spawn_failed';
```

Add the new interfaces to the `ClientMsg` and `ServerMsg` discriminated union exports (whatever symbol the file uses to export "any client message"). Likely:

```ts
export type ClientMsg = /* existing */ | ClientListHistoryMsg | ClientResumeSessionMsg;
export type ServerMsg = /* existing */ | ServerHistoryListMsg | ServerSessionResumedMsg;
```

- [ ] **Step 3: Mirror byte-identically into `apps/web/src/types/protocol.ts`**

Copy the same five new interfaces, the same `ServerErrorMsg.code` union extension, and the same union member additions. The two files MUST be byte-identical (subject to tab/space conventions of the existing file). If web file uses `import type` differently, preserve that — just match the new declarations.

- [ ] **Step 4: Verify both type-check clean**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npx tsc --noEmit -p packages/bridge/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: zero errors. Existing tests will still pass since no behavior changed yet.

- [ ] **Step 5: Verify byte-identical**

```bash
diff <(grep -A 200 'Phase 5' /Volumes/WDSSD/Code/mac-remote-terminal/packages/bridge/src/types.ts) <(grep -A 200 'Phase 5' /Volumes/WDSSD/Code/mac-remote-terminal/apps/web/src/types/protocol.ts)
```

Expected: no output. Adjust either file if the diff shows discrepancies.

- [ ] **Step 6: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add packages/bridge/src/types.ts apps/web/src/types/protocol.ts
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(types): add Phase 5 history + resume protocol types"
```

---

## Task 2: `session-registry.ts` — disk-persisted webSessionId → metadata map

**Files:**
- Create: `packages/bridge/src/session-registry.ts`
- Create: `packages/bridge/src/__tests__/session-registry.test.ts`

The registry persists session metadata across bridge restarts. Three layers per spec §3: serialized in-process write queue, unique tmp filenames, fsync before rename.

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/session-registry.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistry } from '../session-registry';

describe('SessionRegistry', () => {
  let dir: string;
  let registryPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reg-test-'));
    registryPath = join(dir, 'sessions.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('load() returns empty registry when file does not exist', async () => {
    const reg = new SessionRegistry(registryPath);
    await reg.load();
    expect(reg.get('any-id')).toBeUndefined();
  });

  it('add() persists entry to disk', async () => {
    const reg = new SessionRegistry(registryPath);
    await reg.load();
    await reg.add({
      webSessionId: 'web-1',
      agent: 'claude',
      projectPath: '/tmp/proj',
      transcriptPath: '.bridge/transcripts/web-1.jsonl',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 1000,
      account: null,
    });
    const raw = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(raw.sessions['web-1'].agent).toBe('claude');
    expect(raw.sessions['web-1'].claudeSessionId).toBeNull();
  });

  it('update() merges fields and persists', async () => {
    const reg = new SessionRegistry(registryPath);
    await reg.load();
    await reg.add({
      webSessionId: 'web-1',
      agent: 'claude',
      projectPath: '/tmp/proj',
      transcriptPath: '.bridge/transcripts/web-1.jsonl',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 1000,
      account: null,
    });
    await reg.update('web-1', { claudeSessionId: 'abc-123' });
    const entry = reg.get('web-1');
    expect(entry?.claudeSessionId).toBe('abc-123');
    const raw = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(raw.sessions['web-1'].claudeSessionId).toBe('abc-123');
  });

  it('load() restores entries written by a previous instance', async () => {
    const reg1 = new SessionRegistry(registryPath);
    await reg1.load();
    await reg1.add({
      webSessionId: 'web-1',
      agent: 'codex',
      projectPath: '/tmp/x',
      transcriptPath: '.bridge/transcripts/web-1.jsonl',
      claudeSessionId: null,
      codexSessionId: 'codex-uuid',
      createdAt: 2000,
      account: 'default',
    });
    const reg2 = new SessionRegistry(registryPath);
    await reg2.load();
    expect(reg2.get('web-1')?.codexSessionId).toBe('codex-uuid');
  });

  it('serializes concurrent writes — no torn file under rapid updates', async () => {
    const reg = new SessionRegistry(registryPath);
    await reg.load();
    await reg.add({
      webSessionId: 'web-1',
      agent: 'claude',
      projectPath: '/tmp/proj',
      transcriptPath: '.bridge/transcripts/web-1.jsonl',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 1000,
      account: null,
    });
    // Fire 50 concurrent updates each with a different value.
    const writes = Array.from({ length: 50 }, (_, i) =>
      reg.update('web-1', { claudeSessionId: `id-${i}` }),
    );
    await Promise.all(writes);
    // After all settle, file must be valid JSON and contain ONE of the values.
    const raw = JSON.parse(readFileSync(registryPath, 'utf-8'));
    const final = raw.sessions['web-1'].claudeSessionId;
    expect(final).toMatch(/^id-\d+$/);
  });

  it('writes the registry file with mode 0o600', async () => {
    const reg = new SessionRegistry(registryPath);
    await reg.load();
    await reg.add({
      webSessionId: 'web-1',
      agent: 'claude',
      projectPath: '/tmp/p',
      transcriptPath: '.bridge/transcripts/web-1.jsonl',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 0,
      account: null,
    });
    const stat = statSync(registryPath);
    expect((stat.mode & 0o777).toString(8)).toBe('600');
  });

  it('falls back to empty registry when existing file is corrupt', async () => {
    writeFileSync(registryPath, '{ this is not json', { mode: 0o600 });
    const reg = new SessionRegistry(registryPath);
    await reg.load();
    expect(reg.get('any')).toBeUndefined();
  });

  it('remove() deletes entry and persists', async () => {
    const reg = new SessionRegistry(registryPath);
    await reg.load();
    await reg.add({
      webSessionId: 'web-1',
      agent: 'claude',
      projectPath: '/tmp/p',
      transcriptPath: '.bridge/transcripts/web-1.jsonl',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 0,
      account: null,
    });
    await reg.remove('web-1');
    expect(reg.get('web-1')).toBeUndefined();
    const raw = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(raw.sessions['web-1']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run bridge:test -- session-registry
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/bridge/src/session-registry.ts`**

```ts
import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';

export interface RegistryEntry {
  webSessionId: string;
  agent: 'claude' | 'codex';
  projectPath: string;
  transcriptPath: string;
  /** CLI's own session uuid; populated when first observed. */
  claudeSessionId: string | null;
  codexSessionId: string | null;
  /** ms since epoch */
  createdAt: number;
  /** Codex profile name, if any. */
  account: string | null;
}

interface RegistryFile {
  sessions: Record<string, RegistryEntry>;
}

export class SessionRegistry {
  private state: RegistryFile = { sessions: {} };
  private writeQueue: Promise<void> = Promise.resolve();
  private writeCounter = 0;
  private loaded = false;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const buf = await fsp.readFile(this.path, 'utf-8');
      const parsed = JSON.parse(buf) as RegistryFile;
      if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
        this.state = parsed;
      } else {
        this.state = { sessions: {} };
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.state = { sessions: {} };
      } else {
        // Corrupt or unreadable — log and start empty. Do NOT crash on boot.
        console.error('[session-registry] failed to load, starting empty:', err);
        this.state = { sessions: {} };
      }
    }
    this.loaded = true;
  }

  get(webSessionId: string): RegistryEntry | undefined {
    return this.state.sessions[webSessionId];
  }

  all(): RegistryEntry[] {
    return Object.values(this.state.sessions);
  }

  async add(entry: RegistryEntry): Promise<void> {
    this.assertLoaded();
    this.state.sessions[entry.webSessionId] = entry;
    await this.persist();
  }

  async update(webSessionId: string, patch: Partial<RegistryEntry>): Promise<void> {
    this.assertLoaded();
    const existing = this.state.sessions[webSessionId];
    if (!existing) return;
    this.state.sessions[webSessionId] = { ...existing, ...patch };
    await this.persist();
  }

  async remove(webSessionId: string): Promise<void> {
    this.assertLoaded();
    if (!(webSessionId in this.state.sessions)) return;
    delete this.state.sessions[webSessionId];
    await this.persist();
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('SessionRegistry: load() must be awaited before mutations');
  }

  /**
   * Serialize all writes through a promise chain. Each call awaits the
   * previous write before starting its own. Snapshots the latest in-memory
   * state at the moment of write so coalesced rapid updates are fine.
   */
  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    const counter = ++this.writeCounter;
    const tmpPath = `${this.path}.tmp.${process.pid}.${counter}`;
    const queued = this.writeQueue.then(async () => {
      await fsp.mkdir(dirname(this.path), { recursive: true });
      const fh = await fsp.open(tmpPath, 'w', 0o600);
      try {
        await fh.writeFile(snapshot, 'utf-8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fsp.rename(tmpPath, this.path);
    });
    // Don't let one failure poison the chain — swallow the error after
    // surfacing it; subsequent writes still proceed.
    this.writeQueue = queued.catch((err) => {
      console.error('[session-registry] persist failed:', err);
    });
    return queued;
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run bridge:test -- session-registry
```

Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add packages/bridge/src/session-registry.ts packages/bridge/src/__tests__/session-registry.test.ts
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(bridge): SessionRegistry with serialized atomic writes + 0o600 mode"
```

---

## Task 3: `history-scanner.ts` — native CLI history scan + 60s cache

**Files:**
- Create: `packages/bridge/src/history-scanner.ts`
- Create: `packages/bridge/src/__tests__/history-scanner.test.ts`

Reads `~/.claude/projects/*/[id].jsonl` and `~/.codex/sessions/Y/M/D/*.jsonl`. Top-50 per agent, mtime-desc, allowlist-filtered against ground-truth cwd from file content. 60 s in-memory cache.

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/history-scanner.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryScanner } from '../history-scanner';

function setMtime(path: string, secAgo: number): void {
  const t = Date.now() / 1000 - secAgo;
  utimesSync(path, t, t);
}

describe('HistoryScanner', () => {
  let homeDir: string;
  let claudeDir: string;
  let codexDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'history-test-'));
    claudeDir = join(homeDir, '.claude', 'projects');
    codexDir = join(homeDir, '.codex', 'sessions');
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  function makeClaudeFile(projectDir: string, fname: string, cwd: string, prompt: string): string {
    const dir = join(claudeDir, projectDir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, fname);
    const lines = [
      JSON.stringify({ type: 'last-prompt', sessionId: fname.replace('.jsonl', '') }),
      JSON.stringify({ type: 'user', cwd, message: { content: prompt } }),
    ];
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  }

  function makeCodexFile(yyyy: string, mm: string, dd: string, fname: string, id: string, cwd: string, prompt: string): string {
    const dir = join(codexDir, yyyy, mm, dd);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, fname);
    const lines = [
      JSON.stringify({ timestamp: '2026-04-20T14:48:16.182Z', type: 'session_meta', payload: { id, cwd } }),
      JSON.stringify({ timestamp: '2026-04-20T14:48:17.000Z', type: 'event_msg', payload: { type: 'user_message', text: prompt } }),
    ];
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  }

  it('scanClaude: returns ground-truth cwd from file content (NOT dir-decode)', async () => {
    // Dir name decodes to "/foo/bar/baz" but the file's actual cwd is "/foo-bar/baz"
    const cwd = join(homeDir, 'foo-bar', 'baz');
    mkdirSync(cwd, { recursive: true });
    const path = makeClaudeFile('-foo-bar-baz', 'aaa.jsonl', cwd, 'first user prompt');
    setMtime(path, 10);

    const scanner = new HistoryScanner({ homeDir, allowedDirs: [cwd], allowlistGate: (cwd) => [cwd].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const result = await scanner.list();
    expect(result.claude).toHaveLength(1);
    expect(result.claude[0]!.projectPath).toBe(cwd);
    expect(result.claude[0]!.firstPrompt).toBe('first user prompt');
    expect(result.claude[0]!.sessionId).toBe('aaa');
  });

  it('scanClaude: drops entries with no parseable user message', async () => {
    const dir = join(claudeDir, '-tmp-x');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'no-user.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'last-prompt' }) + '\n');
    setMtime(path, 5);

    const scanner = new HistoryScanner({ homeDir, allowedDirs: [homeDir], allowlistGate: (cwd) => [homeDir].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const result = await scanner.list();
    expect(result.claude).toHaveLength(0);
  });

  it('scanClaude: drops entries whose ground-truth cwd is outside allowlist', async () => {
    const cwd = '/usr/local/forbidden';
    mkdirSync(homeDir + cwd.replace(/^\//, '/'), { recursive: true });
    const path = makeClaudeFile('-usr-local-forbidden', 'a.jsonl', cwd, 'hi');
    setMtime(path, 5);

    const allowed = join(homeDir, 'allowed');
    mkdirSync(allowed, { recursive: true });
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [allowed], allowlistGate: (cwd) => [allowed].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const result = await scanner.list();
    expect(result.claude).toHaveLength(0);
  });

  it('scanClaude: top-50 sort-then-cap correctness — newest at directory-walk position 90 still appears', async () => {
    const cwd = join(homeDir, 'project');
    mkdirSync(cwd, { recursive: true });
    // Create 100 files; the very last alphabetically (zzz.jsonl) gets the
    // newest mtime. Sort-by-mtime must surface it.
    for (let i = 0; i < 100; i++) {
      const fname = String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + (i % 26)) + '.jsonl';
      const path = makeClaudeFile('-project', fname, cwd, `prompt ${i}`);
      setMtime(path, i === 99 ? 0.001 : 1000 - i); // newest = i=99
    }
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [cwd], allowlistGate: (cwd) => [cwd].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const result = await scanner.list();
    expect(result.claude).toHaveLength(50);
    expect(result.claude[0]!.firstPrompt).toBe('prompt 99'); // newest first
  });

  it('scanClaude: malformed JSONL line does not crash the scan', async () => {
    const cwd = join(homeDir, 'p');
    mkdirSync(cwd, { recursive: true });
    const dir = join(claudeDir, '-p');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'bad.jsonl');
    writeFileSync(path, 'not json at all\n' + JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } }) + '\n');
    setMtime(path, 5);
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [cwd], allowlistGate: (cwd) => [cwd].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const result = await scanner.list();
    // Either the file is dropped (no parseable user) OR survives via the
    // valid second line. Both behaviors are acceptable as long as no throw.
    expect(Array.isArray(result.claude)).toBe(true);
  });

  it('scanClaude: firstPrompt truncated to 80 chars', async () => {
    const cwd = join(homeDir, 'p');
    mkdirSync(cwd, { recursive: true });
    const long = 'x'.repeat(200);
    const path = makeClaudeFile('-p', 'a.jsonl', cwd, long);
    setMtime(path, 1);
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [cwd], allowlistGate: (cwd) => [cwd].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const result = await scanner.list();
    expect(result.claude[0]!.firstPrompt).toHaveLength(80);
  });

  it('scanCodex: extracts sessionId + cwd from session_meta line', async () => {
    const cwd = join(homeDir, 'codex-project');
    mkdirSync(cwd, { recursive: true });
    const path = makeCodexFile('2026', '04', '20', 'rollout-x.jsonl', 'codex-uuid-1', cwd, 'first codex prompt');
    setMtime(path, 5);
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [cwd], allowlistGate: (cwd) => [cwd].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const result = await scanner.list();
    expect(result.codex).toHaveLength(1);
    expect(result.codex[0]!.sessionId).toBe('codex-uuid-1');
    expect(result.codex[0]!.projectPath).toBe(cwd);
    expect(result.codex[0]!.firstPrompt).toBe('first codex prompt');
  });

  it('scanCodex: drops entries whose cwd is outside allowlist', async () => {
    const allowed = join(homeDir, 'allowed');
    mkdirSync(allowed, { recursive: true });
    const path = makeCodexFile('2026', '04', '20', 'rollout-y.jsonl', 'codex-uuid-2', '/forbidden', 'hi');
    setMtime(path, 5);
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [allowed], allowlistGate: (cwd) => [allowed].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const result = await scanner.list();
    expect(result.codex).toHaveLength(0);
  });

  it('60 s cache: two list() calls within window scan filesystem only once', async () => {
    const cwd = join(homeDir, 'p');
    mkdirSync(cwd, { recursive: true });
    makeClaudeFile('-p', 'a.jsonl', cwd, 'hi');
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [cwd], allowlistGate: (cwd) => [cwd].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const spy = vi.spyOn(scanner as unknown as { scanClaude: () => Promise<unknown> }, 'scanClaude');
    await scanner.list();
    await scanner.list();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('invalidateCache() forces a re-scan on next list()', async () => {
    const cwd = join(homeDir, 'p');
    mkdirSync(cwd, { recursive: true });
    makeClaudeFile('-p', 'a.jsonl', cwd, 'hi');
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [cwd], allowlistGate: (cwd) => [cwd].some((a) => cwd === a || cwd.startsWith(a + "/")) });
    const spy = vi.spyOn(scanner as unknown as { scanClaude: () => Promise<unknown> }, 'scanClaude');
    await scanner.list();
    scanner.invalidateCache();
    await scanner.list();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('findEntry returns undefined when backing file was deleted between scan and lookup', async () => {
    const cwd = join(homeDir, 'p');
    mkdirSync(cwd, { recursive: true });
    const path = makeClaudeFile('-p', 'aaa.jsonl', cwd, 'hi');
    setMtime(path, 5);
    const scanner = new HistoryScanner({ homeDir, allowedDirs: [cwd], allowlistGate: (c) => c.startsWith(homeDir) });
    // First call: populates cache + filePathByKey.
    const first = await scanner.findEntry('claude', 'aaa');
    expect(first).toBeDefined();
    // Delete the backing file.
    rmSync(path);
    // Second call: cache still has the entry, but findEntry re-stats and rejects.
    const second = await scanner.findEntry('claude', 'aaa');
    expect(second).toBeUndefined();
  });

  it('returns [] for both agents when home dirs are missing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'empty-'));
    const scanner = new HistoryScanner({ homeDir: empty, allowedDirs: [empty], allowlistGate: () => true });
    const result = await scanner.list();
    expect(result.claude).toEqual([]);
    expect(result.codex).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run bridge:test -- history-scanner
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/bridge/src/history-scanner.ts`**

```ts
import { promises as fsp } from 'node:fs';
import { join, basename } from 'node:path';
import type { HistoryEntry } from './types.js';

interface ScannerOpts {
  homeDir: string;
  allowedDirs: string[];
  /**
   * Phase 3 allowlist + denylist gate. Should return true iff the path is
   * inside `allowedDirs` AND none of the Phase 3 denylist patterns match.
   * Tests can stub this with a simple prefix check; production code wires
   * the real gate from `fs-api.ts`.
   */
  allowlistGate: (cwd: string) => Promise<boolean> | boolean;
}

interface CandidateFile {
  filePath: string;
  mtime: number;
}

const SURFACE_CAP = 50;
const HEAD_BYTES = 4096;
const FORWARD_SCAN_BYTES = 16384;
const PROMPT_TRUNCATE = 80;
const CACHE_TTL_MS = 60_000;

export class HistoryScanner {
  private cache: { value: { claude: HistoryEntry[]; codex: HistoryEntry[] }; expiresAt: number } | null = null;
  /**
   * Side channel from (agent, sessionId) → backing file path. Populated during
   * each scan. Used by findEntry() to re-stat the file at resume time so a
   * deleted-between-scan-and-click case is detected.
   */
  private filePathByKey = new Map<string, string>();

  constructor(private readonly opts: ScannerOpts) {}

  async list(): Promise<{ claude: HistoryEntry[]; codex: HistoryEntry[] }> {
    if (this.cache !== null && Date.now() < this.cache.expiresAt) {
      return this.cache.value;
    }
    const [claude, codex] = await Promise.all([this.scanClaude(), this.scanCodex()]);
    const value = { claude, codex };
    this.cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  }

  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Look up an entry by (agent, sessionId) AND re-validate the backing file
   * still exists on disk. This catches the spec's "JSONL deleted between scan
   * and click" case. Returns undefined if either the cache lookup or the
   * disk-stat fails.
   *
   * Used by SessionManager.resume() Path 2 to verify a native-history session
   * id maps to a real, currently-on-disk file. Re-runs the scan if cache is
   * missing.
   */
  async findEntry(agent: 'claude' | 'codex', sessionId: string): Promise<HistoryEntry | undefined> {
    const list = await this.list();
    const arr = agent === 'claude' ? list.claude : list.codex;
    const entry = arr.find((e) => e.sessionId === sessionId);
    if (!entry) return undefined;
    const filePath = this.filePathByKey.get(`${agent}:${sessionId}`);
    if (!filePath) return undefined;
    try {
      await fsp.access(filePath); // throws ENOENT if deleted
    } catch {
      return undefined;
    }
    return entry;
  }

  private async scanClaude(): Promise<HistoryEntry[]> {
    const projectsRoot = join(this.opts.homeDir, '.claude', 'projects');
    let projectDirs: string[];
    try {
      projectDirs = (await fsp.readdir(projectsRoot, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => join(projectsRoot, d.name));
    } catch {
      return [];
    }

    const candidates: CandidateFile[] = [];
    for (const dir of projectDirs) {
      let entries: { name: string }[];
      try {
        entries = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && d.name.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const entry of entries) {
        const filePath = join(dir, entry.name);
        try {
          const stat = await fsp.stat(filePath);
          candidates.push({ filePath, mtime: stat.mtimeMs });
        } catch {
          // file vanished between readdir and stat; skip
        }
      }
    }

    candidates.sort((a, b) => b.mtime - a.mtime);

    // Walk candidates by mtime desc, parse + allowlist-filter as we go,
    // stop as soon as we have SURFACE_CAP valid entries. NO over-read cap —
    // the loop is bounded by SURFACE_CAP results (early exit) AND by the
    // total candidate set (typically a few hundred). Per-file work is a
    // single 4 KB read; total worst-case I/O ~MB-scale.
    const out: HistoryEntry[] = [];
    for (const c of candidates) {
      if (out.length >= SURFACE_CAP) break;
      const parsed = await this.parseClaudeFile(c.filePath);
      if (parsed === null) continue;
      const allowed = await this.opts.allowlistGate(parsed.cwd);
      if (!allowed) continue;
      const sid = basename(c.filePath, '.jsonl');
      this.filePathByKey.set(`claude:${sid}`, c.filePath);
      out.push({
        agent: 'claude',
        sessionId: sid,
        projectPath: parsed.cwd,
        mtime: c.mtime,
        firstPrompt: parsed.firstPrompt,
      });
    }
    return out;
  }

  private async scanCodex(): Promise<HistoryEntry[]> {
    const sessionsRoot = join(this.opts.homeDir, '.codex', 'sessions');
    const candidates: CandidateFile[] = [];

    try {
      const years = (await fsp.readdir(sessionsRoot, { withFileTypes: true })).filter((d) => d.isDirectory());
      for (const y of years) {
        const yPath = join(sessionsRoot, y.name);
        const months = (await fsp.readdir(yPath, { withFileTypes: true })).filter((d) => d.isDirectory());
        for (const m of months) {
          const mPath = join(yPath, m.name);
          const days = (await fsp.readdir(mPath, { withFileTypes: true })).filter((d) => d.isDirectory());
          for (const d of days) {
            const dPath = join(mPath, d.name);
            const files = (await fsp.readdir(dPath, { withFileTypes: true })).filter(
              (f) => f.isFile() && f.name.endsWith('.jsonl'),
            );
            for (const f of files) {
              const filePath = join(dPath, f.name);
              try {
                const stat = await fsp.stat(filePath);
                candidates.push({ filePath, mtime: stat.mtimeMs });
              } catch {
                // skip
              }
            }
          }
        }
      }
    } catch {
      return [];
    }

    candidates.sort((a, b) => b.mtime - a.mtime);

    const out: HistoryEntry[] = [];
    for (const c of candidates) {
      if (out.length >= SURFACE_CAP) break;
      const parsed = await this.parseCodexFile(c.filePath);
      if (parsed === null) continue;
      const allowed = await this.opts.allowlistGate(parsed.cwd);
      if (!allowed) continue;
      // Track filePath alongside the entry so resume-time validation can
      // re-stat the backing file. Stored in a side-channel map keyed by
      // (agent, sessionId) — see filePathFor() below.
      this.filePathByKey.set(`codex:${parsed.sessionId}`, c.filePath);
      out.push({
        agent: 'codex',
        sessionId: parsed.sessionId,
        projectPath: parsed.cwd,
        mtime: c.mtime,
        firstPrompt: parsed.firstPrompt,
      });
      if (out.length >= SURFACE_CAP) break;
    }
    return out;
  }

  private async parseClaudeFile(filePath: string): Promise<{ cwd: string; firstPrompt: string } | null> {
    let buf: Buffer;
    try {
      const fh = await fsp.open(filePath, 'r');
      try {
        const slice = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await fh.read(slice, 0, HEAD_BYTES, 0);
        buf = slice.slice(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
    const lines = buf.toString('utf-8').split('\n');
    let cwd: string | null = null;
    let firstPrompt = '';
    for (const line of lines) {
      if (line === '') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof obj !== 'object' || obj === null) continue;
      const o = obj as Record<string, unknown>;
      if (o.type === 'user' && typeof o.cwd === 'string') {
        cwd = o.cwd;
        const msg = o.message as { content?: unknown } | undefined;
        if (msg && typeof msg.content === 'string') {
          firstPrompt = msg.content.slice(0, PROMPT_TRUNCATE);
        } else if (Array.isArray(msg?.content)) {
          // Claude sometimes wraps content as [{ type: 'text', text: '...' }]
          const first = msg!.content.find((c: unknown) => typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text');
          if (first && typeof (first as { text?: unknown }).text === 'string') {
            firstPrompt = ((first as { text: string }).text).slice(0, PROMPT_TRUNCATE);
          }
        }
        break;
      }
    }
    if (cwd === null) return null;
    return { cwd, firstPrompt };
  }

  private async parseCodexFile(filePath: string): Promise<{ sessionId: string; cwd: string; firstPrompt: string } | null> {
    let buf: Buffer;
    try {
      const fh = await fsp.open(filePath, 'r');
      try {
        const slice = Buffer.alloc(FORWARD_SCAN_BYTES);
        const { bytesRead } = await fh.read(slice, 0, FORWARD_SCAN_BYTES, 0);
        buf = slice.slice(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
    const lines = buf.toString('utf-8').split('\n');
    let sessionId: string | null = null;
    let cwd: string | null = null;
    let firstPrompt = '';
    for (const line of lines) {
      if (line === '') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof obj !== 'object' || obj === null) continue;
      const o = obj as Record<string, unknown>;
      if (o.type === 'session_meta' && typeof o.payload === 'object' && o.payload !== null) {
        const p = o.payload as Record<string, unknown>;
        if (typeof p.id === 'string') sessionId = p.id;
        if (typeof p.cwd === 'string') cwd = p.cwd;
      }
      if (firstPrompt === '' && o.type === 'event_msg' && typeof o.payload === 'object' && o.payload !== null) {
        const p = o.payload as Record<string, unknown>;
        if (p.type === 'user_message' && typeof p.text === 'string') {
          firstPrompt = p.text.slice(0, PROMPT_TRUNCATE);
        }
      }
      if (sessionId !== null && cwd !== null && firstPrompt !== '') break;
    }
    if (sessionId === null || cwd === null) return null;
    return { sessionId, cwd, firstPrompt };
  }

  // (No internal isAllowed helper — the gate is invoked inline at the two
  // scan-loop sites via `await this.opts.allowlistGate(parsed.cwd)`. Single
  // SSOT for the security check; any future denylist tightening flows
  // through the injected gate from `fs-api.ts`.)
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run bridge:test -- history-scanner
```

Expected: 11 passed. (Ten test cases plus the one for malformed JSONL non-crash.)

- [ ] **Step 5: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add packages/bridge/src/history-scanner.ts packages/bridge/src/__tests__/history-scanner.test.ts
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(bridge): HistoryScanner reads native CLI history dirs with 60s cache"
```

---

## Task 4: Driver `cli_session_id_captured` events

**Files:**
- Modify: `packages/bridge/src/parser.ts` (extend Claude parser to emit `session_id` from system init events)
- Modify: `packages/bridge/src/codex-process.ts`
- Modify: `packages/bridge/src/claude-process.ts`
- Modify: `packages/bridge/src/__tests__/parser.test.ts` (test the new parser branch)
- Modify: `packages/bridge/src/__tests__/codex-process.test.ts` (or equivalent — see Step 1)
- Modify: `packages/bridge/src/__tests__/claude-process.test.ts`

**Important parser context** (read before editing):
- Codex parser (`codex-parser.ts`) ALREADY returns `{ kind: 'session_id'; id }` for lines shaped `{type:'session_init', session_id:'<uuid>'}`. No parser change needed for Codex.
- Claude parser (`parser.ts`) currently returns `null` for `type: 'system'` lines. We need to extend the return type to optionally yield `{ kind: 'session_id'; id }` for the system init line that carries Claude's `session_id`. This is the parser change in this task.

The drivers gain a single new EventEmitter event so the SessionManager can write CLI session ids into the registry. Pure additive change — existing event paths unchanged.

- [ ] **Step 1: Locate the existing parser-emit sites**

```bash
grep -n "session_id\|session_created\|emit\(" /Volumes/WDSSD/Code/mac-remote-terminal/packages/bridge/src/codex-process.ts | head -30
grep -n "session_id\|init\|emit\(" /Volumes/WDSSD/Code/mac-remote-terminal/packages/bridge/src/claude-process.ts | head -30
```

In codex-process.ts: existing branch `if ('id' in parsed) { this.codexSessionId = parsed.id; this.currentTurnSawSessionId = true; continue; }`. We add ONE line above the `continue`: `this.emit('cli_session_id', parsed.id);`. The existing `continue` skipping upstream emission of an `event` is preserved — `cli_session_id` is a separate channel.

In claude-process.ts: when the parser returns the `system` event with subtype `init` (or however the existing impl tags it), there's a property carrying Claude's `session_id`. Add an emit on that branch.

Both drivers extend `EventEmitter` (per `AgentDriver` interface in session.ts). Add a TS overload so the new event name is type-checked.

- [ ] **Step 2: Append a failing test to `packages/bridge/src/__tests__/codex-process.test.ts`** (or the file that owns codex-process.ts coverage)

```ts
// Inside the existing describe('CodexDriver', ...) block (or top-level):

it('emits cli_session_id when codex parser yields a session_init line', async () => {
  // Codex parser (codex-parser.ts) reads `{type:'session_init', session_id:'<uuid>'}`
  // and returns `{ kind: 'session_id', id }`. The driver code-path that branches
  // on `'id' in parsed` (codex-process.ts:128) is what we add the new emit to.
  const driver = makeCodexDriver(/* whatever args the existing tests use */);
  const captured: string[] = [];
  driver.on('cli_session_id', (id: string) => { captured.push(id); });

  await feedStdout(driver, JSON.stringify({ type: 'session_init', session_id: 'codex-uuid-aaa' }) + '\n');

  expect(captured).toEqual(['codex-uuid-aaa']);
});

it('emits cli_session_id only ONCE per driver lifetime even if session_init line repeats', async () => {
  const driver = makeCodexDriver(/* ... */);
  const captured: string[] = [];
  driver.on('cli_session_id', (id: string) => { captured.push(id); });

  await feedStdout(driver, JSON.stringify({ type: 'session_init', session_id: 'codex-uuid-aaa' }) + '\n');
  await feedStdout(driver, JSON.stringify({ type: 'session_init', session_id: 'codex-uuid-bbb' }) + '\n');

  expect(captured).toEqual(['codex-uuid-aaa']);
});
```

If `makeCodexDriver` and `feedStdout` helpers don't exist in the existing test file, model after the harness pattern in the existing tests and inline the equivalent setup. Read the existing `codex-process.test.ts` to find the pattern (likely `new CodexDriver({...})` + `driver.process.stdout.emit('data', Buffer.from(line))`).

Append an analogous test pair to `claude-process.test.ts` for Claude's init event:

```ts
it('emits cli_session_id when Claude system init event arrives (relies on Step 5a parser change)', async () => {
  const driver = makeClaudeDriver(/* ... */);
  const captured: string[] = [];
  driver.on('cli_session_id', (id: string) => { captured.push(id); });

  // Claude's `--output-format stream-json` init line. The exact field path
  // may need adjustment — verify against an actual Claude init line in the
  // project's existing fixtures.
  await feedStdout(driver, JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'claude-uuid-xyz',
  }) + '\n');

  expect(captured).toEqual(['claude-uuid-xyz']);
});

it('emits cli_session_id only ONCE per Claude driver lifetime', async () => {
  const driver = makeClaudeDriver(/* ... */);
  const captured: string[] = [];
  driver.on('cli_session_id', (id: string) => { captured.push(id); });

  await feedStdout(driver, JSON.stringify({ type: 'system', subtype: 'init', session_id: 'a' }) + '\n');
  await feedStdout(driver, JSON.stringify({ type: 'system', subtype: 'init', session_id: 'b' }) + '\n');

  expect(captured).toEqual(['a']);
});
```

- [ ] **Step 3: Run tests — expect FAIL**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run bridge:test -- codex-process claude-process
```

Expected: 4 new failures (events not emitted yet).

- [ ] **Step 4: Implement codex-process.ts addition**

Locate the existing `if ('id' in parsed) { ... }` branch (around line 128 in current code). It looks like:

```ts
if ('id' in parsed) {
  // session_id capture — store but do NOT emit upstream.
  this.codexSessionId = parsed.id;
  this.currentTurnSawSessionId = true;
  continue;
}
```

Augment to:

```ts
if ('id' in parsed) {
  // session_id capture — store + emit (Phase 5: SessionManager listens).
  // Idempotent: only emit once per driver lifetime.
  if (this.codexSessionId === null) {
    this.emit('cli_session_id', parsed.id);
  }
  this.codexSessionId = parsed.id;
  this.currentTurnSawSessionId = true;
  continue;
}
```

The `if (this.codexSessionId === null)` guard ensures the second test (idempotent emission) passes. Existing `continue` preserves the no-upstream-event-emit behavior for downstream consumers.

- [ ] **Step 5a: Extend `parser.ts` to surface Claude session id**

Current shape (parser.ts:70-71):
```ts
case 'system':
  return null;
```

Update the `AgentEvent` / parser return type to include a session-id discriminant alongside the existing event kinds, mirroring `codex-parser.ts:18`'s `CodexParseResult` pattern. Approach: keep `AgentEvent` unchanged but widen the parser's return type to `AgentEvent | { kind: 'session_id'; id: string } | null`. Then:

```ts
case 'system': {
  // Claude's `--output-format stream-json` system init line carries
  // `session_id`; surface it as a typed result for the driver to capture.
  if (
    typeof raw.subtype === 'string' &&
    raw.subtype === 'init' &&
    typeof raw.session_id === 'string'
  ) {
    return { kind: 'session_id', id: raw.session_id };
  }
  return null;
}
```

The exact field path (`subtype === 'init'`, `session_id`) should be verified against an actual Claude init line in the project's existing fixtures or by running `claude -p --output-format stream-json` once. Adapt accordingly.

Add a parser test in `packages/bridge/src/__tests__/parser.test.ts`:

```ts
it('returns session_id discriminant for Claude system init line', () => {
  const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-uuid-xyz' });
  const ev = parseClaudeLine(line);
  expect(ev).toEqual({ kind: 'session_id', id: 'claude-uuid-xyz' });
});
```

- [ ] **Step 5b: Implement claude-process.ts addition**

Locate where `parseClaudeLine()` is called and its result is dispatched (likely a switch on `parsed.kind`). Add a new branch BEFORE the existing kind-handling that captures `session_id`:

```ts
const parsed = parseClaudeLine(line);
if (parsed === null) continue;

if (parsed.kind === 'session_id') {
  if (!this.claudeSessionIdEmitted) {
    this.emit('cli_session_id', parsed.id);
    this.claudeSessionIdEmitted = true;
  }
  continue; // do NOT pass through to the upstream `event` channel
}

// ... existing kind-dispatch code (assistant_text, stream_delta, tool_use, ...)
```

Add `private claudeSessionIdEmitted = false;` as a class field (mirrors the codex driver's pattern).

The contract: emit exactly once per driver lifetime when Claude's session id first becomes known, regardless of how many init lines arrive.

- [ ] **Step 6: Run tests — expect PASS**

```bash
npm run bridge:test -- codex-process claude-process
```

Expected: 4 new tests pass; existing tests unaffected.

- [ ] **Step 7: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add packages/bridge/src/parser.ts packages/bridge/src/__tests__/parser.test.ts packages/bridge/src/codex-process.ts packages/bridge/src/claude-process.ts packages/bridge/src/__tests__/codex-process.test.ts packages/bridge/src/__tests__/claude-process.test.ts
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(bridge): parser emits session_id; drivers emit cli_session_id (idempotent)"
```

---

## Task 5: `SessionManager.resume(webSessionId)` + registry integration

**Files:**
- Modify: `packages/bridge/src/session.ts`
- Modify: `packages/bridge/src/claude-process.ts` (driver constructor accepts `resumeArgs`)
- Modify: `packages/bridge/src/codex-process.ts` (driver constructor accepts `codexResumeSeed`)
- Modify: `packages/bridge/src/__tests__/session.test.ts`

`SessionManager` gains: (a) `resume()` method, (b) up-front registry-entry creation on every fresh session spawn, (c) subscription to driver `cli_session_id` events that calls `sessionRegistry.update()`.

- [ ] **Step 1: Read existing SessionManager to find integration points**

```bash
grep -n "constructor\|spawnSession\|addSession\|class\|emit\(" /Volumes/WDSSD/Code/mac-remote-terminal/packages/bridge/src/session.ts | head -40
```

Identify (a) the method that creates a fresh session (likely `spawnSession()` or similar — emits a `session_created` event), (b) where driver events are subscribed.

- [ ] **Step 2: Append failing tests to `packages/bridge/src/__tests__/session.test.ts`**

Inside the existing `describe('SessionManager', ...)`:

```ts
it('resume(webSessionId) for Claude spawns claude --resume <claudeId> with cwd=projectPath', async () => {
  const mgr = makeMgr(/* whatever helpers tests use */);
  const spawned: { cmd: string; args: string[]; cwd: string }[] = [];
  // Inject a spawn spy via the existing test seam (look at how spawnSession
  // is mocked in current tests). If no seam exists, mock node:child_process
  // directly.

  // Pre-populate registry as if a Claude session existed and died.
  await mgr.registry.add({
    webSessionId: 'web-1',
    agent: 'claude',
    projectPath: '/tmp/proj',
    transcriptPath: '.bridge/transcripts/web-1.jsonl',
    claudeSessionId: 'claude-uuid-1',
    codexSessionId: null,
    createdAt: 0,
    account: null,
  });

  await mgr.resume('web-1');

  expect(spawned).toHaveLength(1);
  expect(spawned[0]!.cmd).toBe('claude');
  expect(spawned[0]!.args).toContain('--resume');
  expect(spawned[0]!.args).toContain('claude-uuid-1');
  expect(spawned[0]!.cwd).toBe('/tmp/proj');
});

it('resume(webSessionId) for Codex re-instantiates driver seeded with codexSessionId; spawn defers to send_text', async () => {
  const mgr = makeMgr(/* ... */);
  await mgr.registry.add({
    webSessionId: 'web-2',
    agent: 'codex',
    projectPath: '/tmp/proj',
    transcriptPath: '.bridge/transcripts/web-2.jsonl',
    claudeSessionId: null,
    codexSessionId: 'codex-uuid-2',
    createdAt: 0,
    account: 'default',
  });

  await mgr.resume('web-2');

  // Driver instance exists with the seeded id; no spawn yet (Codex spawns per-turn).
  const session = mgr.getSession('web-2');
  expect(session?.alive).toBe(true);
  expect(/* whatever way to inspect driver state — e.g. */ (session?.driver as unknown as { codexSessionId?: string }).codexSessionId).toBe('codex-uuid-2');
});

it('resume rejects with cli_session_id_unknown when registry entry has null cliSessionId', async () => {
  const mgr = makeMgr(/* ... */);
  await mgr.registry.add({
    webSessionId: 'web-3',
    agent: 'claude',
    projectPath: '/tmp/proj',
    transcriptPath: '.bridge/transcripts/web-3.jsonl',
    claudeSessionId: null,
    codexSessionId: null,
    createdAt: 0,
    account: null,
  });
  await expect(mgr.resume('web-3')).rejects.toMatchObject({ code: 'cli_session_id_unknown' });
});

it('resume rejects with project_path_missing when projectPath does not exist on disk', async () => {
  const mgr = makeMgr(/* ... */);
  await mgr.registry.add({
    webSessionId: 'web-4',
    agent: 'claude',
    projectPath: '/nonexistent/path',
    transcriptPath: '.bridge/transcripts/web-4.jsonl',
    claudeSessionId: 'claude-uuid-4',
    codexSessionId: null,
    createdAt: 0,
    account: null,
  });
  await expect(mgr.resume('web-4')).rejects.toMatchObject({ code: 'project_path_missing' });
});

it('resume rejects with project_path_disallowed when projectPath is outside allowlist', async () => {
  // Set up a registry entry whose projectPath was once valid but now isn't.
  const mgr = makeMgr({ allowedDirs: ['/tmp/allowed'] });
  await mgr.registry.add({
    webSessionId: 'web-5',
    agent: 'claude',
    projectPath: '/tmp/disallowed',
    transcriptPath: '.bridge/transcripts/web-5.jsonl',
    claudeSessionId: 'claude-uuid-5',
    codexSessionId: null,
    createdAt: 0,
    account: null,
  });
  // Make /tmp/disallowed exist so we hit the allowlist check, not the missing check.
  await fsp.mkdir('/tmp/disallowed', { recursive: true });
  await expect(mgr.resume('web-5')).rejects.toMatchObject({ code: 'project_path_disallowed' });
});

it('concurrent resume() calls dedup — second returns the first promise', async () => {
  const mgr = makeMgr(/* ... */);
  await mgr.registry.add({
    webSessionId: 'web-6',
    agent: 'claude',
    projectPath: '/tmp/proj',
    transcriptPath: '.bridge/transcripts/web-6.jsonl',
    claudeSessionId: 'claude-uuid-6',
    codexSessionId: null,
    createdAt: 0,
    account: null,
  });
  const a = mgr.resume('web-6');
  const b = mgr.resume('web-6');
  await Promise.all([a, b]);
  // Spawn count should be 1, not 2.
  expect(mgr.spawnCallCount).toBe(1);
});

it('resume rejects with claude_resume_rejected when claude --resume exits non-zero with rejection-shaped stderr', async () => {
  const mgr = makeMgr({ /* mock spawn to produce immediate exit-with-stderr "No conversation found with session ID <id>" */ });
  await mgr.registry.add({
    webSessionId: 'web-7',
    agent: 'claude',
    projectPath: '/tmp/proj',
    transcriptPath: '.bridge/transcripts/web-7.jsonl',
    claudeSessionId: 'stale-claude-id',
    codexSessionId: null,
    createdAt: 0,
    account: null,
  });
  await expect(mgr.resume('web-7')).rejects.toMatchObject({ code: 'claude_resume_rejected' });
});

it('resume succeeds for codex even though spawn defers; codex_resume_rejected surfaces on first send_text not on resume()', async () => {
  // resume() itself does NOT spawn Codex; the rejection (if any) appears
  // when the user sends their first message after resume. The test asserts:
  //   - resume() resolves cleanly even with a stale codexSessionId.
  //   - First send_text triggers `codex exec resume <id>`, which (in this
  //     mocked test) exits non-zero, and the existing Phase 2 turn-error
  //     broadcast is amended to use 'codex_resume_rejected' code.
  const mgr = makeMgr({ /* mock codex to fail the resume turn */ });
  await mgr.registry.add({
    webSessionId: 'web-8',
    agent: 'codex',
    projectPath: '/tmp/proj',
    transcriptPath: '.bridge/transcripts/web-8.jsonl',
    claudeSessionId: null,
    codexSessionId: 'stale-codex-id',
    createdAt: 0,
    account: 'default',
  });
  await mgr.resume('web-8'); // succeeds
  // Now send_text and expect the broadcast.
  const sentErrors: { code: string }[] = [];
  mgr.on('session_error', (e: { code: string }) => sentErrors.push(e));
  await mgr.sendText('web-8', 'hello after stale resume');
  expect(sentErrors.some((e) => e.code === 'codex_resume_rejected')).toBe(true);
});

it('on driver cli_session_id event, registry entry is updated', async () => {
  const mgr = makeMgr(/* ... */);
  // Spawn a fresh session (existing behavior — ensure registry entry created up-front).
  const session = await mgr.spawnSession({ agent: 'claude', projectPath: '/tmp/proj' });
  // Simulate driver emitting cli_session_id.
  session.driver.emit('cli_session_id', 'fresh-claude-uuid');
  // Allow the async registry.update() to settle.
  await new Promise((r) => setImmediate(r));
  expect(mgr.registry.get(session.webSessionId)?.claudeSessionId).toBe('fresh-claude-uuid');
});
```

The exact harness signatures (`makeMgr`, `mgr.spawnCallCount`, etc.) depend on the existing `session.test.ts` patterns. Read that file and adapt.

- [ ] **Step 3: Run tests — expect FAIL**

```bash
npm run bridge:test -- session
```

Expected: 7 new failures.

- [ ] **Step 4: Implement SessionManager changes**

Inside `packages/bridge/src/session.ts`, locate the `SessionManager` class. Add:

```ts
import type { SessionRegistry } from './session-registry.js';

// Add to SessionManagerOpts:
// registry: SessionRegistry;
// (And inject through the constructor — adjust DI as the existing code does it.)

// Inside the class:

private resumeInFlight = new Map<string, Promise<void>>();

/**
 * Resume a previously-known dead session. Looks up the registry entry,
 * validates path + cliSessionId presence, then spawns Claude with --resume
 * or re-instantiates the Codex driver seeded with codexSessionId.
 */
async resume(webSessionId: string): Promise<void> {
  // Concurrent-resume dedup
  const existing = this.resumeInFlight.get(webSessionId);
  if (existing) return existing;

  const promise = this.doResume(webSessionId);
  this.resumeInFlight.set(webSessionId, promise);
  try {
    await promise;
  } finally {
    this.resumeInFlight.delete(webSessionId);
  }
}

private async doResume(webSessionId: string): Promise<void> {
  const entry = this.registry.get(webSessionId);
  if (!entry) {
    throw Object.assign(new Error('Unknown webSessionId'), { code: 'history_session_not_found' });
  }
  const cliId = entry.agent === 'claude' ? entry.claudeSessionId : entry.codexSessionId;
  if (cliId === null) {
    throw Object.assign(new Error('Bridge never captured the CLI session id for this entry'), {
      code: 'cli_session_id_unknown',
    });
  }
  // Path existence check.
  try {
    const stat = await fsp.stat(entry.projectPath);
    if (!stat.isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw Object.assign(new Error(`Project path no longer exists: ${entry.projectPath}`), {
      code: 'project_path_missing',
    });
  }
  // Allowlist re-check (allowlist may have tightened since entry was created).
  if (!this.isAllowedDir(entry.projectPath)) {
    throw Object.assign(new Error('Project path is not in BRIDGE_ALLOWED_DIRS'), {
      code: 'project_path_disallowed',
    });
  }

  // Per-agent resume.
  if (entry.agent === 'claude') {
    await this.spawnClaudeWithResume(entry, cliId);
  } else {
    this.instantiateCodexWithResumeSeed(entry, cliId);
  }
}

/**
 * Native-history first-resume entry point. Called by the WS handler with a
 * verified HistoryEntry (scanner.findEntry already returned non-undefined).
 * Issues a new webSessionId, persists registry, then runs the same per-agent
 * spawn/instantiate logic as Path 1.
 *
 * Returns the new webSessionId so the WS handler can include it in
 * session_resumed.
 */
async resumeFromHistoryEntry(entry: { agent: 'claude' | 'codex'; sessionId: string; projectPath: string }, accountName: string | null): Promise<string> {
  // Re-validate ground-truth cwd (the scanner already checked it, but
  // allowlist may have tightened between scan and call).
  // Use the existing private isAllowedDir / equivalent helper.
  if (!(await this.isAllowedProjectPath(entry.projectPath))) {
    throw Object.assign(new Error('Project path is not in BRIDGE_ALLOWED_DIRS'), {
      code: 'project_path_disallowed',
    });
  }
  const webSessionId = this.mintWebSessionId();
  const transcriptPath = this.transcriptPathFor(webSessionId);
  await this.registry.add({
    webSessionId,
    agent: entry.agent,
    projectPath: entry.projectPath,
    transcriptPath,
    claudeSessionId: entry.agent === 'claude' ? entry.sessionId : null,
    codexSessionId: entry.agent === 'codex' ? entry.sessionId : null,
    createdAt: Date.now(),
    account: accountName,
  });
  // Reuse the Path 1 logic.
  await this.resume(webSessionId);
  return webSessionId;
}

/**
 * Helper accessors that wrap existing private state. They exist so the
 * WS handler doesn't reach into private fields.
 *
 * Implementer task: bind these to whatever the existing SessionManager
 * already does internally — minting an id (existing spawnSession likely
 * uses crypto.randomUUID()), computing the transcript path (existing
 * code joins .bridge/transcripts/<id>.jsonl), and the allowlist check
 * (existing code likely uses fs-api.isProjectPathAllowed).
 */
private mintWebSessionId(): string {
  return crypto.randomUUID(); // or whatever the existing spawnSession() uses
}

private transcriptPathFor(webSessionId: string): string {
  return join('.bridge', 'transcripts', `${webSessionId}.jsonl`);
}

private async isAllowedProjectPath(_cwd: string): Promise<boolean> {
  // Wrap the same fs-api gate the rest of the project uses.
  // Returns true iff the cwd passes allowlist + denylist.
  return true; // implementer fills in
}

private async spawnClaudeWithResume(entry: RegistryEntry, claudeSessionId: string): Promise<void> {
  // Use the same factory the existing initial-spawn path uses, but pass --resume.
  // Distinguish two failure modes:
  //   - Spawn outright fails (binary not on PATH, fork error)        → resume_spawn_failed
  //   - Process exits non-zero with stderr containing the substring  → claude_resume_rejected
  //     "session" + "not found" / "unknown" / "invalid" (pattern match
  //     to recognize "Claude does not recognize session <id>" -style errors)
  let session: AgentDriver;
  try {
    session = await this.driverFactory({
      agent: 'claude',
      projectPath: entry.projectPath,
      account: this.resolveAccount(entry.agent, entry.account ?? undefined),
      resumeArgs: ['--resume', claudeSessionId],
    });
  } catch (err) {
    throw Object.assign(new Error(`Spawn failed: ${(err as Error).message}`), {
      code: 'resume_spawn_failed',
    });
  }
  // Watch for an immediate exit-with-rejection during the first event window.
  // The driver emits 'exit' or 'error' if Claude rejects --resume <id>.
  const earlyExit = await this.waitForEarlyExitOrSettle(session, /* ms */ 1500);
  if (earlyExit !== null && this.isClaudeResumeRejection(earlyExit.stderr)) {
    throw Object.assign(new Error(earlyExit.stderr || 'claude rejected resume'), {
      code: 'claude_resume_rejected',
    });
  }
  if (earlyExit !== null) {
    // Non-rejection exit (e.g. permission error, segfault). Treat as generic.
    throw Object.assign(new Error(earlyExit.stderr || `exit ${earlyExit.code}`), {
      code: 'resume_spawn_failed',
    });
  }
  this.attachSession(entry.webSessionId, session, entry);
}

/**
 * Wait briefly to see if the driver's child exits before any user input is sent.
 * Returns null if the driver settles into a normal running state.
 * Implementation note: hook into the existing exit/error events the driver
 * already emits in Phase 1/2; collect stderr from the existing channel.
 */
private waitForEarlyExitOrSettle(_driver: AgentDriver, _timeoutMs: number): Promise<null | { code: number; stderr: string }> {
  // Adapt to the existing AgentDriver event surface — the bridge already
  // tracks `exit` events with code + accumulated stderr. The contract is
  // resolve(null) if the driver is alive past `timeoutMs`, else resolve
  // with the exit metadata.
  return Promise.resolve(null); // implementer fills in real wiring
}

private isClaudeResumeRejection(stderr: string): boolean {
  // Claude's actual stderr text on `--resume <missing-id>` is something like:
  //   "Error: No conversation found with session ID <id>"
  // or:
  //   "Session not found"
  // Substring match across known phrasings.
  const patterns = [/no conversation found/i, /session not found/i, /unknown session/i, /invalid session/i];
  return patterns.some((p) => p.test(stderr));
}

private instantiateCodexWithResumeSeed(entry: RegistryEntry, codexSessionId: string): void {
  // Codex is spawn-per-turn; we instantiate the driver but don't spawn.
  // Resume rejection (codex_resume_rejected) cannot fire here — it can only
  // surface when the user's first send_text after resume invokes
  // `codex exec resume <id>` and Codex exits non-zero. The CodexDriver's
  // existing turn-error event path is responsible for emitting that error
  // via the standard error broadcast (see Phase 2 spec). This task does NOT
  // change the existing turn-error path; the new error code is added to the
  // typed union in Task 1, and the existing code that produces a typed
  // turn-failure reply is updated to use 'codex_resume_rejected' when the
  // current turn was a resume attempt (i.e. driver.codexSessionId was
  // already populated at turn start AND the turn failed). One-line check
  // in the existing turn-error code path.
  const session = this.driverFactory({
    agent: 'codex',
    projectPath: entry.projectPath,
    account: this.resolveAccount(entry.agent, entry.account ?? undefined),
    codexResumeSeed: codexSessionId,
  });
  this.attachSession(entry.webSessionId, session, entry);
}

/**
 * After a successful resume (Path 1 OR Path 2), emit a synthesized
 * `system: session_created` lifecycle event so the web sessions store
 * creates / refreshes the SessionView. This matters most for Path 2
 * (native-history first-resume): the bridge issues a brand-new
 * webSessionId, and without this synthesized event the web has no
 * SessionView for that id when the user's resume_session reply arrives,
 * causing the route to show "session not found".
 *
 * For Claude resumes the parser will ALSO emit Claude's own system init
 * event when the spawned process publishes it — that's a second
 * session_created from the parser path. The web reducer is idempotent
 * (existing Phase 1 behavior: re-applying session_created with the same
 * sessionId is a no-op merge of fields). For Codex resumes, the spawn
 * doesn't fire until first send, so this synthesized event is the ONLY
 * way the web learns about the new session for native-history Codex.
 */
private emitSynthesizedSessionCreated(webSessionId: string, entry: RegistryEntry): void {
  // Route through the SAME existing private helper that fresh-spawn uses.
  // Per packages/bridge/src/session.ts:261, the helper signature is:
  //
  //   private appendAndBroadcast(s: InternalSession, msg: ServerLifecycleMsg | ServerStreamMsg): void
  //
  // The helper handles ring buffer, transcript append, and socket broadcast;
  // the CALLER provides the fully-formed msg including `sessionId` and `seq`
  // (the existing fresh-spawn flow at session.ts:174 does `seq: internal.nextSeq++`).
  //
  // Look up the InternalSession we just registered:
  const s = this.sessions.get(webSessionId);
  if (!s) {
    // Should never happen — we just registered it. Treat as bug.
    throw new Error(`emitSynthesizedSessionCreated: missing InternalSession ${webSessionId}`);
  }
  this.appendAndBroadcast(s, {
    type: 'system',
    event: 'session_created',
    sessionId: webSessionId,
    seq: s.nextSeq++,
    agent: entry.agent,
    projectPath: entry.projectPath,
    createdAt: entry.createdAt,
    ...(entry.account ? { account: entry.account } : {}),
  });
}

private attachSession(webSessionId: string, session: AgentDriver, entry: RegistryEntry): void {
  // The in-memory session shape is `InternalSession` (sessionId/proc/buffer/nextSeq
  // + alive flag), NOT the registry-entry shape. Reuse the SAME helper the
  // existing fresh-spawn path already calls to insert a new driver into
  // `this.sessions` — likely `this.registerInternalSession(...)` or whatever
  // the existing `spawnSession()` factory uses. The contract: subsequent
  // driver events flow into the same webSessionId ring buffer + transcript
  // file. Read the existing `session.ts` to find that helper and call it
  // here with the resumed driver.
  //
  // Subscribe to cli_session_id for registry update:
  session.on('cli_session_id', async (id: string) => {
    const patch = entry.agent === 'claude' ? { claudeSessionId: id } : { codexSessionId: id };
    await this.registry.update(webSessionId, patch);
  });
  // Insert into the in-memory session map using whatever existing helper
  // does this on fresh spawn. (Pseudocode — adapt to your real helper.)
  this.registerInternalSession(webSessionId, session, entry);
  // Synthesize the session_created lifecycle event so the web learns about
  // the new webSessionId (critical for Path 2 — native-history first-resume).
  this.emitSynthesizedSessionCreated(webSessionId, entry);
  this.emit('session_resumed', { webSessionId, alive: true });
}

/**
 * Wraps the existing fresh-spawn registration logic. The fresh-spawn flow
 * already does this — extract the shared steps into a helper and call it
 * from BOTH the spawn path and the resume path. Steps the existing flow
 * already performs:
 *   1. Build the InternalSession shape (sessionId, proc, buffer, nextSeq, alive)
 *   2. Insert into `this.sessions` map
 *   3. Wire driver event handlers (`event`, `exit`, etc.) for transcript writes
 *      and ring-buffer broadcast
 *   4. Mark alive
 * The implementer's task is to refactor whatever existing function does this
 * into a shared private helper, not duplicate the wiring inline.
 */
private registerInternalSession(_webSessionId: string, _driver: AgentDriver, _entry: RegistryEntry): void {
  // implementer extracts from existing spawnSession() body
}
```

Also: extend the existing fresh-session-spawn flow (`spawnSession()` or equivalent) to:
1. Create a registry entry up-front BEFORE spawn:
   ```ts
   await this.registry.add({
     webSessionId, agent, projectPath, transcriptPath,
     claudeSessionId: null, codexSessionId: null,
     createdAt: Date.now(), account,
   });
   ```
2. Subscribe the driver's `cli_session_id` event for registry update (same handler as `attachSession` above — refactor into a shared helper if cleaner).

The `driverFactory` interface needs to accept `resumeArgs` and `codexResumeSeed`. Adjust both Claude and Codex driver constructors to honor those (Claude: prepend resumeArgs to its arg list; Codex: pre-populate `this.codexSessionId`).

- [ ] **Step 5: Run tests — expect PASS**

```bash
npm run bridge:test -- session
```

Expected: 7 new tests pass; existing tests still pass.

**Driver constructor changes (required for the SessionManager test seam to work):**

In `packages/bridge/src/claude-process.ts`, extend the constructor options:

```ts
interface ClaudeDriverOpts {
  // ... existing fields
  /** When set, the spawn args are prepended with these tokens (e.g. ['--resume', '<id>']). */
  resumeArgs?: string[];
}
```

In the spawn-arg construction inside the driver, prepend `opts.resumeArgs ?? []` to the existing args list before `-p --dangerously-skip-permissions ...`.

In `packages/bridge/src/codex-process.ts`, extend the constructor options:

```ts
interface CodexDriverOpts {
  // ... existing fields
  /** When set, pre-populates this.codexSessionId so the next sendUserText invokes `codex exec resume`. */
  codexResumeSeed?: string;
}
```

In the constructor body, after existing init: `if (opts.codexResumeSeed) this.codexSessionId = opts.codexResumeSeed;`. The existing `codexSessionId === null` guard in sendUserText (which decides whether to use `exec` or `exec resume`) then naturally picks the resume path on first turn.

- [ ] **Step 6: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add packages/bridge/src/session.ts packages/bridge/src/claude-process.ts packages/bridge/src/codex-process.ts packages/bridge/src/__tests__/session.test.ts
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(bridge): SessionManager.resume() + driver resumeArgs/codexResumeSeed + registry integration"
```

---

## Task 6: WS handlers — `list_history` + `resume_session`

**Files:**
- Modify: `packages/bridge/src/websocket.ts`
- Modify: `packages/bridge/src/__tests__/websocket.test.ts`

The bridge WS layer gains two new client message handlers. Both reply over the same socket with the typed message shape from Task 1.

- [ ] **Step 1: Append failing tests**

Inside `packages/bridge/src/__tests__/websocket.test.ts` (mirror the existing test patterns):

```ts
it('list_history scans + replies history_list once; subsequent calls < 60s use cache', async () => {
  // Set up a temp filesystem with one Claude file + one Codex file.
  // (Reuse the harness pattern from history-scanner.test.ts.)
  // ...
  const correlationId = 'cid-1';
  const reply = await sendAndAwait(sock, { type: 'list_history', correlationId });
  expect(reply.type).toBe('history_list');
  expect(reply.correlationId).toBe(correlationId);
  expect(Array.isArray(reply.claude)).toBe(true);
  expect(Array.isArray(reply.codex)).toBe(true);

  const reply2 = await sendAndAwait(sock, { type: 'list_history', correlationId: 'cid-2' });
  expect(reply2.claude).toEqual(reply.claude); // cache hit
});

it('resume_session (Path 1: bridge-known) replies session_resumed with same webSessionId', async () => {
  // Pre-populate registry with a Claude entry (bridge-known dead session).
  // Spawn factory should be mocked to succeed.
  // ...
  const reply = await sendAndAwait(sock, {
    type: 'resume_session',
    webSessionId: 'web-1',
    correlationId: 'cid-3',
  });
  expect(reply.type).toBe('session_resumed');
  expect(reply.webSessionId).toBe('web-1');
  expect(reply.alive).toBe(true);
});

it('resume_session (Path 2: native history) replies session_resumed with NEW webSessionId', async () => {
  // Set up filesystem with a Codex history entry; allowlist includes its cwd.
  // ...
  const reply = await sendAndAwait(sock, {
    type: 'resume_session',
    agent: 'codex',
    sessionId: 'codex-uuid-known',
    projectPath: '/tmp/allowed-codex',
    correlationId: 'cid-4',
  });
  expect(reply.type).toBe('session_resumed');
  expect(typeof reply.webSessionId).toBe('string');
  expect(reply.webSessionId.length).toBeGreaterThan(0);
});

it('resume_session (Path 2) replies error history_session_not_found when sessionId not in scanner', async () => {
  const reply = await sendAndAwait(sock, {
    type: 'resume_session',
    agent: 'claude',
    sessionId: 'never-existed',
    projectPath: '/tmp/allowed',
    correlationId: 'cid-5',
  });
  expect(reply.type).toBe('error');
  expect(reply.code).toBe('history_session_not_found');
});

it('resume_session (Path 2) ground-truth cwd overrides client-supplied projectPath', async () => {
  // Real cwd = '/tmp/allowed-real'; client supplies '/tmp/allowed-fake' which
  // differs. Bridge should spawn under the real cwd.
  // ... (assert via the spawn spy used in session tests)
});

it('resume_session (Path 2) rejects when ground-truth cwd is outside allowlist', async () => {
  // Set up filesystem entry with cwd outside allowlist; client tries to resume.
  const reply = await sendAndAwait(sock, {
    type: 'resume_session',
    agent: 'claude',
    sessionId: 'forbidden-uuid',
    projectPath: '/tmp/allowed',  // client lies about path
    correlationId: 'cid-6',
  });
  expect(reply.type).toBe('error');
  expect(reply.code).toBe('project_path_disallowed');
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run bridge:test -- websocket
```

Expected: 6 new failures.

- [ ] **Step 3: Implement WS handlers**

`packages/bridge/src/websocket.ts` is function-based, not class-based. The structure is:
- `interface AttachWsOpts { ... }` — public DI surface (around line 22)
- `export function attachWebSocket(opts)` — wires up the WS server
- `async function handleMessage(ws, raw, sessionManager, send, accounts, promptStore, fsApi, imageStore)` — internal dispatcher

To add Phase 5 handlers:

1. Add `historyScanner: HistoryScanner;` to `AttachWsOpts`.
2. Add a `historyScanner` parameter to `handleMessage` and pass it through from `attachWebSocket` (around line 73 — adjust the existing `void handleMessage(ws, raw, opts.sessionManager, ...)` call to also pass `opts.historyScanner`).
3. Inside `handleMessage`, add the two new arms to the existing message-dispatch switch:

```ts
case 'list_history': {
  try {
    const result = await opts.historyScanner.list();
    send(ws, {
      type: 'history_list',
      claude: result.claude,
      codex: result.codex,
      correlationId: msg.correlationId,
    });
  } catch (err) {
    send(ws, {
      type: 'error',
      code: 'resume_spawn_failed', // or invent a list_history_failed if you prefer
      message: (err as Error).message,
      correlationId: msg.correlationId,
    });
  }
  break;
}

case 'resume_session': {
  // websocket.ts is function-based: `opts` is AttachWsOpts (extend it to
  // include `historyScanner`); `send` is the local helper passed into
  // handleMessage; `mgr` is the local alias for opts.sessionManager (or
  // call opts.sessionManager directly).
  try {
    let webSessionId: string;
    if ('webSessionId' in msg) {
      // Path 1: bridge-known. SessionManager.resume() looks up registry,
      // re-validates path, spawns Claude / re-instantiates Codex driver.
      webSessionId = msg.webSessionId;
      await opts.sessionManager.resume(webSessionId);
    } else {
      // Path 2: native history first-resume. Verify the (agent, sessionId)
      // pair via the scanner cache + re-stat the backing file. The scanner
      // returns undefined if either lookup fails.
      const entry = await opts.historyScanner.findEntry(msg.agent, msg.sessionId);
      if (!entry) {
        send(ws, {
          type: 'error',
          code: 'history_session_not_found',
          message: `No history session found for ${msg.agent}:${msg.sessionId}`,
          correlationId: msg.correlationId,
        });
        return;
      }
      // SessionManager.resumeFromHistoryEntry() handles allowlist re-check,
      // webSessionId minting, registry add, and Path 1 spawn/instantiate.
      webSessionId = await opts.sessionManager.resumeFromHistoryEntry(entry, msg.account ?? null);
      opts.historyScanner.invalidateCache();
    }
    send(ws, {
      type: 'session_resumed',
      webSessionId,
      alive: true,
      correlationId: msg.correlationId,
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'resume_spawn_failed';
    // exactOptionalPropertyTypes-safe: conditional spread instead of
    // `sessionId: undefined`.
    send(ws, {
      type: 'error',
      code: code as never,
      message: (err as Error).message,
      correlationId: msg.correlationId,
      ...('webSessionId' in msg ? { sessionId: msg.webSessionId } : {}),
    });
  }
  break;
}
```

The `code as never` cast is needed because TS can't statically verify the runtime-thrown `code` matches the declared union; runtime correctness is guaranteed by the throws in `SessionManager.doResume()`.

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm run bridge:test -- websocket
```

Expected: 6 new tests pass.

- [ ] **Step 5: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add packages/bridge/src/websocket.ts packages/bridge/src/__tests__/websocket.test.ts
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(bridge): WS list_history + resume_session handlers"
```

---

## Task 7: Bridge boot wiring

**Files:**
- Modify: `packages/bridge/src/index.ts`

The bridge entrypoint instantiates `SessionRegistry` + `HistoryScanner`, awaits `registry.load()`, and threads them into `SessionManager` + the WS layer.

- [ ] **Step 1: Read existing boot sequence**

```bash
cat /Volumes/WDSSD/Code/mac-remote-terminal/packages/bridge/src/index.ts
```

Identify where SessionManager is constructed and where the WS server is wired.

- [ ] **Step 2: Edit `packages/bridge/src/index.ts`**

Add the imports at the TOP of the file, alongside other existing top-level imports (NOT inside any function — ESM imports must be top-level):

```ts
import { SessionRegistry } from './session-registry.js';
import { HistoryScanner } from './history-scanner.js';
import { homedir } from 'node:os';
import { isProjectPathAllowed } from './fs-api.js'; // adjust to whatever the actual export name is
```

(The exact `fs-api.js` export name depends on the existing Phase 3 surface — `grep -n 'export' packages/bridge/src/fs-api.ts` to find the correct symbol. Common patterns: `isPathAllowed`, `validateAllowed`, `assertAllowed`. If the existing helper throws on rejection rather than returning a boolean, wrap it: `(cwd) => assertAllowed(cwd, dirs).then(() => true).catch(() => false)`.)

In the boot function (likely `async function main()`), add immediately before SessionManager construction:

```ts
const registry = new SessionRegistry(join('.bridge', 'sessions.json'));
await registry.load();

// `isProjectPathAllowed` is imported at the top of the file (Step 2). If
// the existing fs-api helper has a different name or throws-on-rejection
// rather than returning a boolean, adapt the wrapping function.
const historyScanner = new HistoryScanner({
  homeDir: homedir(),
  allowedDirs: env.BRIDGE_ALLOWED_DIRS,
  allowlistGate: (cwd) => isProjectPathAllowed(cwd, env.BRIDGE_ALLOWED_DIRS),
});
```

Pass both into `SessionManager` and the WS server constructors:

```ts
const sessionManager = new SessionManager({
  // ... existing fields
  registry,
});

const wsServer = new WsServer({
  // ... existing fields
  sessionManager,
  historyScanner,
});
```

The exact field names depend on the existing constructor signatures — adjust to match.

- [ ] **Step 3: Verify build + typecheck**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run bridge:build
npx tsc --noEmit -p packages/bridge/tsconfig.json
```

Expected: clean.

- [ ] **Step 4: Verify existing bridge tests still pass**

```bash
npm run bridge:test
```

Expected: all green (existing + new from earlier tasks).

- [ ] **Step 5: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add packages/bridge/src/index.ts
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(bridge): boot wiring for SessionRegistry + HistoryScanner"
```

---

## Task 8: Web `historyStore.ts` — zustand store + 60 s dedupe

**Files:**
- Create: `apps/web/src/services/bridge-client-singleton.ts` (small registration shim)
- Modify: `apps/web/src/App.tsx` (register the BridgeClient instance on mount)
- Create: `apps/web/src/features/history/historyStore.ts`
- Create: `apps/web/src/features/history/historyStore.test.ts`

### Architecture note: how the store talks to the bridge

The existing web architecture instantiates `BridgeClient` ONCE in `App.tsx` (`const client = useMemo(() => new BridgeClient(), []);`) and threads it through component props (e.g. `Session.tsx`'s `client: BridgeClient` prop). Zustand stores have no access to this prop chain, so a Zustand action like `historyStore.fetch()` cannot reach `client.send()` directly.

Rather than threading the client through every action call, register the singleton on mount:

`apps/web/src/services/bridge-client-singleton.ts`:

```ts
import type { BridgeClient } from './bridge-client';

let registered: BridgeClient | null = null;

export function setBridgeClient(c: BridgeClient): void {
  registered = c;
}

export function getBridgeClient(): BridgeClient {
  if (registered === null) {
    throw new Error('BridgeClient has not been registered yet (App.tsx must call setBridgeClient on mount)');
  }
  return registered;
}
```

In `App.tsx`, after the `client` is constructed (around the `useMemo` line), call `setBridgeClient(client)` ONCE in a `useEffect` that runs on mount:

```tsx
import { setBridgeClient } from './services/bridge-client-singleton';

// inside App component, after the existing useMemo:
useEffect(() => {
  setBridgeClient(client);
}, [client]);
```

Stores then call `getBridgeClient().send(msg)` inside actions. This keeps the existing prop-threading for components that need it AND gives stores a clean way to send.

- [ ] **Step 1: Write failing test**

`apps/web/src/features/history/historyStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useHistoryStore } from './historyStore';
import type { HistoryEntry } from '../../types/protocol';

// Mock the BridgeClient singleton — the store calls getBridgeClient().send(msg).
vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: vi.fn(),
}));

import { getBridgeClient } from '../../services/bridge-client-singleton';

describe('historyStore', () => {
  beforeEach(() => {
    useHistoryStore.setState({
      claude: [],
      codex: [],
      loading: false,
      lastFetched: 0,
    });
    vi.clearAllMocks();
  });

  it('fetch() sends list_history over WS', async () => {
    const send = vi.fn();
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });
    useHistoryStore.getState().fetch();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'list_history' }));
    expect(useHistoryStore.getState().loading).toBe(true);
  });

  it('60s dedupe: second fetch within window does NOT re-send', async () => {
    const send = vi.fn();
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });
    useHistoryStore.setState({ lastFetched: Date.now(), loading: false });
    useHistoryStore.getState().fetch();
    expect(send).not.toHaveBeenCalled();
  });

  it('applyServerMsg history_list populates lists and clears loading', () => {
    const claude: HistoryEntry[] = [{
      agent: 'claude', sessionId: 'a', projectPath: '/p', mtime: 1, firstPrompt: 'hi',
    }];
    const codex: HistoryEntry[] = [];
    useHistoryStore.setState({ loading: true });
    useHistoryStore.getState().applyServerMsg({
      type: 'history_list',
      claude,
      codex,
      correlationId: 'x',
    });
    const s = useHistoryStore.getState();
    expect(s.claude).toEqual(claude);
    expect(s.codex).toEqual(codex);
    expect(s.loading).toBe(false);
    expect(s.lastFetched).toBeGreaterThan(0);
  });

  it('invalidate() resets lastFetched so next fetch goes through', () => {
    useHistoryStore.setState({ lastFetched: Date.now() });
    useHistoryStore.getState().invalidate();
    expect(useHistoryStore.getState().lastFetched).toBe(0);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run web:test -- historyStore
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/web/src/features/history/historyStore.ts`**

```ts
import { create } from 'zustand';
import type { HistoryEntry, ServerMsg } from '../../types/protocol';
import { getBridgeClient } from '../../services/bridge-client-singleton';

const CACHE_TTL_MS = 60_000;

interface HistoryState {
  claude: HistoryEntry[];
  codex: HistoryEntry[];
  loading: boolean;
  lastFetched: number;
  fetch: () => void;
  invalidate: () => void;
  applyServerMsg: (m: ServerMsg) => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  claude: [],
  codex: [],
  loading: false,
  lastFetched: 0,

  fetch() {
    const s = get();
    if (s.loading) return;
    if (Date.now() - s.lastFetched < CACHE_TTL_MS) return;
    set({ loading: true });
    const correlationId = `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    getBridgeClient().send({ type: 'list_history', correlationId });
  },

  invalidate() {
    set({ lastFetched: 0 });
  },

  applyServerMsg(m: ServerMsg) {
    if (m.type === 'history_list') {
      set({
        claude: m.claude,
        codex: m.codex,
        loading: false,
        lastFetched: Date.now(),
      });
    }
  },
}));
```

The existing `App.tsx` (or wherever ws messages are dispatched) needs ONE addition: call `useHistoryStore.getState().applyServerMsg(msg)` for `m.type === 'history_list'`. If the existing dispatcher routes by switch, add the case.

- [ ] **Step 4: Wire history-store into the WS message dispatcher**

The WS message dispatcher lives in `apps/web/src/App.tsx` (the `client.on('message', ...)` handler around line 40+). Inside that handler, add a route for the new `history_list` message:

```tsx
import { useHistoryStore } from './features/history/historyStore';

// inside the message handler, alongside the other type-routed branches:
if (m.type === 'history_list') {
  useHistoryStore.getState().applyServerMsg(m);
  return;
}
```

Place it near the other store-routing branches (e.g. `useFileExplorerStore.getState().applyDirsResult(m)` at App.tsx:50).

- [ ] **Step 5: Run test — expect PASS**

```bash
npm run web:test -- historyStore
```

Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add apps/web/src/services/bridge-client-singleton.ts apps/web/src/features/history/historyStore.ts apps/web/src/features/history/historyStore.test.ts apps/web/src/App.tsx
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(web): bridge-client singleton + historyStore with list_history fetch + 60s dedupe"
```

---

## Task 9: `HistoryPanel.tsx` + `HistoryRow.tsx` + `history.css`

**Files:**
- Create: `apps/web/src/features/history/HistoryPanel.tsx`
- Create: `apps/web/src/features/history/HistoryPanel.test.tsx`
- Create: `apps/web/src/features/history/HistoryRow.tsx`
- Create: `apps/web/src/features/history/history.css`

- [ ] **Step 1: Write failing test**

`apps/web/src/features/history/HistoryPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { HistoryPanel } from './HistoryPanel';
import { useHistoryStore } from './historyStore';

vi.mock('../../store/sessions', () => ({
  // getState is a vi.fn() so tests can mockReturnValue() it per-case.
  useSessionsStore: {
    getState: vi.fn(() => ({ resumeFromHistory: vi.fn() })),
  },
}));

// HistoryPanel uses useNavigate() from react-router-dom; mock it so tests
// don't need a Router wrapper. The mock returns a plain function so calls
// to navigate('/session/<id>') no-op silently.
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

import { useSessionsStore } from '../../store/sessions';

describe('HistoryPanel', () => {
  beforeEach(() => {
    useHistoryStore.setState({ claude: [], codex: [], loading: false, lastFetched: 0 });
    vi.clearAllMocks();
  });

  it('shows empty state for both tabs when lists are empty', () => {
    const { container, getByText } = render(<HistoryPanel />);
    fireEvent.click(getByText(/history/i)); // expand
    expect(container.textContent).toMatch(/no past sessions/i);
  });

  it('renders Claude rows when claude list is populated', () => {
    useHistoryStore.setState({
      claude: [{
        agent: 'claude', sessionId: 'a', projectPath: '/x/proj', mtime: Date.now() - 3600_000, firstPrompt: 'fix login',
      }],
      codex: [],
      loading: false,
      lastFetched: Date.now(),
    });
    const { container, getByText } = render(<HistoryPanel />);
    fireEvent.click(getByText(/history/i));
    expect(container.textContent).toMatch(/proj/);
    expect(container.textContent).toMatch(/fix login/);
  });

  it('switches to Codex tab and renders codex rows', () => {
    useHistoryStore.setState({
      claude: [],
      codex: [{
        agent: 'codex', sessionId: 'b', projectPath: '/y/repo', mtime: Date.now(), firstPrompt: 'refactor',
      }],
      loading: false,
      lastFetched: Date.now(),
    });
    const { container, getByText } = render(<HistoryPanel />);
    fireEvent.click(getByText(/history/i));
    fireEvent.click(getByText(/codex/i));
    expect(container.textContent).toMatch(/repo/);
    expect(container.textContent).toMatch(/refactor/);
  });

  it('clicking a row calls resumeFromHistory(entry)', () => {
    const resumeFromHistory = vi.fn();
    (useSessionsStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({ resumeFromHistory });
    const entry = {
      agent: 'claude' as const,
      sessionId: 'a',
      projectPath: '/x/proj',
      mtime: Date.now(),
      firstPrompt: 'hi',
    };
    useHistoryStore.setState({ claude: [entry], codex: [], loading: false, lastFetched: Date.now() });
    const { container, getByText } = render(<HistoryPanel />);
    fireEvent.click(getByText(/history/i));
    const row = container.querySelector('button.history-row') as HTMLButtonElement;
    fireEvent.click(row);
    expect(resumeFromHistory).toHaveBeenCalledWith(entry);
  });

  it('renders 50 rows max', () => {
    const claude = Array.from({ length: 60 }, (_, i) => ({
      agent: 'claude' as const,
      sessionId: `s-${i}`,
      projectPath: '/p',
      mtime: Date.now() - i * 1000,
      firstPrompt: `prompt ${i}`,
    }));
    useHistoryStore.setState({ claude, codex: [], loading: false, lastFetched: Date.now() });
    const { container, getByText } = render(<HistoryPanel />);
    fireEvent.click(getByText(/history/i));
    const rows = container.querySelectorAll('button.history-row');
    expect(rows.length).toBe(50);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run web:test -- HistoryPanel
```

- [ ] **Step 3: Implement `apps/web/src/features/history/HistoryRow.tsx`**

```tsx
import type { HistoryEntry } from '../../types/protocol';

interface HistoryRowProps {
  entry: HistoryEntry;
  onClick: () => void;
}

function relativeTime(mtime: number): string {
  const ms = Date.now() - mtime;
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(mtime).toLocaleDateString();
}

function basenameSafe(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function HistoryRow({ entry, onClick }: HistoryRowProps): JSX.Element {
  const tooltip = `${entry.projectPath}\n${entry.firstPrompt}\n${new Date(entry.mtime).toISOString()}`;
  return (
    <button
      type="button"
      className="history-row"
      onClick={onClick}
      title={tooltip}
    >
      <span className="history-row-project">{basenameSafe(entry.projectPath)}</span>
      <span className="history-row-prompt">{entry.firstPrompt || '(no prompt)'}</span>
      <span className="history-row-time">{relativeTime(entry.mtime)}</span>
    </button>
  );
}
```

(`basenameSafe` is inlined to avoid adding a `path-browserify` dependency — Phase 5 ships zero new web deps.)

- [ ] **Step 4: Implement `apps/web/src/features/history/HistoryPanel.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHistoryStore } from './historyStore';
import { useSessionsStore } from '../../store/sessions';
import { HistoryRow } from './HistoryRow';
import type { HistoryEntry } from '../../types/protocol';

type Tab = 'claude' | 'codex';

export function HistoryPanel(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('claude');
  const [resumeError, setResumeError] = useState<string | null>(null);
  const navigate = useNavigate();
  const claude = useHistoryStore((s) => s.claude);
  const codex = useHistoryStore((s) => s.codex);
  const loading = useHistoryStore((s) => s.loading);
  const fetch = useHistoryStore((s) => s.fetch);

  useEffect(() => {
    if (open) fetch();
  }, [open, fetch]);

  const onRowClick = async (entry: HistoryEntry): Promise<void> => {
    setResumeError(null);
    try {
      const webSessionId = await useSessionsStore.getState().resumeFromHistory(entry);
      navigate(`/session/${webSessionId}`);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      setResumeError(e.message ?? 'Resume failed');
      // history_session_not_found: refresh history list so the deleted entry disappears.
      if (e.code === 'history_session_not_found') {
        useHistoryStore.getState().invalidate();
        useHistoryStore.getState().fetch();
      }
    }
  };

  const list = tab === 'claude' ? claude : codex;
  const visible = list.slice(0, 50);

  return (
    <div className="history-panel">
      <button
        type="button"
        className="history-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '▾' : '▸'} History
      </button>
      {open && (
        <div className="history-body">
          <div className="history-tabs">
            <button
              type="button"
              className={`history-tab ${tab === 'claude' ? 'active' : ''}`}
              onClick={() => setTab('claude')}
            >
              Claude ({claude.length})
            </button>
            <button
              type="button"
              className={`history-tab ${tab === 'codex' ? 'active' : ''}`}
              onClick={() => setTab('codex')}
            >
              Codex ({codex.length})
            </button>
          </div>
          {resumeError !== null && (
            <div className="history-error">{resumeError}</div>
          )}
          <div className="history-list">
            {loading && <div className="history-loading">Loading…</div>}
            {!loading && visible.length === 0 && (
              <div className="history-empty">No past sessions for {tab}.</div>
            )}
            {visible.map((entry: HistoryEntry) => (
              <HistoryRow
                key={`${entry.agent}-${entry.sessionId}`}
                entry={entry}
                onClick={() => void onRowClick(entry)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Implement `apps/web/src/features/history/history.css`**

```css
.history-panel { border-top: 1px solid #2a2a2a; padding: 0.4rem 0.5rem; }
.history-toggle {
  background: transparent; color: #aaa; border: 0; padding: 0.2rem 0;
  font-size: 0.8rem; cursor: pointer; text-transform: uppercase; letter-spacing: 0.05em;
}
.history-toggle:hover { color: #ddd; }

.history-body { margin-top: 0.4rem; }
.history-tabs { display: flex; gap: 0.3rem; margin-bottom: 0.4rem; }
.history-tab {
  flex: 1; background: #1a1a1a; color: #aaa; border: 1px solid #2a2a2a;
  padding: 0.3rem 0.5rem; font-size: 0.75rem; cursor: pointer; border-radius: 3px;
}
.history-tab:hover { background: #222; }
.history-tab.active { background: #2a2a2a; color: #ddd; }

.history-list { max-height: 40vh; overflow-y: auto; }
.history-loading, .history-empty { color: #666; padding: 0.5rem 0.2rem; font-size: 0.8rem; text-align: center; }
.history-error {
  color: #f88; background: #2a1010; border: 1px solid #4a1a1a; border-radius: 3px;
  padding: 0.3rem 0.5rem; margin-bottom: 0.4rem; font-size: 0.75rem;
}

.history-row {
  display: flex; flex-direction: column; gap: 0.05rem;
  width: 100%; padding: 0.35rem 0.5rem; margin-bottom: 0.15rem;
  background: transparent; color: #ddd; border: 1px solid transparent; border-radius: 3px;
  text-align: left; cursor: pointer; font-size: 0.75rem;
}
.history-row:hover { background: #1a1a1a; border-color: #2a2a2a; }
.history-row-project { color: #6fa8ff; font-weight: 500; }
.history-row-prompt {
  color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.history-row-time { color: #666; font-size: 0.7rem; }
```

- [ ] **Step 6: Add CSS import to `apps/web/src/main.tsx`**

```tsx
import './features/history/history.css';
```

(Place near the other CSS imports.)

- [ ] **Step 7: Run test — expect PASS**

```bash
npm run web:test -- HistoryPanel
```

Expected: 5 passed.

- [ ] **Step 8: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add apps/web/src/features/history apps/web/src/main.tsx
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(web): HistoryPanel + HistoryRow + history.css"
```

---

## Task 10: `Home.tsx` integration — render `<HistoryPanel />`

**Files:**
- Modify: `apps/web/src/pages/Home.tsx`

- [ ] **Step 1: Read existing file**

```bash
cat /Volumes/WDSSD/Code/mac-remote-terminal/apps/web/src/pages/Home.tsx
```

Identify where the live-sessions list ends; that's where HistoryPanel slots in.

- [ ] **Step 2: Edit `apps/web/src/pages/Home.tsx`**

Add import:

```tsx
import { HistoryPanel } from '../features/history/HistoryPanel';
```

After the closing tag of the live sessions list (e.g. `</ul>` or `</div>` of the list), add:

```tsx
<HistoryPanel />
```

- [ ] **Step 3: Verify build + visual smoke**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run web:build 2>&1 | tail -5
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add apps/web/src/pages/Home.tsx
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(web): render HistoryPanel below live sessions list"
```

---

## Task 11: `ResumePrompt.tsx` + sessions-store actions + session_dead re-routing

**Files:**
- Create: `apps/web/src/features/chat/ResumePrompt.tsx`
- Create: `apps/web/src/features/chat/ResumePrompt.test.tsx`
- Modify: `apps/web/src/store/sessions.ts`
- Modify: `apps/web/src/store/sessions.test.ts`
- Modify: `apps/web/src/store/connection.ts`

- [ ] **Step 1: Append sessions-store tests for the new actions + session_dead behavior**

Inside `apps/web/src/store/sessions.test.ts`, append:

```ts
it('error session_dead flips per-session alive=false (does NOT push to global errors)', () => {
  const store = useSessionsStore.getState();
  store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
  store.applyServerMsg({
    type: 'error',
    code: 'session_dead',
    message: 'session is not alive',
    sessionId: 's1',
    correlationId: 'c1',
  });
  expect(useSessionsStore.getState().sessions['s1']!.alive).toBe(false);
  // Assert global error store not touched (depends on test harness — skip if testing in isolation).
});

it('resume(webSessionId) sends resume_session via WS', () => {
  const send = vi.fn();
  // mock connection store as in earlier tests
  // ...
  useSessionsStore.getState().resume('s1');
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'resume_session',
    webSessionId: 's1',
  }));
});

it('resumeFromHistory(entry) sends resume_session with agent + sessionId + projectPath', () => {
  const send = vi.fn();
  // mock connection store
  // ...
  const entry = {
    agent: 'claude' as const,
    sessionId: 'cli-uuid',
    projectPath: '/p',
    mtime: 1,
    firstPrompt: 'hi',
  };
  useSessionsStore.getState().resumeFromHistory(entry);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'resume_session',
    agent: 'claude',
    sessionId: 'cli-uuid',
    projectPath: '/p',
  }));
});

it('on session_resumed reply for known webSessionId, alive flips to true', () => {
  const store = useSessionsStore.getState();
  store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
  // mark dead
  store.applyServerMsg({ type: 'error', code: 'session_dead', message: 'd', sessionId: 's1', correlationId: 'c' });
  // resume reply
  store.applyServerMsg({ type: 'session_resumed', webSessionId: 's1', alive: true, correlationId: 'c2' });
  expect(useSessionsStore.getState().sessions['s1']!.alive).toBe(true);
});
```

- [ ] **Step 2: Create ResumePrompt test**

`apps/web/src/features/chat/ResumePrompt.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ResumePrompt } from './ResumePrompt';

describe('ResumePrompt', () => {
  it('renders the resume CTA when alive=false', () => {
    const { getByText } = render(
      <ResumePrompt webSessionId="s1" alive={false} onResume={() => {}} />,
    );
    expect(getByText(/session ended/i)).toBeTruthy();
    expect(getByText(/resume/i)).toBeTruthy();
  });

  it('renders nothing when alive=true', () => {
    const { container } = render(
      <ResumePrompt webSessionId="s1" alive={true} onResume={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('clicking Resume calls onResume()', () => {
    const onResume = vi.fn();
    const { getByText } = render(
      <ResumePrompt webSessionId="s1" alive={false} onResume={onResume} />,
    );
    fireEvent.click(getByText(/^resume/i));
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL**

```bash
npm run web:test -- ResumePrompt sessions
```

- [ ] **Step 4: Implement `apps/web/src/features/chat/ResumePrompt.tsx`**

```tsx
interface ResumePromptProps {
  webSessionId: string;
  alive: boolean;
  onResume: () => void;
}

export function ResumePrompt({ webSessionId: _id, alive, onResume }: ResumePromptProps): JSX.Element | null {
  if (alive) return null;
  return (
    <div className="resume-prompt">
      <span>session ended — </span>
      <button type="button" className="resume-prompt-button" onClick={onResume}>
        Resume
      </button>
    </div>
  );
}
```

Add CSS rules (append to `apps/web/src/App.css` or wherever chat styles live):

```css
.resume-prompt {
  display: flex; align-items: center; justify-content: center; gap: 0.4rem;
  padding: 0.4rem 0.6rem; margin: 0.4rem 0;
  background: #1f1f1f; border: 1px solid #2a2a2a; border-radius: 4px;
  color: #aaa; font-size: 0.85rem;
}
.resume-prompt-button {
  background: #2a2a2a; color: #6fa8ff; border: 1px solid #3a3a3a;
  padding: 0.2rem 0.6rem; cursor: pointer; border-radius: 3px;
}
.resume-prompt-button:hover { background: #333; }
```

- [ ] **Step 5: Implement sessions-store changes**

In `apps/web/src/store/sessions.ts`:

```ts
import type { HistoryEntry } from '../types/protocol';
import { getBridgeClient } from '../services/bridge-client-singleton';

// Inside the create() body, alongside existing actions:

// Pending-resume map: correlationId → {resolve, reject}. The applyServerMsg
// branch for session_resumed / matching error looks up the entry and resolves.
// This is the only way to make resume() awaitable from InputBox's "Resume + send"
// flow, where we need to wait for the bridge to finish spawning before sending
// the queued message.
//
// Add to the store's outer scope (not inside create()):
const pendingResumes = new Map<string, { resolve: (webSessionId: string) => void; reject: (err: { code: string; message: string }) => void }>();

// Inside the create() body:
async resume(webSessionId: string): Promise<string> {
  const correlationId = `resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const promise = new Promise<string>((resolve, reject) => {
    pendingResumes.set(correlationId, { resolve, reject });
  });
  getBridgeClient().send({
    type: 'resume_session',
    webSessionId,
    correlationId,
  });
  return promise;
},

async resumeFromHistory(entry: HistoryEntry): Promise<string> {
  const correlationId = `resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const promise = new Promise<string>((resolve, reject) => {
    pendingResumes.set(correlationId, { resolve, reject });
  });
  getBridgeClient().send({
    type: 'resume_session',
    agent: entry.agent,
    sessionId: entry.sessionId,
    projectPath: entry.projectPath,
    correlationId,
  });
  // Caller (HistoryPanel) awaits this and navigates to /session/<id> on resolve.
  return promise;
},
```

In the `applyServerMsg` switch, add:

```ts
if (m.type === 'error' && m.code === 'session_dead' && m.sessionId) {
  const existing = get().sessions[m.sessionId];
  if (existing) {
    set((s) => ({
      sessions: { ...s.sessions, [m.sessionId!]: { ...existing, alive: false } },
    }));
  }
  return;
}
if (m.type === 'session_resumed') {
  const existing = get().sessions[m.webSessionId];
  if (existing) {
    set((s) => ({
      sessions: { ...s.sessions, [m.webSessionId]: { ...existing, alive: true } },
    }));
  }
  // Resolve the pending resume promise so the caller (HistoryPanel for Path 2,
  // InputBox for "Resume + send") can navigate / flush queued message.
  const pending = pendingResumes.get(m.correlationId);
  if (pending) {
    pendingResumes.delete(m.correlationId);
    pending.resolve(m.webSessionId);
  }
  return;
}
if (m.type === 'error' && m.correlationId && pendingResumes.has(m.correlationId)) {
  const pending = pendingResumes.get(m.correlationId)!;
  pendingResumes.delete(m.correlationId);
  pending.reject({ code: m.code, message: m.message });
  // Fall through if this error is also session-scoped (e.g. session_dead) so
  // existing per-session handling still runs. The pending-promise rejection
  // and the per-session state update can both happen for the same message.
}
```

- [ ] **Step 6: Update `apps/web/src/App.tsx` (the actual setError dispatch site)**

Locate the WS message handler around line 57-64 of `apps/web/src/App.tsx`. The current code is:

```tsx
if (m.type === 'error') {
  if (m.code === 'session_dead' && m.sessionId) {
    markTranscriptOnly(m.sessionId);
  }
  setError(`${m.code}: ${m.message}`);
} else {
  setError(null);
}
```

PRESERVE `markTranscriptOnly()` — that's Phase 2's transcript-only fallback hook and is still needed (Session.tsx uses it to streamTranscript from disk; ResumePrompt then renders if events were replayed). Only the `setError` raise is what we want to suppress for `session_dead`.

Replace with:

```tsx
if (m.type === 'error') {
  if (m.code === 'session_dead' && m.sessionId) {
    markTranscriptOnly(m.sessionId);
    // Per-session-only: do NOT raise the global error banner. The sessions
    // store branch (added in Step 5) will flip alive=false on apply(m) below;
    // Session.tsx then renders ResumePrompt or the transcript-unavailable
    // notice depending on whether streamTranscript yielded events.
  } else {
    setError(`${m.code}: ${m.message}`);
  }
} else {
  setError(null);
}
```

Critical contract:
1. The guard must NOT `return` early — `apply(m)` later in this handler is what routes `session_dead` into the sessions store so `alive` flips to `false`. Returning would block ResumePrompt from rendering.
2. `markTranscriptOnly()` MUST still run on session_dead — Session.tsx uses that flag to invoke streamTranscript fallback. Without it, the bubble list stays empty and the transcript-unavailable notice fires when it shouldn't.
3. The `else { setError(null) }` branch (which clears the global banner on any non-error message) is preserved unchanged.

All other error codes (Phase 5's new ones included) still raise the global banner; session_dead uniquely silences it.

- [ ] **Step 7: Run tests — expect PASS**

```bash
npm run web:test -- ResumePrompt sessions
```

Expected: ResumePrompt 3 passed; sessions tests including new ones all passed.

- [ ] **Step 8: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add apps/web/src/features/chat/ResumePrompt.tsx apps/web/src/features/chat/ResumePrompt.test.tsx apps/web/src/store/sessions.ts apps/web/src/store/sessions.test.ts apps/web/src/App.tsx apps/web/src/App.css
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(web): ResumePrompt + sessions-store resume/resumeFromHistory actions + session_dead re-routing"
```

---

## Task 12: `Session.tsx` integration — render `<ResumePrompt />` + transcript-unavailable notice

**Files:**
- Modify: `apps/web/src/pages/Session.tsx`
- Modify: `apps/web/src/features/chat/Chat.tsx`

- [ ] **Step 1: Read existing files**

```bash
cat /Volumes/WDSSD/Code/mac-remote-terminal/apps/web/src/pages/Session.tsx
cat /Volumes/WDSSD/Code/mac-remote-terminal/apps/web/src/features/chat/Chat.tsx
```

Identify where the message list ends and where InputBox is rendered.

- [ ] **Step 2: Edit Session.tsx**

Add imports and the resume callback:

```tsx
import { ResumePrompt } from '../features/chat/ResumePrompt';
import { useSessionsStore } from '../store/sessions';
```

Inside the component, derive `alive` from the session (existing code likely already does this) and figure out whether transcript yielded events. Then in the render tree, between the message list and `<InputBox />`:

```tsx
{!alive && (
  events.length > 0 ? (
    <ResumePrompt
      webSessionId={sessionId}
      alive={alive}
      onResume={() => useSessionsStore.getState().resume(sessionId)}
    />
  ) : (
    <div className="resume-prompt">
      <span>session ended; transcript unavailable — </span>
      <button type="button" onClick={() => navigate('/')}>New session</button>
    </div>
  )
)}
```

(Use the existing `events` count; the variable name depends on the existing code. The check is "did transcript replay produce anything to show".)

- [ ] **Step 3: If Chat.tsx wraps the rendering, plumb through `alive` + `onResume`**

Adjust as needed; the goal is for `<ResumePrompt />` to render between message bubbles and InputBox.

- [ ] **Step 4: Verify build + tests still green**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run web:test
npm run web:build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add apps/web/src/pages/Session.tsx apps/web/src/features/chat/Chat.tsx
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(web): render ResumePrompt + transcript-unavailable notice on dead sessions"
```

---

## Task 13: `InputBox.tsx` auto-prompt-on-send

**Files:**
- Modify: `apps/web/src/features/chat/InputBox.tsx`
- Modify: `apps/web/src/features/chat/Chat.tsx` (REMOVE the existing dead-session disable)
- Modify: `apps/web/src/features/chat/InputBox.test.tsx` (or create if doesn't exist)

The existing `Chat.tsx` disables `InputBox` when the session is dead (`disabled={!alive}` or equivalent — currently around line 96 of that file). For the auto-prompt-on-send flow to fire, InputBox must STAY ENABLED on dead sessions; the interception happens inside `onSubmit`.

- [ ] **Step 1: Read existing InputBox + Chat.tsx**

```bash
cat /Volumes/WDSSD/Code/mac-remote-terminal/apps/web/src/features/chat/InputBox.tsx
cat /Volumes/WDSSD/Code/mac-remote-terminal/apps/web/src/features/chat/Chat.tsx
```

Identify the existing `disabled={!alive}` (or equivalent) prop on the InputBox call site. That wiring must be REMOVED so the user can type + submit on dead sessions; submit is intercepted inside InputBox.

- [ ] **Step 2: Append/create failing test for auto-prompt-on-send**

```tsx
it('auto-prompts on send when session is dead; click Resume + send flushes the message after resume', () => {
  // Render InputBox with alive=false. Type into textarea, click Send.
  // Expect a "Resume + send" CTA to appear inline.
  // Mock the resume action to simulate a successful resume (alive flips true).
  // Assert the original message gets sent (e.g. send() is called with that text).
  // ...
});

it('subsequent typed messages while resume in-flight stay queued in the textarea', () => {
  // After clicking Resume + send, while resume is still in-flight, type more
  // text. After resume completes, those characters should still be in the
  // textarea (not auto-sent).
  // ...
});
```

(Sketches — the exact harness depends on the existing InputBox patterns.)

- [ ] **Step 3: Implement auto-prompt logic in InputBox.tsx**

The pattern: InputBox accepts a new prop `alive: boolean` and `onResume: () => Promise<void>`. On `submit()`:

```tsx
const onSubmit = async (e: FormEvent) => {
  e.preventDefault();
  if (!alive) {
    // Capture the message-as-of-submit-time. Subsequent typing won't be sent.
    setQueuedMessage(text);
    setShowResumePromptInline(true);
    return; // do NOT call onSendMessage yet
  }
  const captured = text;
  setText('');
  await onSendMessage(captured);
};

const onResumeAndSend = async () => {
  // Capture the queued message; whatever the user types AFTER this point
  // stays in the textarea (does NOT auto-send).
  const captured = queuedMessage;
  setShowResumePromptInline(false);
  setQueuedMessage('');
  // Strip the captured prefix from the live textarea ONLY if it's still
  // there. If user has erased + retyped, leave their current text alone.
  if (text.startsWith(captured)) {
    setText(text.slice(captured.length));
  }
  await onResume();
  await onSendMessage(captured);
  // Do NOT clear setText() here — anything still in the textarea is the
  // user's NEXT message (queued during resume), which they will send manually.
};
```

The `queuedMessage` state preserves the at-submit-time content, allowing the captured-vs-live divergence the spec requires.

Render the inline ResumePrompt with the "Resume + send" variant when `showResumePromptInline === true`.

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm run web:test -- InputBox
```

- [ ] **Step 5: Edit Chat.tsx to remove dead-session disable**

Locate the call site that passes `disabled={!alive}` (or any equivalent disabling prop) to `<InputBox />` and REMOVE that wiring. InputBox itself now decides what to do on submit-while-dead. Pass `alive` and `onResume` instead:

```tsx
<InputBox
  // ... existing props
  alive={alive}
  onResume={async () => useSessionsStore.getState().resume(sessionId)}
/>
```

Update `InputBox`'s prop type to accept the new fields (and drop any `disabled` parameter wiring you removed).

- [ ] **Step 6: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add apps/web/src/features/chat/InputBox.tsx apps/web/src/features/chat/Chat.tsx apps/web/src/features/chat/InputBox.test.tsx
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(web): InputBox auto-prompt-on-send for dead sessions"
```

---

## Task 14: Manual e2e smoke

This task changes no code. It validates the Phase 5 increment end-to-end against a real bridge.

**Pre-reqs:**
- `claude` and `codex` CLIs on PATH and authed
- Existing repo build green
- AT LEAST one prior Claude session in `~/.claude/projects/<encoded>/` and one prior Codex session in `~/.codex/sessions/...` (run them in your terminal before starting if you don't have any)

- [ ] **Step 1: Build everything**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run build
```

- [ ] **Step 2: Boot the bridge**

```bash
export BRIDGE_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
export BRIDGE_ALLOWED_DIRS=/Volumes/WDSSD/Code,$HOME
node packages/bridge/dist/index.js
```

Expected: bridge boots, prints URL, registry loads (or starts empty if no `.bridge/sessions.json` exists).

- [ ] **Step 3: Open URL → expand History panel**

Click the History toggle in the sidebar. Both Claude and Codex tabs should show counts and rows. Hover a row → tooltip shows full path + ISO timestamp.

- [ ] **Step 4: Click a Claude history row from a different project**

Verify:
- Routes to `/session/<new-id>` (URL has a fresh webSessionId).
- Chat view is EMPTY (native CLI history JSONL is NOT imported into bridge transcripts in Phase 5; this is documented behavior).
- Input box is live.
- Send a message like "what were we just discussing?" — Claude responds with full memory of the prior conversation, demonstrating `--resume` worked even though our UI started blank.

- [ ] **Step 5: Click a Codex history row**

Similar to step 4. First send triggers `codex exec resume <id>` and the response shows Codex retains context.

- [ ] **Step 6: Test bridge restart resume**

Open one of the live sessions you just created. Then:
1. Kill the bridge process (Ctrl-C in its terminal).
2. Restart it: `node packages/bridge/dist/index.js`.
3. Reload the browser tab.

Verify:
- The session shows as dead (alive: false).
- Transcript replays silently (no global error banner).
- `[Resume]` button visible in the ResumePrompt above InputBox.
- Click Resume → spawns Claude with `--resume <claudeId>` — chat continues.

- [ ] **Step 7: Test auto-prompt-on-send**

After a fresh bridge restart (so a session is dead), DON'T click Resume. Instead, type a message into InputBox and click Send.

Verify:
- Inline auto-prompt appears with "Resume + send" CTA.
- Click → resume runs; after `session_resumed` arrives, the original typed message is sent.
- If you typed a SECOND message while resume was in-flight, that one stays in the textarea (not auto-sent).

- [ ] **Step 8: Test history-entry-deleted error**

Manually delete one of the history JSONL files from `~/.claude/projects/...`. Click that row in the UI.

Verify:
- Inline error notice appears: "No history session found for ...".
- History list auto-refreshes (the deleted row disappears).

- [ ] **Step 9: Test allowlist-tightened error**

Pre-condition: have a session row whose projectPath was previously inside BRIDGE_ALLOWED_DIRS. Restart bridge with a tighter `BRIDGE_ALLOWED_DIRS` that excludes it. Click Resume on that session.

Verify:
- Inline error notice: "Project path is not in BRIDGE_ALLOWED_DIRS".
- "[Open new session]" CTA available.

- [ ] **Step 10: Test path-missing error**

Move/rename one of the project folders. Click Resume on a session pointing to that path.

Verify:
- Inline error notice: "Project path no longer exists: <path>".

- [ ] **Step 11: Verify CSP / DevTools console**

Throughout the smoke session, DevTools → Console:
- Zero CSP violations.
- Zero React errors.
- Zero unhandled promise rejections.

- [ ] **Step 12: Tag the slice**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal tag phase-5-history-resume
```

---

## Self-Review (run before declaring Phase 5 done)

1. `npm run typecheck` (or `npx tsc --noEmit -p` for both bridge and web tsconfigs) — clean.
2. `npm test` — all bridge + web unit tests pass (existing + new).
3. `npm run build` — both packages build cleanly.
4. Manual smoke (Task 14) executed end-to-end against real Claude + Codex.
5. History panel populates with both tabs from native CLI history dirs.
6. Resume preserves webSessionId for bridge-known sessions; issues a NEW one for native-history first-resume.
7. `claude --resume <id>` and `codex exec resume <id>` actually run with the captured CLI session id (verify by sending a follow-up that requires prior context).
8. `session_dead` no longer raises a global error banner when transcript yielded events; ResumePrompt appears instead.
9. Auto-prompt-on-send fires only on dead sessions; first message flushes after resume; subsequent typed messages stay queued.
10. Registry persists `.bridge/sessions.json` with mode 0o600 across restarts.
11. Concurrent Resume clicks on the same session deduplicate (one spawn).
12. All seven new error codes (`history_session_not_found`, `project_path_disallowed`, `project_path_missing`, `cli_session_id_unknown`, `claude_resume_rejected`, `codex_resume_rejected`, `resume_spawn_failed`) reachable via at least one test or manual smoke step.
13. Allowlist enforced ONLY against ground-truth `cwd`; client-supplied `projectPath` is treated as a hint and overridden by the bridge.
14. Concurrent registry writes don't tear the file (50-write stress test passes).

If any check fails, fix before tagging.
