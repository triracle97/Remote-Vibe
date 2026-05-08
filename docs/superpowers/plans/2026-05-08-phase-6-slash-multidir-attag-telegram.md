# Phase 6 — Slash + Multi-Dir + @-tag + Telegram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle four UX improvements into one cohesive phase: slash command autocomplete (pass-through to Claude/Codex), multi-dir sessions with named profiles persisted to `.bridge/profiles.json`, custom @-tag picker that fuzzy-searches files across all session working dirs, and Telegram notifications when a turn runs longer than `BRIDGE_NOTIFY_MIN_DURATION_MS`. Sessions auto-name from first prompt and can be renamed via pencil-icon inline editor.

**Architecture:** Bridge gains four new modules (`profile-store.ts`, `slash-commands.ts`, `file-search.ts`, `notifier.ts`) plus extensions to `session.ts` (multi-dir spawn, per-session name, rename, per-turn timing). Registry shape extended with `name + additionalDirs` and migrates on load. Web adds `DirPicker`, `ProfilePicker`, `ProfileEditor`, `SlashAutocomplete`, `AtTagAutocomplete`, `SessionRenameInline` plus three new stores. All UI mobile-friendly (full-screen modals < 640px, tap targets ≥ 44px, no drag-only / hover-only patterns).

**Tech Stack:** Node 20 ESM (NodeNext, exactOptionalPropertyTypes), Vitest 1, React 18 + Zustand 4 + React Router 6 + Vite 5. New deps: `ignore` (already a transitive dep — verify; if not, install). No new web deps.

**Spec:** `docs/superpowers/specs/2026-05-08-phase-6-slash-multidir-attag-telegram-design.md`

**Out of scope (per spec §2):** file-content (grep) search; Codex `--add-dir` (CLI lacks it); auto-naming via LLM; Telegram 2-way; per-session telegram toggle UI; filesystem watcher for @-tag; auto-load slash commands from additional dirs.

---

## File Structure

### Bridge — new files

```
packages/bridge/src/
├── profile-store.ts                # CRUD .bridge/profiles.json (atomic writes, env override)
├── slash-commands.ts               # scan ~/.claude/commands/ + project + builtins (60s cache)
├── file-search.ts                  # bounded walk + fuzzy + recency boost (30s cache)
├── notifier.ts                     # Telegram client; subscribed to broadcast
└── __tests__/
    ├── profile-store.test.ts
    ├── slash-commands.test.ts
    ├── file-search.test.ts
    └── notifier.test.ts
```

### Bridge — modified files

| File | Change |
|---|---|
| `packages/bridge/src/types.ts` | Add `Profile`, `SlashCommand`, `SearchHit` interfaces. Add 7 new client message types + 5 new server message types. Extend `ServerErrorMsg.code` with 6 new codes. Extend `ClientStartMsg` to accept `dirs?: string[]` alongside the existing `projectPath?`. |
| `packages/bridge/src/session.ts` (`SessionManager`) | `spawnSession()` accepts `dirs: string[]`; first = primary cwd, rest passed as `--add-dir` (Claude only; Codex logs warning). `RegistryEntry` extended with `name: string \| null` + `additionalDirs: string[]`. First `input` event auto-sets `name`. New `renameSession(webSessionId, name)` method. Per-turn timing tracked for notifier subscription. |
| `packages/bridge/src/claude-process.ts` | New `additionalDirs: string[]` opt; spawn args prepend `[...additionalDirs.flatMap(d => ['--add-dir', d])]` after the existing flag set. |
| `packages/bridge/src/codex-process.ts` | Add `additionalDirs: string[]` opt for symmetry; ignored at spawn but stored on the driver for diagnostics. One-shot warning at spawn. |
| `packages/bridge/src/session-registry.ts` | `RegistryEntry` adds `name: string \| null` + `additionalDirs: string[]`. Migration on load: existing entries get `name: null` + `additionalDirs: []`. |
| `packages/bridge/src/websocket.ts` | New handlers for the 7 new client messages. `AttachWsOpts` gains `profileStore`, `slashCommands`, `fileSearch`. Existing `start` accepts `dirs[]`. |
| `packages/bridge/src/index.ts` | Boot wiring: instantiate ProfileStore, SlashCommandsScanner, FileSearch, Notifier. Subscribe Notifier to SessionManager's `broadcast` event. |

### Web — new files

```
apps/web/src/features/profiles/
├── ProfilePicker.tsx               # native <select> dropdown
├── ProfilePicker.test.tsx
├── ProfileEditor.tsx               # full-screen-on-mobile modal
├── ProfileEditor.test.tsx
├── DirPicker.tsx                   # multi-select with ★ primary + arrow reorder
├── DirPicker.test.tsx
├── profileStore.ts                 # zustand
├── profileStore.test.ts
└── profiles.css

apps/web/src/features/chat/
├── SlashAutocomplete.tsx
├── SlashAutocomplete.test.tsx
├── AtTagAutocomplete.tsx
├── AtTagAutocomplete.test.tsx
├── slashCommandStore.ts
├── slashCommandStore.test.ts
├── fileSearchStore.ts
└── fileSearchStore.test.ts

apps/web/src/features/session-list/
├── SessionRenameInline.tsx
└── SessionRenameInline.test.tsx
```

### Web — modified files

| File | Change |
|---|---|
| `apps/web/src/types/protocol.ts` | Mirror bridge type additions byte-identically. |
| `apps/web/src/features/project-picker/useNewSession.tsx` | Use `<DirPicker />` instead of single-cwd input; add `<ProfilePicker />`; spawn payload uses `dirs: string[]`; full-screen modal at `<640px`. |
| `apps/web/src/features/chat/InputBox.tsx` | Wire `<SlashAutocomplete />` + `<AtTagAutocomplete />` overlays; cursor-position tracking for `@` mid-text trigger. |
| `apps/web/src/features/chat/Chat.tsx` | Pass `sessionId` through to InputBox. |
| `apps/web/src/features/session-list/SessionList.tsx` | Display `session.name`; render `<SessionRenameInline />` on pencil click. |
| `apps/web/src/store/sessions.ts` | Add `renameSession(sessionId, name)` action (promise-based, correlationId-keyed pending Map). Apply `session_renamed` server msg → updates store. |
| `apps/web/src/App.tsx` | Route 5 new server message types to their stores. |
| `apps/web/src/pages/Session.tsx` | Header gains pencil-rename inline. `document.title` updates with session name. |
| `apps/web/src/main.tsx` | Add CSS imports. |

### Documentation

```
docs/setup/telegram-bot.md           # one-page bot setup walkthrough
```

---

## Task 1: Protocol type additions

**Files:**
- Modify: `packages/bridge/src/types.ts`
- Modify: `apps/web/src/types/protocol.ts`

This task is pure type plumbing. Both files MUST stay byte-identical for the new declarations.

- [ ] **Step 1: Read both type files**

```bash
cat /Volumes/WDSSD/Code/mac-remote-terminal/packages/bridge/src/types.ts | head -100
cat /Volumes/WDSSD/Code/mac-remote-terminal/apps/web/src/types/protocol.ts | head -100
```

- [ ] **Step 2: Add Phase 6 interfaces to `packages/bridge/src/types.ts`**

```ts
// Phase 6 — slash + multi-dir/profiles + @-tag + telegram

export interface Profile {
  /** Unique within (agent); regex `[A-Za-z0-9 _-]{1,40}` */
  name: string;
  agent: 'claude' | 'codex';
  /** Working dirs in order; dirs[0] = primary cwd, dirs[1..] = --add-dir for Claude. Non-empty. */
  dirs: string[];
  /** Codex profile name; null for Claude. */
  account: string | null;
  /** One profile per agent can have default: true. */
  default: boolean;
  /** Server-set on load when validation fails (e.g. dirs[i] outside allowlist). UI greys out invalid entries. */
  valid?: boolean;
}

export interface SlashCommand {
  /** Includes leading `/`. */
  name: string;
  /** Empty string when none. */
  description: string;
  source: 'builtin' | 'user' | 'project';
  /** `'both'` for shared commands; otherwise scoped. */
  agent: 'claude' | 'codex' | 'both';
}

export interface SearchHit {
  /** Already formatted for textarea insertion (with @ prefix). */
  insertText: string;
  /** Absolute path for tooltip display. */
  fullPath: string;
  /** 0 = primary, 1..N = index into session.additionalDirs. */
  dirIndex: number;
  mtime: number;
}

export interface ClientListProfilesMsg {
  type: 'list_profiles';
  correlationId: string;
}

export interface ClientSaveProfileMsg {
  type: 'save_profile';
  profile: Profile;
  correlationId: string;
}

export interface ClientDeleteProfileMsg {
  type: 'delete_profile';
  name: string;
  agent: 'claude' | 'codex';
  correlationId: string;
}

export interface ClientSetDefaultProfileMsg {
  type: 'set_default_profile';
  name: string;
  agent: 'claude' | 'codex';
  correlationId: string;
}

export interface ClientListSlashCommandsMsg {
  type: 'list_slash_commands';
  sessionId: string;
  correlationId: string;
}

export interface ClientSearchFilesMsg {
  type: 'search_files';
  sessionId: string;
  query: string;
  correlationId: string;
}

export interface ClientRenameSessionMsg {
  type: 'rename_session';
  sessionId: string;
  name: string;
  correlationId: string;
}

export interface ServerProfileListMsg {
  type: 'profile_list';
  profiles: Profile[];
  correlationId: string;
}

export interface ServerProfileSavedMsg {
  type: 'profile_saved';
  profile: Profile;
  correlationId: string;
}

export interface ServerProfileDeletedMsg {
  type: 'profile_deleted';
  name: string;
  agent: 'claude' | 'codex';
  correlationId: string;
}

export interface ServerProfileDefaultSetMsg {
  type: 'profile_default_set';
  name: string;
  agent: 'claude' | 'codex';
  correlationId: string;
}

export interface ServerSlashCommandsListMsg {
  type: 'slash_commands_list';
  commands: SlashCommand[];
  correlationId: string;
}

export interface ServerFileSearchResultsMsg {
  type: 'file_search_results';
  hits: SearchHit[];
  truncated: boolean;
  correlationId: string;
}

export interface ServerSessionRenamedMsg {
  type: 'session_renamed';
  sessionId: string;
  name: string;
  correlationId: string;
}
```

Locate the existing `ClientStartMsg` interface (`type: 'start'`) and extend it:

```ts
export interface ClientStartMsg {
  type: 'start';
  agent: 'claude' | 'codex';
  /** Phase 1-5: single working dir. Still supported for backward compat. */
  projectPath?: string;
  /** Phase 6: multiple working dirs (first = primary cwd). If both `dirs` and `projectPath` present, `dirs` wins. */
  dirs?: string[];
  account?: string;
  correlationId?: string;
}
```

(Adjust to match the existing field set — preserve all existing fields.)

Locate `ServerErrorMsg.code` union and extend with 6 new codes:

```ts
  | 'profile_invalid_name'
  | 'profile_dirs_disallowed'
  | 'profile_not_found'
  | 'session_name_invalid'
  | 'file_search_failed'
  | 'slash_commands_failed'
```

Add new variants to `ClientMsg` and `ServerMsg` discriminated unions.

- [ ] **Step 3: Mirror byte-identically into `apps/web/src/types/protocol.ts`**

Copy all the same interfaces, the `ClientStartMsg` extension, the 6 new error codes, and the union member additions.

- [ ] **Step 4: Verify both type-check clean**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npx tsc --noEmit -p packages/bridge/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
```

- [ ] **Step 5: Verify byte-identical**

```bash
diff <(grep -A 250 'Phase 6' /Volumes/WDSSD/Code/mac-remote-terminal/packages/bridge/src/types.ts) <(grep -A 250 'Phase 6' /Volumes/WDSSD/Code/mac-remote-terminal/apps/web/src/types/protocol.ts)
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add packages/bridge/src/types.ts apps/web/src/types/protocol.ts
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(types): add Phase 6 protocol types (profiles, slash, search, rename)"
```

---

## Task 2: `profile-store.ts` — disk-persisted profiles with atomic writes

**Files:**
- Create: `packages/bridge/src/profile-store.ts`
- Create: `packages/bridge/src/__tests__/profile-store.test.ts`

Mirror Phase 5's SessionRegistry architecture: serialized in-process write queue, unique tmp filenames, fsync before rename, mode 0o600, ENOENT + corrupt-fallback.

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/profile-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileStore } from '../profile-store';

describe('ProfileStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pfx-'));
    path = join(dir, 'profiles.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('load() returns empty when file missing', async () => {
    const s = new ProfileStore(path);
    await s.load();
    expect(s.list()).toEqual([]);
  });

  it('add() persists and load() restores', async () => {
    const s1 = new ProfileStore(path);
    await s1.load();
    await s1.add({
      name: 'frontend',
      agent: 'claude',
      dirs: ['/tmp/a', '/tmp/b'],
      account: null,
      default: true,
    });
    const s2 = new ProfileStore(path);
    await s2.load();
    expect(s2.get('frontend', 'claude')?.dirs).toEqual(['/tmp/a', '/tmp/b']);
  });

  it('setDefault unsets prior default for the same agent', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await s.add({ name: 'a', agent: 'claude', dirs: ['/x'], account: null, default: true });
    await s.add({ name: 'b', agent: 'claude', dirs: ['/y'], account: null, default: false });
    await s.setDefault('b', 'claude');
    expect(s.get('a', 'claude')?.default).toBe(false);
    expect(s.get('b', 'claude')?.default).toBe(true);
  });

  it('setDefault does NOT touch defaults for other agents', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await s.add({ name: 'cl-a', agent: 'claude', dirs: ['/x'], account: null, default: true });
    await s.add({ name: 'cx-a', agent: 'codex', dirs: ['/y'], account: null, default: true });
    await s.add({ name: 'cl-b', agent: 'claude', dirs: ['/z'], account: null, default: false });
    await s.setDefault('cl-b', 'claude');
    expect(s.get('cl-a', 'claude')?.default).toBe(false);
    expect(s.get('cx-a', 'codex')?.default).toBe(true); // codex untouched
  });

  it('add rejects duplicate name within same agent', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await s.add({ name: 'foo', agent: 'claude', dirs: ['/x'], account: null, default: false });
    await expect(
      s.add({ name: 'Foo', agent: 'claude', dirs: ['/y'], account: null, default: false }),
    ).rejects.toMatchObject({ code: 'profile_invalid_name' });
  });

  it('add allows same name across agents', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await s.add({ name: 'shared', agent: 'claude', dirs: ['/x'], account: null, default: false });
    await s.add({ name: 'shared', agent: 'codex', dirs: ['/y'], account: null, default: false });
    expect(s.list()).toHaveLength(2);
  });

  it('add rejects bad name (empty / regex mismatch)', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await expect(
      s.add({ name: '', agent: 'claude', dirs: ['/x'], account: null, default: false }),
    ).rejects.toMatchObject({ code: 'profile_invalid_name' });
    await expect(
      s.add({ name: 'has/slash', agent: 'claude', dirs: ['/x'], account: null, default: false }),
    ).rejects.toMatchObject({ code: 'profile_invalid_name' });
  });

  it('add rejects empty dirs', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await expect(
      s.add({ name: 'foo', agent: 'claude', dirs: [], account: null, default: false }),
    ).rejects.toMatchObject({ code: 'profile_dirs_disallowed' });
  });

  it('remove() persists deletion', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await s.add({ name: 'foo', agent: 'claude', dirs: ['/x'], account: null, default: false });
    await s.remove('foo', 'claude');
    expect(s.get('foo', 'claude')).toBeUndefined();
  });

  it('remove rejects missing profile', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await expect(s.remove('nope', 'claude')).rejects.toMatchObject({ code: 'profile_not_found' });
  });

  it('writes file with mode 0o600', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await s.add({ name: 'x', agent: 'claude', dirs: ['/x'], account: null, default: false });
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
  });

  it('falls back to empty on corrupt file', async () => {
    writeFileSync(path, 'not json', { mode: 0o600 });
    const s = new ProfileStore(path);
    await s.load();
    expect(s.list()).toEqual([]);
  });

  it('serializes 50 concurrent add/setDefault calls without torn writes', async () => {
    const s = new ProfileStore(path);
    await s.load();
    await s.add({ name: 'base', agent: 'claude', dirs: ['/x'], account: null, default: false });
    const ops = Array.from({ length: 50 }, (_, i) =>
      s.add({ name: `p${i}`, agent: 'claude', dirs: ['/x'], account: null, default: false }).catch(() => {}),
    );
    await Promise.all(ops);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    expect(Array.isArray(raw.profiles)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run bridge:test -- profile-store
```

- [ ] **Step 3: Implement `packages/bridge/src/profile-store.ts`**

```ts
import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import type { Profile } from './types.js';

interface ProfilesFile {
  profiles: Profile[];
}

const NAME_REGEX = /^[A-Za-z0-9 _-]{1,40}$/;

function profileError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export class ProfileStore {
  private state: ProfilesFile = { profiles: [] };
  private writeQueue: Promise<void> = Promise.resolve();
  private writeCounter = 0;
  private loaded = false;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const buf = await fsp.readFile(this.path, 'utf-8');
      const parsed = JSON.parse(buf) as ProfilesFile;
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.profiles)) {
        this.state = parsed;
      } else {
        this.state = { profiles: [] };
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') console.error('[profile-store] load failed, starting empty:', err);
      this.state = { profiles: [] };
    }
    this.loaded = true;
  }

  list(): Profile[] {
    return [...this.state.profiles];
  }

  get(name: string, agent: 'claude' | 'codex'): Profile | undefined {
    return this.state.profiles.find(
      (p) => p.agent === agent && p.name.toLowerCase() === name.toLowerCase(),
    );
  }

  async add(profile: Profile): Promise<void> {
    this.assertLoaded();
    if (!NAME_REGEX.test(profile.name)) {
      throw profileError('profile_invalid_name', `Invalid name: ${profile.name}`);
    }
    if (this.get(profile.name, profile.agent)) {
      throw profileError('profile_invalid_name', `Profile name already exists: ${profile.name}`);
    }
    if (!Array.isArray(profile.dirs) || profile.dirs.length === 0) {
      throw profileError('profile_dirs_disallowed', 'Profile must include at least one dir');
    }
    if (profile.default) {
      this.unsetDefaultsFor(profile.agent);
    }
    this.state.profiles.push(profile);
    await this.persist();
  }

  async update(
    name: string,
    agent: 'claude' | 'codex',
    patch: Partial<Profile>,
  ): Promise<void> {
    this.assertLoaded();
    const existing = this.get(name, agent);
    if (!existing) throw profileError('profile_not_found', `Profile not found: ${name}/${agent}`);
    const next = { ...existing, ...patch };
    if (patch.name && !NAME_REGEX.test(patch.name)) {
      throw profileError('profile_invalid_name', `Invalid name: ${patch.name}`);
    }
    if (next.dirs.length === 0) {
      throw profileError('profile_dirs_disallowed', 'Profile must include at least one dir');
    }
    if (patch.default === true) this.unsetDefaultsFor(agent);
    this.state.profiles = this.state.profiles.map((p) =>
      p.agent === agent && p.name.toLowerCase() === name.toLowerCase() ? next : p,
    );
    await this.persist();
  }

  async remove(name: string, agent: 'claude' | 'codex'): Promise<void> {
    this.assertLoaded();
    const existing = this.get(name, agent);
    if (!existing) throw profileError('profile_not_found', `Profile not found: ${name}/${agent}`);
    this.state.profiles = this.state.profiles.filter(
      (p) => !(p.agent === agent && p.name.toLowerCase() === name.toLowerCase()),
    );
    await this.persist();
  }

  async setDefault(name: string, agent: 'claude' | 'codex'): Promise<void> {
    this.assertLoaded();
    const existing = this.get(name, agent);
    if (!existing) throw profileError('profile_not_found', `Profile not found: ${name}/${agent}`);
    this.unsetDefaultsFor(agent);
    this.state.profiles = this.state.profiles.map((p) =>
      p.agent === agent && p.name.toLowerCase() === name.toLowerCase()
        ? { ...p, default: true }
        : p,
    );
    await this.persist();
  }

  private unsetDefaultsFor(agent: 'claude' | 'codex'): void {
    this.state.profiles = this.state.profiles.map((p) =>
      p.agent === agent && p.default ? { ...p, default: false } : p,
    );
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('ProfileStore: load() must be awaited before mutations');
  }

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
    this.writeQueue = queued.catch((err) => console.error('[profile-store] persist failed:', err));
    return queued;
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run bridge:test -- profile-store
```

Expected: 13 passed.

- [ ] **Step 5: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add packages/bridge/src/profile-store.ts packages/bridge/src/__tests__/profile-store.test.ts
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(bridge): ProfileStore with atomic writes + 0o600 mode"
```

---

## Task 3: `slash-commands.ts` — scan + cache

**Files:**
- Create: `packages/bridge/src/slash-commands.ts`
- Create: `packages/bridge/src/__tests__/slash-commands.test.ts`

Sources merged with project > user > builtin precedence (project wins on collision).

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/slash-commands.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlashCommandsScanner } from '../slash-commands';

describe('SlashCommandsScanner', () => {
  let homeDir: string;
  let projectDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'sc-home-'));
    projectDir = mkdtempSync(join(tmpdir(), 'sc-proj-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns Claude builtins-only when no scan dirs exist', async () => {
    const s = new SlashCommandsScanner({ homeDir });
    const result = await s.listForSession({ sessionId: 's1', agent: 'claude', primaryCwd: projectDir });
    expect(result.find((c) => c.name === '/help')).toBeDefined();
    expect(result.find((c) => c.name === '/clear')).toBeDefined();
    expect(result.every((c) => c.source === 'builtin')).toBe(true);
  });

  it('returns Codex builtins-only and skips ~/.claude/commands scan for codex sessions', async () => {
    mkdirSync(join(homeDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(
      join(homeDir, '.claude', 'commands', 'foo.md'),
      '---\ndescription: foo cmd\n---\n',
    );
    const s = new SlashCommandsScanner({ homeDir });
    const result = await s.listForSession({ sessionId: 's1', agent: 'codex', primaryCwd: projectDir });
    expect(result.find((c) => c.name === '/foo')).toBeUndefined();
    expect(result.find((c) => c.name === '/help')).toBeDefined();
  });

  it('user-level scan picks up commands with frontmatter description', async () => {
    mkdirSync(join(homeDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(
      join(homeDir, '.claude', 'commands', 'commit.md'),
      '---\ndescription: write a git commit\n---\nbody here\n',
    );
    const s = new SlashCommandsScanner({ homeDir });
    const result = await s.listForSession({ sessionId: 's1', agent: 'claude', primaryCwd: projectDir });
    const cmd = result.find((c) => c.name === '/commit');
    expect(cmd).toBeDefined();
    expect(cmd?.source).toBe('user');
    expect(cmd?.description).toBe('write a git commit');
  });

  it('user-level scan falls back to first non-frontmatter line when no description', async () => {
    mkdirSync(join(homeDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(homeDir, '.claude', 'commands', 'notes.md'), 'My notes command\nmore body\n');
    const s = new SlashCommandsScanner({ homeDir });
    const result = await s.listForSession({ sessionId: 's1', agent: 'claude', primaryCwd: projectDir });
    expect(result.find((c) => c.name === '/notes')?.description).toBe('My notes command');
  });

  it('project-level wins on collision with user-level', async () => {
    mkdirSync(join(homeDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(homeDir, '.claude', 'commands', 'shared.md'), 'user version');
    mkdirSync(join(projectDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(projectDir, '.claude', 'commands', 'shared.md'), 'project version');
    const s = new SlashCommandsScanner({ homeDir });
    const result = await s.listForSession({ sessionId: 's1', agent: 'claude', primaryCwd: projectDir });
    const cmd = result.find((c) => c.name === '/shared');
    expect(cmd?.source).toBe('project');
    expect(cmd?.description).toBe('project version');
  });

  it('60s cache: two calls within window scan filesystem only once', async () => {
    const s = new SlashCommandsScanner({ homeDir });
    const spy = vi.spyOn(s as unknown as { scanDir: () => Promise<unknown> }, 'scanDir');
    await s.listForSession({ sessionId: 's1', agent: 'claude', primaryCwd: projectDir });
    await s.listForSession({ sessionId: 's1', agent: 'claude', primaryCwd: projectDir });
    expect(spy.mock.calls.length).toBeLessThan(4); // 2 dirs × 2 calls = 4 if no cache
  });

  it('skips dir on permission error silently', async () => {
    // Create a dir then chmod 000 to simulate permission denied.
    mkdirSync(join(homeDir, '.claude', 'commands'), { recursive: true });
    // chmod test omitted — just verify no throw on missing dir.
    const s = new SlashCommandsScanner({ homeDir });
    const result = await s.listForSession({ sessionId: 's1', agent: 'claude', primaryCwd: '/nonexistent' });
    expect(result.length).toBeGreaterThan(0); // builtins still returned
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (module not found)**

```bash
npm run bridge:test -- slash-commands
```

- [ ] **Step 3: Implement `packages/bridge/src/slash-commands.ts`**

```ts
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { SlashCommand } from './types.js';

const SCAN_CAP = 200;
const CACHE_TTL_MS = 60_000;

const CLAUDE_BUILTINS: SlashCommand[] = [
  { name: '/help', description: 'show help', source: 'builtin', agent: 'claude' },
  { name: '/clear', description: 'reset conversation', source: 'builtin', agent: 'claude' },
  { name: '/compact', description: 'reduce context', source: 'builtin', agent: 'claude' },
  { name: '/cost', description: 'show usage', source: 'builtin', agent: 'claude' },
  { name: '/status', description: 'show session status', source: 'builtin', agent: 'claude' },
  { name: '/agents', description: 'list subagents', source: 'builtin', agent: 'claude' },
  { name: '/memory', description: 'manage memory', source: 'builtin', agent: 'claude' },
  { name: '/exit', description: 'end session', source: 'builtin', agent: 'claude' },
  { name: '/init', description: 'init project', source: 'builtin', agent: 'claude' },
  { name: '/install-github-app', description: 'install GitHub app', source: 'builtin', agent: 'claude' },
  { name: '/login', description: 'log in', source: 'builtin', agent: 'claude' },
  { name: '/logout', description: 'log out', source: 'builtin', agent: 'claude' },
  { name: '/model', description: 'switch model', source: 'builtin', agent: 'claude' },
  { name: '/permissions', description: 'manage permissions', source: 'builtin', agent: 'claude' },
  { name: '/review', description: 'request review', source: 'builtin', agent: 'claude' },
];

const CODEX_BUILTINS: SlashCommand[] = [
  { name: '/help', description: 'show help', source: 'builtin', agent: 'codex' },
  { name: '/clear', description: 'reset conversation', source: 'builtin', agent: 'codex' },
  { name: '/exit', description: 'end session', source: 'builtin', agent: 'codex' },
];

interface ScannerOpts {
  homeDir: string;
}

export class SlashCommandsScanner {
  private cache = new Map<string, { value: SlashCommand[]; expiresAt: number }>();

  constructor(private readonly opts: ScannerOpts) {}

  async listForSession(session: {
    sessionId: string;
    agent: 'claude' | 'codex';
    primaryCwd: string;
  }): Promise<SlashCommand[]> {
    const cacheKey = `${session.sessionId}:${session.agent}:${session.primaryCwd}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.value;

    const builtins = session.agent === 'claude' ? CLAUDE_BUILTINS : CODEX_BUILTINS;

    if (session.agent === 'codex') {
      this.cache.set(cacheKey, { value: builtins, expiresAt: Date.now() + CACHE_TTL_MS });
      return builtins;
    }

    // Claude only: scan user + project dirs
    const userCmds = await this.scanDir(join(this.opts.homeDir, '.claude', 'commands'), 'user');
    const projectCmds = await this.scanDir(
      join(session.primaryCwd, '.claude', 'commands'),
      'project',
    );

    // Merge with project > user > builtin precedence (project wins on collision).
    const map = new Map<string, SlashCommand>();
    for (const c of builtins) map.set(c.name, c);
    for (const c of userCmds) map.set(c.name, c);
    for (const c of projectCmds) map.set(c.name, c);

    const result = [...map.values()];
    this.cache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  }

  invalidateCache(sessionId?: string): void {
    if (!sessionId) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.cache.delete(key);
    }
  }

  private async scanDir(
    dir: string,
    source: 'user' | 'project',
  ): Promise<SlashCommand[]> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .slice(0, SCAN_CAP)
      .sort((a, b) => a.name.localeCompare(b.name));
    const out: SlashCommand[] = [];
    for (const f of files) {
      try {
        const content = await fsp.readFile(join(dir, f.name), 'utf-8');
        const description = parseDescription(content);
        out.push({
          name: '/' + f.name.slice(0, -3), // strip .md
          description,
          source,
          agent: 'claude',
        });
      } catch {
        // skip unreadable file
      }
    }
    return out;
  }
}

function parseDescription(content: string): string {
  const lines = content.split('\n');
  // Frontmatter: lines between `---` markers at start of file
  if (lines[0]?.trim() === '---') {
    let i = 1;
    while (i < lines.length && lines[i]?.trim() !== '---') {
      const m = /^description:\s*(.+)$/.exec(lines[i] ?? '');
      if (m) return m[1]!.trim();
      i++;
    }
    // Skip past closing ---
    i++;
    // Fall back to first non-empty line after frontmatter
    while (i < lines.length) {
      const t = lines[i]!.trim();
      if (t.length > 0) return t;
      i++;
    }
    return '';
  }
  // No frontmatter; return first non-empty line
  for (const line of lines) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return '';
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run bridge:test -- slash-commands
```

- [ ] **Step 5: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add packages/bridge/src/slash-commands.ts packages/bridge/src/__tests__/slash-commands.test.ts
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(bridge): SlashCommandsScanner with builtins + user/project scan + 60s cache"
```

---

## Task 4: `file-search.ts` — bounded walk + fuzzy + recency

**Files:**
- Create: `packages/bridge/src/file-search.ts`
- Create: `packages/bridge/src/__tests__/file-search.test.ts`

Bounded walk (5000-file cap), denylist + .gitignore, fuzzy + recency ranking, 30s cache, multi-dir-aware insertText.

- [ ] **Step 1: Verify `ignore` package availability**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
node -e "console.log(require.resolve('ignore'))" 2>&1 || echo "NEEDS INSTALL"
```

If "NEEDS INSTALL" → install:

```bash
npm install --workspace packages/bridge ignore
```

If already a transitive dep, add to bridge's direct dependencies anyway:

```bash
npm install --workspace packages/bridge ignore
```

- [ ] **Step 2: Write the failing test**

`packages/bridge/src/__tests__/file-search.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSearch } from '../file-search';

function setMtime(path: string, secAgo: number): void {
  const t = Date.now() / 1000 - secAgo;
  utimesSync(path, t, t);
}

describe('FileSearch', () => {
  let primary: string;
  let secondary: string;
  let getDirs: () => string[];

  beforeEach(() => {
    primary = mkdtempSync(join(tmpdir(), 'fs-prim-'));
    secondary = mkdtempSync(join(tmpdir(), 'fs-sec-'));
    getDirs = () => [primary, secondary];
  });

  afterEach(() => {
    rmSync(primary, { recursive: true, force: true });
    rmSync(secondary, { recursive: true, force: true });
  });

  it('empty query returns top 50 by mtime desc', async () => {
    for (let i = 0; i < 60; i++) {
      const p = join(primary, `file-${i}.ts`);
      writeFileSync(p, '');
      setMtime(p, i); // i=0 newest
    }
    const s = new FileSearch({ getDirsForSession: getDirs });
    const result = await s.search('s1', '');
    expect(result.hits).toHaveLength(50);
    expect(result.hits[0]!.fullPath).toBe(join(primary, 'file-0.ts'));
  });

  it('basename match scores higher than path-only match', async () => {
    writeFileSync(join(primary, 'auth.ts'), '');
    mkdirSync(join(primary, 'lib'));
    writeFileSync(join(primary, 'lib', 'notauthorize.ts'), '');
    const s = new FileSearch({ getDirsForSession: getDirs });
    const result = await s.search('s1', 'auth');
    expect(result.hits[0]!.fullPath.endsWith('/auth.ts')).toBe(true);
  });

  it('multi-dir insertText format: primary uses bare path, additional uses dir-basename prefix', async () => {
    writeFileSync(join(primary, 'a.ts'), '');
    writeFileSync(join(secondary, 'b.ts'), '');
    const s = new FileSearch({ getDirsForSession: getDirs });
    const result = await s.search('s1', '');
    const a = result.hits.find((h) => h.fullPath.endsWith('/a.ts'));
    const b = result.hits.find((h) => h.fullPath.endsWith('/b.ts'));
    expect(a?.insertText).toBe('@a.ts');
    expect(a?.dirIndex).toBe(0);
    const secBase = secondary.split('/').pop()!;
    expect(b?.insertText).toBe(`@${secBase}/b.ts`);
    expect(b?.dirIndex).toBe(1);
  });

  it('respects denylist (node_modules, .git)', async () => {
    writeFileSync(join(primary, 'normal.ts'), '');
    mkdirSync(join(primary, 'node_modules'));
    writeFileSync(join(primary, 'node_modules', 'foo.ts'), '');
    mkdirSync(join(primary, '.git'));
    writeFileSync(join(primary, '.git', 'HEAD'), '');
    const s = new FileSearch({ getDirsForSession: getDirs });
    const result = await s.search('s1', '');
    expect(result.hits.find((h) => h.fullPath.includes('node_modules'))).toBeUndefined();
    expect(result.hits.find((h) => h.fullPath.includes('.git'))).toBeUndefined();
  });

  it('respects .gitignore', async () => {
    writeFileSync(join(primary, '.gitignore'), 'secret/\n');
    mkdirSync(join(primary, 'secret'));
    writeFileSync(join(primary, 'secret', 'nope.ts'), '');
    writeFileSync(join(primary, 'visible.ts'), '');
    const s = new FileSearch({ getDirsForSession: getDirs });
    const result = await s.search('s1', '');
    expect(result.hits.find((h) => h.fullPath.includes('/secret/'))).toBeUndefined();
    expect(result.hits.find((h) => h.fullPath.endsWith('/visible.ts'))).toBeDefined();
  });

  it('5000-cap truncated flag', async () => {
    for (let i = 0; i < 5050; i++) writeFileSync(join(primary, `f-${i}.ts`), '');
    const s = new FileSearch({ getDirsForSession: getDirs });
    const result = await s.search('s1', '');
    expect(result.truncated).toBe(true);
  });

  it('30s cache: second search within window walks once', async () => {
    writeFileSync(join(primary, 'a.ts'), '');
    const s = new FileSearch({ getDirsForSession: getDirs });
    await s.search('s1', '');
    // delete a file then search again — if the cache is hit, the missing file would NOT cause stale results
    rmSync(join(primary, 'a.ts'));
    writeFileSync(join(primary, 'b.ts'), '');
    const r = await s.search('s1', '');
    // If cache hits, the result still has 'a.ts' (cached)
    // Note: this test asserts cache behavior; may be brittle if walk isn't fully sync
    expect(r.hits.find((h) => h.fullPath.endsWith('/a.ts'))).toBeDefined();
  });
});
```

- [ ] **Step 3: Run test — expect FAIL**

- [ ] **Step 4: Implement `packages/bridge/src/file-search.ts`**

```ts
import { promises as fsp } from 'node:fs';
import { join, basename, relative } from 'node:path';
import ignoreLib from 'ignore';
import type { SearchHit } from './types.js';

const SURFACE_CAP = 50;
const FILE_CAP_DEFAULT = 5000;
const CACHE_TTL_MS = 30_000;
const PROMPT_TRUNCATE = 80;

const DENY_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'target',
  '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo', '.vercel',
  '.idea', '.vscode', '__pycache__', '.pytest_cache', '.mypy_cache',
  'coverage', '.nyc_output', 'venv', '.venv', 'env', '.env',
]);

interface WalkedFile {
  fullPath: string;
  dirIndex: number;
  rootDir: string;
  mtime: number;
}

interface FileSearchOpts {
  getDirsForSession: (sessionId: string) => string[];
  fileCap?: number;
}

export class FileSearch {
  private cache = new Map<string, { files: WalkedFile[]; truncated: boolean; expiresAt: number }>();

  constructor(private readonly opts: FileSearchOpts) {}

  invalidate(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  async search(
    sessionId: string,
    query: string,
  ): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    const cached = this.cache.get(sessionId);
    let walked: WalkedFile[];
    let truncated: boolean;
    if (cached && Date.now() < cached.expiresAt) {
      walked = cached.files;
      truncated = cached.truncated;
    } else {
      const dirs = this.opts.getDirsForSession(sessionId);
      const result = await walkAll(dirs, this.opts.fileCap ?? FILE_CAP_DEFAULT);
      walked = result.files;
      truncated = result.truncated;
      this.cache.set(sessionId, {
        files: walked,
        truncated,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }
    const hits = rankAndFormat(walked, query);
    return { hits, truncated };
  }
}

async function walkAll(
  dirs: string[],
  cap: number,
): Promise<{ files: WalkedFile[]; truncated: boolean }> {
  const out: WalkedFile[] = [];
  let truncated = false;
  for (let i = 0; i < dirs.length; i++) {
    const root = dirs[i]!;
    const ig = await loadGitignoreChain(root);
    const walked = await walkDir(root, root, i, ig, cap - out.length);
    out.push(...walked.files);
    if (walked.hitCap) {
      truncated = true;
      break;
    }
  }
  return { files: out, truncated };
}

async function loadGitignoreChain(rootDir: string): Promise<ReturnType<typeof ignoreLib>> {
  const ig = ignoreLib();
  try {
    const content = await fsp.readFile(join(rootDir, '.gitignore'), 'utf-8');
    ig.add(content);
  } catch {
    // No .gitignore at root — that's fine
  }
  return ig;
}

async function walkDir(
  rootDir: string,
  curDir: string,
  dirIndex: number,
  ig: ReturnType<typeof ignoreLib>,
  remaining: number,
): Promise<{ files: WalkedFile[]; hitCap: boolean }> {
  const out: WalkedFile[] = [];
  if (remaining <= 0) return { files: out, hitCap: true };

  let entries;
  try {
    entries = await fsp.readdir(curDir, { withFileTypes: true });
  } catch {
    return { files: out, hitCap: false };
  }

  for (const e of entries) {
    if (out.length >= remaining) return { files: out, hitCap: true };
    if (e.isSymbolicLink()) continue; // never follow

    const fullPath = join(curDir, e.name);
    const rel = relative(rootDir, fullPath);

    if (e.isDirectory()) {
      if (DENY_DIRS.has(e.name)) continue;
      // .gitignore: dirs need trailing slash for matching
      if (ig.ignores(rel + '/')) continue;
      const sub = await walkDir(rootDir, fullPath, dirIndex, ig, remaining - out.length);
      out.push(...sub.files);
      if (sub.hitCap) return { files: out, hitCap: true };
    } else if (e.isFile()) {
      if (ig.ignores(rel)) continue;
      try {
        const stat = await fsp.stat(fullPath);
        out.push({
          fullPath,
          dirIndex,
          rootDir,
          mtime: stat.mtimeMs,
        });
      } catch {
        // skip
      }
    }
  }

  return { files: out, hitCap: false };
}

function rankAndFormat(walked: WalkedFile[], query: string): SearchHit[] {
  const q = query.toLowerCase();
  const scored: Array<{ file: WalkedFile; score: number }> = [];

  for (const f of walked) {
    const name = basename(f.fullPath).toLowerCase();
    const path = f.fullPath.toLowerCase();

    let s: number;
    if (q === '') {
      s = f.mtime;
    } else if (name === q) s = 1000;
    else if (name.startsWith(q)) s = 500;
    else if (name.includes(q)) s = 200;
    else if (path.includes(q)) s = 50;
    else continue;

    if (q !== '') {
      const ageDays = Math.max(0, (Date.now() - f.mtime) / 86_400_000);
      s += Math.max(0, 100 - ageDays * (100 / 30));
    }
    scored.push({ file: f, score: s });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, SURFACE_CAP).map(({ file: f }) => {
    const rel = relative(f.rootDir, f.fullPath);
    const insertText =
      f.dirIndex === 0 ? `@${rel}` : `@${basename(f.rootDir)}/${rel}`;
    return {
      insertText,
      fullPath: f.fullPath,
      dirIndex: f.dirIndex,
      mtime: f.mtime,
    };
  });
}
```

- [ ] **Step 5: Run test — expect PASS**

- [ ] **Step 6: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add packages/bridge/src/file-search.ts packages/bridge/src/__tests__/file-search.test.ts packages/bridge/package.json package-lock.json
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(bridge): FileSearch with bounded walk + denylist + .gitignore + 30s cache"
```

---

## Task 5: `notifier.ts` — Telegram client

**Files:**
- Create: `packages/bridge/src/notifier.ts`
- Create: `packages/bridge/src/__tests__/notifier.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/notifier.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Notifier, formatDuration } from '../notifier';

describe('Notifier', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('env unset → no-op stub does NOT call fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const n = new Notifier({ minDurationMs: 0 });
    n.noteInput('s1');
    await n.noteResult({
      webSessionId: 's1',
      name: 'test',
      agent: 'claude',
      projectPath: '/x',
      transcriptPath: '/x',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 0,
      account: null,
      additionalDirs: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('threshold 0 + env set → fetches on every result', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const n = new Notifier({ token: 'TOK', chatId: '123', minDurationMs: 0 });
    n.noteInput('s1');
    // Force a tiny delay
    await new Promise((r) => setTimeout(r, 10));
    await n.noteResult({
      webSessionId: 's1',
      name: 'test',
      agent: 'claude',
      projectPath: '/x',
      transcriptPath: '/x',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 0,
      account: null,
      additionalDirs: [],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0]!;
    expect((call[0] as string).includes('/botTOK/sendMessage')).toBe(true);
  });

  it('threshold filter: short turn does NOT fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const n = new Notifier({ token: 'TOK', chatId: '123', minDurationMs: 60_000 });
    n.noteInput('s1');
    await new Promise((r) => setTimeout(r, 10));
    await n.noteResult({
      webSessionId: 's1',
      name: 'test',
      agent: 'claude',
      projectPath: '/x',
      transcriptPath: '/x',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 0,
      account: null,
      additionalDirs: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('PUBLIC_URL set → message contains link', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const n = new Notifier({
      token: 'TOK',
      chatId: '123',
      minDurationMs: 0,
      publicUrl: 'http://100.x.x.x:7777',
    });
    n.noteInput('s1');
    await n.noteResult({
      webSessionId: 'web-abc',
      name: 'test name',
      agent: 'claude',
      projectPath: '/x',
      transcriptPath: '/x',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 0,
      account: null,
      additionalDirs: [],
    });
    const call = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((call[1] as { body: string }).body) as { text: string };
    expect(body.text).toContain('http://100.x.x.x:7777/session/web-abc');
  });

  it('PUBLIC_URL trailing slash sanitized', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const n = new Notifier({
      token: 'TOK',
      chatId: '123',
      minDurationMs: 0,
      publicUrl: 'http://100.x.x.x:7777/',
    });
    n.noteInput('s1');
    await n.noteResult({
      webSessionId: 'abc',
      name: 'x',
      agent: 'claude',
      projectPath: '/x',
      transcriptPath: '/x',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 0,
      account: null,
      additionalDirs: [],
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as { body: string }).body,
    ) as { text: string };
    expect(body.text).toContain('http://100.x.x.x:7777/session/abc');
    expect(body.text).not.toContain('//session');
  });

  it('formatDuration', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_725_000)).toBe('1h 2m 5s');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement `packages/bridge/src/notifier.ts`**

```ts
import type { RegistryEntry } from './session-registry.js';

interface NotifierOpts {
  token?: string;
  chatId?: string;
  minDurationMs: number;
  publicUrl?: string;
}

export class Notifier {
  private readonly enabled: boolean;
  private turnStart = new Map<string, number>();
  private failureCounter = new Map<string, number>();

  constructor(private readonly opts: NotifierOpts) {
    this.enabled = !!(opts.token && opts.chatId);
  }

  noteInput(sessionId: string): void {
    if (!this.enabled) return;
    this.turnStart.set(sessionId, Date.now());
  }

  noteSessionEnd(sessionId: string): void {
    this.turnStart.delete(sessionId);
    this.failureCounter.delete(sessionId);
  }

  async noteResult(session: RegistryEntry): Promise<void> {
    if (!this.enabled) return;
    const start = this.turnStart.get(session.webSessionId);
    this.turnStart.delete(session.webSessionId);
    if (start === undefined) return;
    const duration = Date.now() - start;
    if (duration < this.opts.minDurationMs) return;

    const text = this.buildText(session, duration);
    try {
      const url = `https://api.telegram.org/bot${this.opts.token}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.opts.chatId, text }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      this.failureCounter.delete(session.webSessionId);
    } catch (err: unknown) {
      const count = (this.failureCounter.get(session.webSessionId) ?? 0) + 1;
      this.failureCounter.set(session.webSessionId, count);
      console.error('[notifier] sendMessage failed:', (err as Error).message);
      if (count === 5) {
        console.error(
          '[notifier] 5 consecutive failures — verify BRIDGE_TELEGRAM_BOT_TOKEN + BRIDGE_TELEGRAM_CHAT_ID',
        );
      }
    }
  }

  private buildText(session: RegistryEntry, duration: number): string {
    const name = session.name ?? '(unnamed session)';
    const dur = formatDuration(duration);
    const lines = [`Session '${name}' completed`, `took ${dur}`];
    if (this.opts.publicUrl) {
      const base = this.opts.publicUrl.replace(/\/$/, '');
      lines.push(`${base}/session/${session.webSessionId}`);
    }
    return lines.join('\n');
  }
}

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add packages/bridge/src/notifier.ts packages/bridge/src/__tests__/notifier.test.ts
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(bridge): Notifier with Telegram bot, threshold filter, failure counter"
```

---

## Task 6: Registry shape extension (name + additionalDirs)

**Files:**
- Modify: `packages/bridge/src/session-registry.ts`
- Modify: `packages/bridge/src/__tests__/session-registry.test.ts`

`RegistryEntry` gains `name: string | null` + `additionalDirs: string[]`. Migration on load: existing entries get `name: null` + `additionalDirs: []`.

- [ ] **Step 1: Append failing tests to `packages/bridge/src/__tests__/session-registry.test.ts`**

```ts
it('migrates legacy entries (no name / additionalDirs) on load', async () => {
  // Write a legacy-shape file by hand
  writeFileSync(registryPath, JSON.stringify({
    sessions: {
      'web-1': {
        webSessionId: 'web-1',
        agent: 'claude',
        projectPath: '/tmp/p',
        transcriptPath: '/tmp/t',
        claudeSessionId: null,
        codexSessionId: null,
        createdAt: 0,
        account: null,
        // No name / additionalDirs
      },
    },
  }, null, 2), { mode: 0o600 });
  const reg = new SessionRegistry(registryPath);
  await reg.load();
  const entry = reg.get('web-1');
  expect(entry?.name).toBe(null);
  expect(entry?.additionalDirs).toEqual([]);
});

it('persists new fields name + additionalDirs', async () => {
  const reg = new SessionRegistry(registryPath);
  await reg.load();
  await reg.add({
    webSessionId: 'web-1',
    agent: 'claude',
    projectPath: '/tmp/a',
    transcriptPath: '/tmp/t',
    claudeSessionId: null,
    codexSessionId: null,
    createdAt: 1000,
    account: null,
    name: 'fix login',
    additionalDirs: ['/tmp/b', '/tmp/c'],
  });
  const reg2 = new SessionRegistry(registryPath);
  await reg2.load();
  expect(reg2.get('web-1')?.name).toBe('fix login');
  expect(reg2.get('web-1')?.additionalDirs).toEqual(['/tmp/b', '/tmp/c']);
});
```

(Adapt to your existing test imports.)

- [ ] **Step 2: Update `RegistryEntry` interface in `packages/bridge/src/session-registry.ts`**

```ts
export interface RegistryEntry {
  webSessionId: string;
  agent: 'claude' | 'codex';
  projectPath: string;
  transcriptPath: string;
  claudeSessionId: string | null;
  codexSessionId: string | null;
  createdAt: number;
  account: string | null;

  // Phase 6 additions
  name: string | null;
  additionalDirs: string[];
}
```

- [ ] **Step 3: Add migration logic to `load()`**

In the `load()` method, after parsing the JSON, normalize each entry:

```ts
for (const [id, raw] of Object.entries(this.state.sessions)) {
  const entry = raw as Partial<RegistryEntry>;
  this.state.sessions[id] = {
    webSessionId: entry.webSessionId ?? id,
    agent: entry.agent!,
    projectPath: entry.projectPath!,
    transcriptPath: entry.transcriptPath!,
    claudeSessionId: entry.claudeSessionId ?? null,
    codexSessionId: entry.codexSessionId ?? null,
    createdAt: entry.createdAt ?? 0,
    account: entry.account ?? null,
    name: entry.name ?? null,
    additionalDirs: entry.additionalDirs ?? [],
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run bridge:test -- session-registry
```

- [ ] **Step 5: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add packages/bridge/src/session-registry.ts packages/bridge/src/__tests__/session-registry.test.ts
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(bridge): RegistryEntry gains name + additionalDirs with on-load migration"
```

---

## Task 7: SessionManager multi-dir + auto-name + rename + notifier subscription

**Files:**
- Modify: `packages/bridge/src/session.ts`
- Modify: `packages/bridge/src/claude-process.ts`
- Modify: `packages/bridge/src/codex-process.ts`
- Modify: `packages/bridge/src/__tests__/session.test.ts`

This is the largest task in P6. Read the existing `session.ts` carefully before editing.

### 7a. Driver changes

In `claude-process.ts`, extend `ClaudeProcessOpts`:

```ts
interface ClaudeProcessOpts {
  // ... existing fields
  /** Phase 6: additional working dirs passed as `--add-dir` flags. */
  additionalDirs?: string[];
}
```

In the spawn-arg construction, prepend `--add-dir` flags AFTER the existing `resumeArgs` (P5) but BEFORE `-p`:

```ts
const addDirArgs = (opts.additionalDirs ?? []).flatMap((d) => ['--add-dir', d]);
// Combine: [resumeArgs, addDirArgs, ...existingFlags]
```

In `codex-process.ts`, extend `CodexProcessOpts`:

```ts
interface CodexProcessOpts {
  // ... existing fields
  /** Phase 6: additional dirs stored for diagnostics; NOT passed to spawn (Codex CLI lacks --add-dir). */
  additionalDirs?: string[];
}
```

In the constructor body, log a one-time warning if `additionalDirs.length > 0`:

```ts
if (opts.additionalDirs && opts.additionalDirs.length > 0) {
  console.warn(`[codex] ignoring ${opts.additionalDirs.length} additional dir(s) — CLI lacks --add-dir`);
}
```

### 7b. SessionManager changes

In `session.ts`:

1. **`spawnSession()` accepts `dirs: string[]`**: refactor signature to take `dirs` instead of (or alongside) `projectPath`. Validate every dir; primary = `dirs[0]`; additional = `dirs.slice(1)`.

2. **Auto-name on first input**: subscribe to internal session events. When the first `input`-shaped lifecycle event arrives for a session whose `name === null`, set `name = text.slice(0, 60).trim() || '(empty)'` and persist via `registry.update()`.

3. **`renameSession(webSessionId, name)`** method: validate name (trim → reject empty → ≤200 chars → strip control chars); update registry; broadcast `session_renamed`.

4. **Notifier subscription**: in the constructor, accept `notifier: Notifier` opt. Subscribe to broadcast events: `'input'` → `notifier.noteInput()`; `'result'` → fetch entry from registry, call `notifier.noteResult()`.

- [ ] **Step 1: Append failing tests to `packages/bridge/src/__tests__/session.test.ts`**

```ts
it('spawnSession with dirs[a, b, c] passes --add-dir b --add-dir c to Claude', async () => {
  const captured: string[][] = [];
  const mgr = makeMgr({
    driverFactory: (args) => {
      if (args.agent === 'claude') {
        captured.push(args.additionalDirs ?? []);
      }
      return makeMockDriver();
    },
  });
  await mgr.spawnSession({
    agent: 'claude',
    dirs: ['/tmp/a', '/tmp/b', '/tmp/c'],
  });
  expect(captured[0]).toEqual(['/tmp/b', '/tmp/c']);
});

it('spawnSession with codex + multiple dirs uses only dirs[0] (with warning)', async () => {
  const warns: string[] = [];
  const consoleSpy = vi.spyOn(console, 'warn').mockImplementation((msg) => warns.push(String(msg)));
  const mgr = makeMgr();
  await mgr.spawnSession({
    agent: 'codex',
    dirs: ['/tmp/a', '/tmp/b'],
  });
  expect(warns.some((w) => w.includes('codex') && w.includes('ignoring'))).toBe(true);
  consoleSpy.mockRestore();
});

it('first user input auto-sets session.name (truncated 60)', async () => {
  // Use external registry fixture so tests can read it directly. The mgr's
  // own `registry` field is private; pass the SAME registry instance to
  // makeMgr() and assert via the external reference.
  const registry = await makeRegistry();
  const mgr = makeMgr({ registry });
  const sess = await mgr.spawnSession({ agent: 'claude', dirs: ['/tmp/x'] });
  await mgr.handleInput(sess.webSessionId, 'fix login bug in OAuth flow that was reported by QA team');
  const entry = registry.get(sess.webSessionId);
  expect(entry?.name).toBe('fix login bug in OAuth flow that was reported by QA team'.slice(0, 60));
});

it('renameSession validates + persists + broadcasts', async () => {
  const registry = await makeRegistry();
  const mgr = makeMgr({ registry });
  const sess = await mgr.spawnSession({ agent: 'claude', dirs: ['/tmp/x'] });
  const events: { type: string }[] = [];
  mgr.on('broadcast', (e) => events.push(e));
  await mgr.renameSession(sess.webSessionId, 'my session');
  expect(registry.get(sess.webSessionId)?.name).toBe('my session');
  expect(events.some((e) => e.type === 'session_renamed')).toBe(true);
});

it('renameSession rejects empty / overlong / control-char names', async () => {
  const mgr = makeMgr();
  const sess = await mgr.spawnSession({ agent: 'claude', dirs: ['/tmp/x'] });
  await expect(mgr.renameSession(sess.webSessionId, '')).rejects.toMatchObject({ code: 'session_name_invalid' });
  await expect(mgr.renameSession(sess.webSessionId, '   ')).rejects.toMatchObject({ code: 'session_name_invalid' });
  await expect(mgr.renameSession(sess.webSessionId, 'x'.repeat(201))).rejects.toMatchObject({ code: 'session_name_invalid' });
  await expect(mgr.renameSession(sess.webSessionId, 'foo\x00bar')).rejects.toMatchObject({ code: 'session_name_invalid' });
});

it('notifier.noteInput called on input event broadcast', async () => {
  const noteInput = vi.fn();
  const mgr = makeMgr({ notifier: { noteInput, noteResult: vi.fn(), noteSessionEnd: vi.fn() } });
  const sess = await mgr.spawnSession({ agent: 'claude', dirs: ['/tmp/x'] });
  await mgr.handleInput(sess.webSessionId, 'hello');
  expect(noteInput).toHaveBeenCalledWith(sess.webSessionId);
});

it('notifier.noteResult called on result event broadcast', async () => {
  const noteResult = vi.fn();
  const mgr = makeMgr({ notifier: { noteInput: vi.fn(), noteResult, noteSessionEnd: vi.fn() } });
  const sess = await mgr.spawnSession({ agent: 'claude', dirs: ['/tmp/x'] });
  // Simulate result event
  await mgr.handleResult(sess.webSessionId, { duration: 1000 });
  expect(noteResult).toHaveBeenCalled();
});
```

- [ ] **Step 2: Implement SessionManager changes**

In `packages/bridge/src/session.ts`:

```ts
import type { Notifier } from './notifier.js';

// Add to SessionManagerOpts:
interface SessionManagerOpts {
  // ... existing
  notifier?: Notifier;
}

// Inside the class:
private readonly notifier: Notifier | null;

constructor(opts: SessionManagerOpts) {
  // ... existing
  this.notifier = opts.notifier ?? null;
}

// New spawnSession signature:
async spawnSession(input: {
  agent: 'claude' | 'codex';
  dirs: string[];
  account?: string;
}): Promise<{ webSessionId: string }> {
  // 1. Validate every dir is allowed
  for (const d of input.dirs) {
    await this.validateProjectPath(d); // existing helper
  }
  if (input.dirs.length === 0) {
    throw resumeError('project_path_disallowed', 'At least one dir required');
  }
  // Dedup exact-match
  const seen = new Set<string>();
  const dirs = input.dirs.filter((d) => (seen.has(d) ? false : seen.add(d)));

  const primary = dirs[0]!;
  const additionalDirs = dirs.slice(1);

  const webSessionId = this.mintWebSessionId();
  const transcriptPath = this.transcriptPathFor(webSessionId);
  const account = this.resolveAccount(input.agent, input.account);

  await this.registry.add({
    webSessionId,
    agent: input.agent,
    projectPath: primary,
    transcriptPath,
    claudeSessionId: null,
    codexSessionId: null,
    createdAt: Date.now(),
    account: input.account ?? null,
    name: null,
    additionalDirs,
  });

  const driver = this.driverFactory({
    agent: input.agent,
    projectPath: primary,
    account,
    additionalDirs,
  });
  this.registerInternalSession(webSessionId, driver, /* registry entry */);
  this.emitSynthesizedSessionCreated(webSessionId, /* ... */);
  return { webSessionId };
}

// Auto-name handler:
async handleInput(webSessionId: string, text: string): Promise<void> {
  this.notifier?.noteInput(webSessionId);
  const entry = this.registry.get(webSessionId);
  if (entry && entry.name === null) {
    const name = text.slice(0, 60).trim() || '(empty)';
    await this.registry.update(webSessionId, { name });
    this.broadcast({ type: 'session_renamed', sessionId: webSessionId, name, correlationId: '' });
  }
}

async handleResult(webSessionId: string, _payload: unknown): Promise<void> {
  const entry = this.registry.get(webSessionId);
  if (entry) await this.notifier?.noteResult(entry);
}

async renameSession(webSessionId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 200 || /[\x00-\x1F\x7F]/.test(trimmed)) {
    throw resumeError('session_name_invalid', `Invalid session name`);
  }
  await this.registry.update(webSessionId, { name: trimmed });
  this.broadcast({
    type: 'session_renamed',
    sessionId: webSessionId,
    name: trimmed,
    correlationId: '',
  });
}
```

(Adapt the broadcast call to your existing pattern — likely `this.appendAndBroadcast(s, msg)` with proper seq.)

The actual hookup of `handleInput` / `handleResult` to the existing event flow depends on how the current code routes input/result events. Read the existing flow in `session.ts` and integrate carefully.

- [ ] **Step 3: Run tests — expect PASS (existing + 7 new)**

- [ ] **Step 4: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add packages/bridge/src/session.ts packages/bridge/src/claude-process.ts packages/bridge/src/codex-process.ts packages/bridge/src/__tests__/session.test.ts
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(bridge): SessionManager multi-dir spawn + auto-name + rename + notifier wiring"
```

---

## Task 8: WS handlers — 7 new

**Files:**
- Modify: `packages/bridge/src/websocket.ts`
- Modify: `packages/bridge/src/__tests__/websocket.test.ts`

Pattern: same as P5 — `AttachWsOpts` gains new deps; `handleMessage` adds new arms using bare param names.

- [ ] **Step 1: Append failing tests for each new handler**

(See spec §15 for full test list. Mirror the existing P5 websocket test pattern: spin up a real WS server with mocked deps, send each message, assert reply shape.)

- [ ] **Step 2: Add deps to `AttachWsOpts`**

```ts
import type { ProfileStore } from './profile-store.js';
import type { SlashCommandsScanner } from './slash-commands.js';
import type { FileSearch } from './file-search.js';

export interface AttachWsOpts {
  // ... existing
  profileStore: ProfileStore;
  slashCommands: SlashCommandsScanner;
  fileSearch: FileSearch;
}
```

Update the `handleMessage` call in `attachWebSocket` to pass these through (existing pattern from P5 T6).

- [ ] **Step 3: Add 7 new arms to the message-dispatch switch in `handleMessage`**

```ts
case 'list_profiles': {
  const profiles = profileStore.list();
  send({ type: 'profile_list', profiles, correlationId: msg.correlationId });
  break;
}

case 'save_profile': {
  try {
    // Validate dirs allowlist
    for (const d of msg.profile.dirs) {
      // throw 'profile_dirs_disallowed' if not allowed
    }
    const existing = profileStore.get(msg.profile.name, msg.profile.agent);
    if (existing) {
      await profileStore.update(msg.profile.name, msg.profile.agent, msg.profile);
    } else {
      await profileStore.add(msg.profile);
    }
    send({ type: 'profile_saved', profile: msg.profile, correlationId: msg.correlationId });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'profile_invalid_name';
    send({
      type: 'error',
      code: code as never,
      message: (err as Error).message,
      correlationId: msg.correlationId,
    });
  }
  break;
}

case 'delete_profile': {
  try {
    await profileStore.remove(msg.name, msg.agent);
    send({
      type: 'profile_deleted',
      name: msg.name,
      agent: msg.agent,
      correlationId: msg.correlationId,
    });
  } catch (err) {
    send({
      type: 'error',
      code: 'profile_not_found',
      message: (err as Error).message,
      correlationId: msg.correlationId,
    });
  }
  break;
}

case 'set_default_profile': {
  try {
    await profileStore.setDefault(msg.name, msg.agent);
    send({
      type: 'profile_default_set',
      name: msg.name,
      agent: msg.agent,
      correlationId: msg.correlationId,
    });
  } catch (err) {
    send({
      type: 'error',
      code: 'profile_not_found',
      message: (err as Error).message,
      correlationId: msg.correlationId,
    });
  }
  break;
}

case 'list_slash_commands': {
  try {
    // SessionManager has no single-id getter; use the existing listSessions()
    // public method (returns SessionInfo[]) and find by id. If you'd prefer
    // a direct accessor, add `getSessionInfo(id: string): SessionInfo | undefined`
    // to SessionManager and use it here.
    const session = sessionManager.listSessions().find((s) => s.sessionId === msg.sessionId);
    if (!session) {
      send({
        type: 'error',
        code: 'history_session_not_found',
        message: `Unknown session ${msg.sessionId}`,
        correlationId: msg.correlationId,
      });
      return;
    }
    const commands = await slashCommands.listForSession({
      sessionId: msg.sessionId,
      agent: session.agent,
      primaryCwd: session.projectPath,
    });
    send({ type: 'slash_commands_list', commands, correlationId: msg.correlationId });
  } catch (err) {
    send({
      type: 'error',
      code: 'slash_commands_failed',
      message: (err as Error).message,
      correlationId: msg.correlationId,
    });
  }
  break;
}

case 'search_files': {
  try {
    const result = await fileSearch.search(msg.sessionId, msg.query);
    send({
      type: 'file_search_results',
      hits: result.hits,
      truncated: result.truncated,
      correlationId: msg.correlationId,
    });
  } catch (err) {
    send({
      type: 'error',
      code: 'file_search_failed',
      message: (err as Error).message,
      correlationId: msg.correlationId,
    });
  }
  break;
}

case 'rename_session': {
  try {
    await sessionManager.renameSession(msg.sessionId, msg.name);
    send({
      type: 'session_renamed',
      sessionId: msg.sessionId,
      name: msg.name,
      correlationId: msg.correlationId,
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'session_name_invalid';
    send({
      type: 'error',
      code: code as never,
      message: (err as Error).message,
      correlationId: msg.correlationId,
    });
  }
  break;
}
```

Also extend the existing `start` arm to accept `dirs: string[]`:

```ts
case 'start': {
  const dirs = msg.dirs ?? (msg.projectPath ? [msg.projectPath] : []);
  if (dirs.length === 0) {
    send({ type: 'error', code: 'invalid_request', message: 'Either projectPath or dirs required', correlationId: msg.correlationId });
    return;
  }
  // ... call sessionManager.spawnSession({ agent: msg.agent, dirs, account: msg.account })
}
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add packages/bridge/src/websocket.ts packages/bridge/src/__tests__/websocket.test.ts
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(bridge): WS handlers for profiles, slash, file-search, rename"
```

---

## Task 9: Bridge boot wiring

**Files:**
- Modify: `packages/bridge/src/index.ts`

- [ ] **Step 1: Add imports + instantiation**

```ts
import { ProfileStore } from './profile-store.js';
import { SlashCommandsScanner } from './slash-commands.js';
import { FileSearch } from './file-search.js';
import { Notifier } from './notifier.js';
import { homedir } from 'node:os';

// Inside main():
const profilesPath = process.env.BRIDGE_PROFILES_FILE ?? join('.bridge', 'profiles.json');
const profileStore = new ProfileStore(profilesPath);
await profileStore.load();

const slashCommands = new SlashCommandsScanner({ homeDir: homedir() });

const fileSearch = new FileSearch({
  getDirsForSession: (sessionId: string) => {
    const entry = sessionRegistry.get(sessionId);
    if (!entry) return [];
    return [entry.projectPath, ...entry.additionalDirs];
  },
  fileCap: process.env.BRIDGE_FILE_SEARCH_CAP ? Number(process.env.BRIDGE_FILE_SEARCH_CAP) : undefined,
});

const notifier = new Notifier({
  ...(process.env.BRIDGE_TELEGRAM_BOT_TOKEN ? { token: process.env.BRIDGE_TELEGRAM_BOT_TOKEN } : {}),
  ...(process.env.BRIDGE_TELEGRAM_CHAT_ID ? { chatId: process.env.BRIDGE_TELEGRAM_CHAT_ID } : {}),
  minDurationMs: process.env.BRIDGE_NOTIFY_MIN_DURATION_MS
    ? Number(process.env.BRIDGE_NOTIFY_MIN_DURATION_MS)
    : 180_000,
  ...(process.env.BRIDGE_PUBLIC_URL ? { publicUrl: process.env.BRIDGE_PUBLIC_URL } : {}),
});

const sessionManager = new SessionManager({
  // ... existing
  notifier,
});

attachWebSocket({
  // ... existing
  profileStore,
  slashCommands,
  fileSearch,
});
```

- [ ] **Step 2: Verify build + tests still pass**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run bridge:build
npm run bridge:test
```

- [ ] **Step 3: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add packages/bridge/src/index.ts
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(bridge): boot wiring for ProfileStore + SlashCommands + FileSearch + Notifier"
```

---

## Task 10: Web stores (profileStore, slashCommandStore, fileSearchStore)

**Files:**
- Create: `apps/web/src/features/profiles/profileStore.ts` + test
- Create: `apps/web/src/features/chat/slashCommandStore.ts` + test
- Create: `apps/web/src/features/chat/fileSearchStore.ts` + test
- Modify: `apps/web/src/App.tsx` (route 5 new server messages to their stores)

Each store follows P5's pattern: `getBridgeClient().send()` for actions, `applyServerMsg()` for replies, correlationId-keyed pendingMap for promise-based actions where needed.

- [ ] **Step 1: profileStore**

`apps/web/src/features/profiles/profileStore.ts`:

```ts
import { create } from 'zustand';
import type { Profile, ServerMsg } from '../../types/protocol';
import { getBridgeClient } from '../../services/bridge-client-singleton';

interface ProfileState {
  profiles: Profile[];
  loading: boolean;
  fetch: () => void;
  save: (p: Profile) => Promise<void>;
  delete: (name: string, agent: 'claude' | 'codex') => Promise<void>;
  setDefault: (name: string, agent: 'claude' | 'codex') => Promise<void>;
  applyServerMsg: (m: ServerMsg) => void;
}

const pending = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>();

export const useProfileStore = create<ProfileState>((set, get) => ({
  profiles: [],
  loading: false,

  fetch() {
    set({ loading: true });
    getBridgeClient().send({
      type: 'list_profiles',
      correlationId: `pf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    });
  },

  save(p) {
    return new Promise((resolve, reject) => {
      const correlationId = `pf-save-${Date.now()}`;
      pending.set(correlationId, { resolve, reject });
      getBridgeClient().send({ type: 'save_profile', profile: p, correlationId });
    });
  },

  delete(name, agent) {
    return new Promise((resolve, reject) => {
      const correlationId = `pf-del-${Date.now()}`;
      pending.set(correlationId, { resolve, reject });
      getBridgeClient().send({ type: 'delete_profile', name, agent, correlationId });
    });
  },

  setDefault(name, agent) {
    return new Promise((resolve, reject) => {
      const correlationId = `pf-def-${Date.now()}`;
      pending.set(correlationId, { resolve, reject });
      getBridgeClient().send({ type: 'set_default_profile', name, agent, correlationId });
    });
  },

  applyServerMsg(m: ServerMsg) {
    if (m.type === 'profile_list') {
      set({ profiles: m.profiles, loading: false });
    } else if (m.type === 'profile_saved') {
      const updated = get().profiles.filter(
        (p) => !(p.agent === m.profile.agent && p.name === m.profile.name),
      );
      updated.push(m.profile);
      set({ profiles: updated });
      pending.get(m.correlationId)?.resolve();
      pending.delete(m.correlationId);
    } else if (m.type === 'profile_deleted') {
      set({
        profiles: get().profiles.filter((p) => !(p.agent === m.agent && p.name === m.name)),
      });
      pending.get(m.correlationId)?.resolve();
      pending.delete(m.correlationId);
    } else if (m.type === 'profile_default_set') {
      set({
        profiles: get().profiles.map((p) =>
          p.agent === m.agent ? { ...p, default: p.name === m.name } : p,
        ),
      });
      pending.get(m.correlationId)?.resolve();
      pending.delete(m.correlationId);
    } else if (m.type === 'error' && m.correlationId && pending.has(m.correlationId)) {
      pending.get(m.correlationId)!.reject({ code: m.code, message: m.message });
      pending.delete(m.correlationId);
    }
  },
}));
```

- [ ] **Step 2: slashCommandStore**

`apps/web/src/features/chat/slashCommandStore.ts`:

```ts
import { create } from 'zustand';
import type { SlashCommand, ServerMsg } from '../../types/protocol';
import { getBridgeClient } from '../../services/bridge-client-singleton';

const CACHE_TTL_MS = 60_000;

interface SlashCommandState {
  bySession: Record<string, { commands: SlashCommand[]; lastFetched: number }>;
  fetch: (sessionId: string) => void;
  applyServerMsg: (m: ServerMsg) => void;
}

const pendingBySession = new Map<string, string>(); // correlationId -> sessionId

export const useSlashCommandStore = create<SlashCommandState>((set, get) => ({
  bySession: {},

  fetch(sessionId: string) {
    const existing = get().bySession[sessionId];
    if (existing && Date.now() - existing.lastFetched < CACHE_TTL_MS) return;
    const correlationId = `sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    pendingBySession.set(correlationId, sessionId);
    getBridgeClient().send({ type: 'list_slash_commands', sessionId, correlationId });
  },

  applyServerMsg(m: ServerMsg) {
    if (m.type === 'slash_commands_list') {
      const sessionId = pendingBySession.get(m.correlationId);
      pendingBySession.delete(m.correlationId);
      if (!sessionId) return;
      set({
        bySession: {
          ...get().bySession,
          [sessionId]: { commands: m.commands, lastFetched: Date.now() },
        },
      });
    }
  },
}));
```

- [ ] **Step 3: fileSearchStore**

`apps/web/src/features/chat/fileSearchStore.ts`:

```ts
import { create } from 'zustand';
import type { SearchHit, ServerMsg } from '../../types/protocol';
import { getBridgeClient } from '../../services/bridge-client-singleton';

interface FileSearchState {
  bySession: Record<string, { hits: SearchHit[]; truncated: boolean; query: string }>;
  search: (sessionId: string, query: string) => void;
  applyServerMsg: (m: ServerMsg) => void;
}

const pendingBySession = new Map<string, { sessionId: string; query: string }>();

export const useFileSearchStore = create<FileSearchState>((set, get) => ({
  bySession: {},

  search(sessionId: string, query: string) {
    const correlationId = `fs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    pendingBySession.set(correlationId, { sessionId, query });
    getBridgeClient().send({ type: 'search_files', sessionId, query, correlationId });
  },

  applyServerMsg(m: ServerMsg) {
    if (m.type === 'file_search_results') {
      const pending = pendingBySession.get(m.correlationId);
      pendingBySession.delete(m.correlationId);
      if (!pending) return;
      set({
        bySession: {
          ...get().bySession,
          [pending.sessionId]: { hits: m.hits, truncated: m.truncated, query: pending.query },
        },
      });
    }
  },
}));
```

- [ ] **Step 4: Wire stores into App.tsx WS dispatcher**

Add routes for `profile_list`, `profile_saved`, `profile_deleted`, `profile_default_set`, `slash_commands_list`, `file_search_results` (and route `session_renamed` to sessions store):

```tsx
import { useProfileStore } from './features/profiles/profileStore';
import { useSlashCommandStore } from './features/chat/slashCommandStore';
import { useFileSearchStore } from './features/chat/fileSearchStore';

// inside the message handler:
if (m.type === 'profile_list' || m.type === 'profile_saved' || m.type === 'profile_deleted' || m.type === 'profile_default_set') {
  useProfileStore.getState().applyServerMsg(m);
  return;
}
if (m.type === 'slash_commands_list') {
  useSlashCommandStore.getState().applyServerMsg(m);
  return;
}
if (m.type === 'file_search_results') {
  useFileSearchStore.getState().applyServerMsg(m);
  return;
}
// session_renamed flows through sessions store (Task 13 adds the apply branch)
```

- [ ] **Step 5: Tests**

For each store, write a small test file mocking `getBridgeClient` and asserting send + applyServerMsg behavior. Pattern from P5's historyStore.test.ts.

- [ ] **Step 6: Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add apps/web/src/features/profiles/profileStore.ts apps/web/src/features/profiles/profileStore.test.ts apps/web/src/features/chat/slashCommandStore.ts apps/web/src/features/chat/slashCommandStore.test.ts apps/web/src/features/chat/fileSearchStore.ts apps/web/src/features/chat/fileSearchStore.test.ts apps/web/src/App.tsx
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(web): profile + slash + file-search stores; App.tsx routes"
```

---

## Task 11: DirPicker + ProfilePicker + ProfileEditor (mobile-friendly)

**Files:**
- Create: `apps/web/src/features/profiles/DirPicker.tsx` + test
- Create: `apps/web/src/features/profiles/ProfilePicker.tsx` + test
- Create: `apps/web/src/features/profiles/ProfileEditor.tsx` + test
- Create: `apps/web/src/features/profiles/profiles.css`
- Modify: `apps/web/src/features/project-picker/useNewSession.tsx` (use DirPicker + ProfilePicker; multi-dir spawn payload)

This is a large UI task. Follow these mobile-friendly rules:
- Modals full-screen at viewports < 640px (`@media (max-width: 640px)`)
- All tap targets ≥ 44 × 44 px
- Drag-and-drop is desktop-only; arrow buttons are the mobile primary
- No hover-only patterns

Detail of each component:

**DirPicker.tsx** — multi-select with ★ primary marker. Each row:
```
[★ if dirs[0]]  /Volumes/WDSSD/Code/foo-web   [▲][▼][✕]
                /Volumes/WDSSD/Code/foo-shared [▲][▼][✕]
```
Plus an `[+ Add dir]` button at the bottom that opens the existing project-path autocomplete (or a tree).

State: `dirs: string[]`. Operations: add, remove, reorder (move up/down via arrows).

**ProfilePicker.tsx** — native `<select>` element on mobile (better OS picker UX); list of profiles for the chosen agent. On change → emit `onSelect(profile)` so parent loads its dirs into DirPicker.

**ProfileEditor.tsx** — modal with list of profiles, each with edit + delete + set-default actions. New "Add profile" button. Inside an edit form, embeds DirPicker. Validates name + dirs client-side before save.

**Mobile CSS** (`profiles.css`):

```css
.dir-picker { /* ... */ }
.dir-picker-row { display: flex; gap: 0.4rem; padding: 0.6rem 0.4rem; min-height: 44px; }
.dir-picker-arrow, .dir-picker-remove { min-width: 44px; min-height: 44px; }
.dir-picker-primary-star { color: gold; min-width: 1.5rem; }

.profile-picker-modal { /* desktop: max-width 600px, center */ }
@media (max-width: 640px) {
  .profile-picker-modal { position: fixed; inset: 0; max-width: none; border-radius: 0; }
}
```

Detailed code for each component is shown in the plan-level pseudocode in Spec §13. Implementer uses the spec's structural sketches + project's existing component conventions (read existing FileExplorer / project-picker for the patterns used).

- [ ] **Step 1-N: Implement each component with TDD**

For each: write failing test (render snapshot, primary marker toggle, arrow reorder, etc.) → minimal impl → passing test.

- [ ] **Step Final: Update useNewSession to use DirPicker**

Replace the existing single-cwd input with `<DirPicker dirs={dirs} onChange={setDirs} />` and add `<ProfilePicker onSelect={p => setDirs(p.dirs)} />`. Spawn payload becomes `dirs: string[]`.

- [ ] **Commit**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add apps/web/src/features/profiles/ apps/web/src/features/project-picker/useNewSession.tsx apps/web/src/main.tsx
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(web): DirPicker + ProfilePicker + ProfileEditor (mobile-friendly)"
```

---

## Task 12: SlashAutocomplete + AtTagAutocomplete (mobile-friendly)

**Files:**
- Create: `apps/web/src/features/chat/SlashAutocomplete.tsx` + test
- Create: `apps/web/src/features/chat/AtTagAutocomplete.tsx` + test
- Modify: `apps/web/src/features/chat/InputBox.tsx` (wire both overlays)

**SlashAutocomplete.tsx** — listens for `/` at line-start (text starts with `/` OR previous char is `\n`). Pop up shows top 10 matches. Each row: command name + description + source badge. Mobile: bottom-half-screen sheet.

**AtTagAutocomplete.tsx** — listens for `@` after whitespace/newline. Pop up shows top 50 matches by recency. Same mobile behavior.

Both components:
- Read from store, fire fetch on first keystroke
- Filter in-memory on subsequent keystrokes
- Up/Down keys to navigate, Enter/Tab to insert, Esc to dismiss
- Mobile: tap row to insert, tap-outside to dismiss

InputBox integration: cursor-position tracking, prefix detection, replace prefix with selected insertText + trailing space.

(Detailed implementation skeletons follow the patterns in the spec §13. Mobile bottom-sheet uses fixed positioning with `bottom: 0; left: 0; right: 0; max-height: 50vh; overflow-y: auto`.)

- [ ] **Implement with TDD; commit when green**

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal add apps/web/src/features/chat/SlashAutocomplete.tsx apps/web/src/features/chat/SlashAutocomplete.test.tsx apps/web/src/features/chat/AtTagAutocomplete.tsx apps/web/src/features/chat/AtTagAutocomplete.test.tsx apps/web/src/features/chat/InputBox.tsx
git -C /Volumes/WDSSD/Code/mac-remote-terminal commit -m "feat(web): SlashAutocomplete + AtTagAutocomplete (mobile bottom-sheet)"
```

---

## Task 13: SessionRenameInline + sessions-store rename action

**Files:**
- Create: `apps/web/src/features/session-list/SessionRenameInline.tsx` + test
- Modify: `apps/web/src/store/sessions.ts` (add renameSession action + apply session_renamed)
- Modify: `apps/web/src/features/session-list/SessionList.tsx` (display name + render pencil)

Pattern: same as P5 resume — promise-based action, correlationId-keyed pending Map, applyServerMsg branch updates store on `session_renamed`.

- [ ] Implement + test + commit

---

## Task 14: Session.tsx pencil rename + document.title

**Files:**
- Modify: `apps/web/src/pages/Session.tsx`

Add pencil-icon next to the session name in the header → opens SessionRenameInline. Update `document.title = "<sessionName> — mac-remote-terminal"` in a useEffect tied to session.name.

```tsx
useEffect(() => {
  document.title = session?.name
    ? `${session.name} — mac-remote-terminal`
    : 'mac-remote-terminal';
}, [session?.name]);
```

- [ ] Implement + commit

---

## Task 15: docs/setup/telegram-bot.md

**Files:**
- Create: `docs/setup/telegram-bot.md`

```markdown
# Telegram bot setup for mac-remote-terminal notifications

When a Claude/Codex turn runs longer than `BRIDGE_NOTIFY_MIN_DURATION_MS` (default 3 min), the bridge can send a Telegram message to your account when the turn completes. Setup takes ~5 minutes.

## 1. Create the bot

1. Open Telegram, search for `@BotFather`.
2. Send `/newbot`. Pick a name (e.g. "My Mac Bridge"). Pick a username ending in `bot` (e.g. `mymacbridge_bot`).
3. BotFather replies with a token. Copy it. Treat as a secret.

## 2. Find your chat_id

1. Send any message to your new bot in Telegram (e.g. "hello").
2. Run:

```bash
curl https://api.telegram.org/bot<TOKEN>/getUpdates
```

3. Look for `"chat":{"id":12345678,...}`. Copy the number — that's your chat_id.

## 3. Configure the bridge

Add to your shell profile or env file:

```bash
export BRIDGE_TELEGRAM_BOT_TOKEN=<token from step 1>
export BRIDGE_TELEGRAM_CHAT_ID=<chat_id from step 2>
export BRIDGE_NOTIFY_MIN_DURATION_MS=180000   # default 3 min
export BRIDGE_PUBLIC_URL=http://100.x.x.x:7777   # optional; included as link in message
```

Restart the bridge.

## 4. Verify

Run a Claude session and ask it something that takes > 3 minutes (e.g. "find every TypeScript error in this repo and explain"). When the turn completes, you should receive:

```
Session 'find every TypeScript error in this repo and explain' completed
took 5m 23s
http://100.x.x.x:7777/session/<id>
```

## Troubleshooting

- **No message arrives**: check the bridge stderr — it logs `[notifier] sendMessage failed:` if the API rejects. Verify token + chat_id.
- **5 consecutive failures**: bridge logs a warning suggesting env var check.
- **Link doesn't open**: verify `BRIDGE_PUBLIC_URL` is set + reachable from your phone (Tailscale on).
```

- [ ] Commit

---

## Task 16: Manual e2e smoke

(See spec §15 manual smoke checklist. 7 sections covering profiles, multi-dir, slash, @-tag, telegram, mobile, devtools.)

After PASS:

```bash
git -C /Volumes/WDSSD/Code/mac-remote-terminal tag phase-6-slash-multidir-attag-telegram
```

---

## Self-Review (run before declaring Phase 6 done)

1. `npm run typecheck` (both packages) — clean.
2. `npm run bridge:test && npm run web:test` — all green.
3. `npm run build` — both packages build cleanly.
4. Manual smoke (Task 16) executed end-to-end on desktop + at least one mobile viewport (Safari devtools or real phone via Tailscale).
5. Telegram message arrives with correct name + duration + link for a > 3 min turn.
6. Profile auto-load on `+ New session` works; default profile pre-fills DirPicker.
7. Slash autocomplete shows builtins + user/project commands; selection inserts correctly.
8. @-tag picker shows top-50 fuzzy matches; insert format is correct for primary + additional dirs.
9. Pencil rename works on desktop + mobile; document.title updates.
10. All 6 new error codes reachable via at least one test or smoke step.
11. Concurrent profile saves don't tear the JSON file (50-write stress in test).
12. Mobile: full-screen modals at < 640 px; tap targets ≥ 44 px; no drag-only patterns.

If any check fails, fix before tagging.
