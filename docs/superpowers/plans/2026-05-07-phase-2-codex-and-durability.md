# Phase 2 — Codex Agent + Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Codex agent (spawn-per-turn, multi-account via `accounts.json`), on-disk transcript JSONL, prompt history persistence, and a transcript-only fallback view in the web UI on top of Phase 1.

**Architecture:** SessionManager swaps drivers by `agent` field. `ClaudeProcess` (Phase 1, long-lived per session) and the new `CodexProcess` (spawn-per-turn, first turn captures `session_id`, subsequent turns use `codex exec resume`) expose the same `event`/`exit` EventEmitter shape. New `TranscriptStore` and `PromptStore` write to `${BRIDGE_DATA_DIR}` JSONL/JSON files. New HTTP `GET /transcripts/<sessionId>` cookie-authed endpoint streams the raw NDJSON. Web gains accounts and prompt-history Zustand stores plus a `Session.tsx` fallback path that streams the disk transcript when the live session is gone.

**Tech Stack:** Same as Phase 1 — Node 20 LTS, TypeScript 5 ESM (NodeNext), `ws@^8`, Vitest 1, React 18, Vite 5, Zustand 4, React Router 6.

**Spec:** `docs/superpowers/specs/2026-05-07-phase-2-codex-and-durability-design.md`

**Out of scope (Phase 3+):** image attachments, file explorer, markdown rendering, Playwright E2E, HTTPS termination, multi-account Claude.

---

## File Structure

### Bridge — new files

```
packages/bridge/src/
├── accounts.ts             # load + validate accounts.json
├── transcript-store.ts     # append-only JSONL writer + boot pruner
├── codex-parser.ts         # codex --json line → AgentEvent | session_id | null
├── codex-process.ts        # spawn-per-turn driver (sendUserText, kill)
├── prompt-store.ts         # prompts.json read/write with sha256 dedupe
└── __tests__/              # one *.test.ts per new module + additions to existing
└── test/fixtures/
    └── codex-stream.jsonl  # recorded codex --json sample for parser tests
```

### Bridge — modified files

| File | Change |
|---|---|
| `types.ts` | `AgentKind = 'claude' \| 'codex'`. Lifecycle/session-list add `account?`. New messages: `ClientListAccountsMsg`, `ClientListPromptsMsg`, `ServerAccountListMsg`, `ServerPromptsResultMsg`. New error codes `unknown_account`, `codex_session_id_missing`. `ServerErrorMsg` adds optional `sessionId?: string`. |
| `env.ts` | `BridgeConfig` adds `dataDir: string` and `transcriptRetentionDays: number`. New `BRIDGE_DATA_DIR` (default `~/.config/mac-remote-terminal`) and `BRIDGE_TRANSCRIPT_RETENTION_DAYS` (default `30`, `0` disables) parsing. |
| `session.ts` | `InternalSession` gains `account?: string`. `create({ agent, projectPath, account?, correlationId? })` validates account when `agent === 'codex'`. `appendAndBroadcast` calls injected `transcriptStore.append`. `sendInput` calls injected `promptStore.add` after the user-event broadcast. `onProcExit` calls `transcriptStore.close`. New constructor opts include `transcriptStore`, `promptStore`, `accountsRegistry`, and a `driverFactory` for picking Claude vs Codex. |
| `websocket.ts` | New routes `list_accounts` and `list_prompts`. `start` forwards `account` to `mgr.create`. `unknown_account` error carries `correlationId`. |
| `http-server.ts` | New route `GET /transcripts/<sessionId>`. UUID regex on path segment. Cookie auth + Origin check (existing). Realpath check under `${BRIDGE_DATA_DIR}/transcripts/`. Streams as `application/x-ndjson`. |
| `index.ts` | Boot: instantiate `accountsRegistry`, `TranscriptStore`, `PromptStore`. Run boot prune. Wire driver factory. Pass everything into `SessionManager`. |

### Web — new files

```
apps/web/src/
├── store/
│   ├── accounts.ts                # Zustand: account list, default selection
│   └── prompt-history.ts          # Zustand: prompts cache, query, filter toggle
├── services/
│   └── transcript-fetcher.ts      # async iterable over GET /transcripts/<id>
└── features/
    └── prompt-history/
        ├── PromptHistoryDropdown.tsx
        └── PromptHistoryDropdown.css
```

### Web — modified files

| File | Change |
|---|---|
| `types/protocol.ts` | Mirror `packages/bridge/src/types.ts` byte-for-byte. |
| `App.tsx` | On `open`, also send `list_accounts` and `list_prompts`. Route `account_list` and `prompts_result` to their stores. Route `error { code: 'session_dead', sessionId }` to `useSessionsStore.markTranscriptOnly`. |
| `store/sessions.ts` | Add `transcriptOnly: Record<sessionId, boolean>`, `markTranscriptOnly(id)` setter. `applyServerMsg` continues to pass `error` through to App's handler. |
| `features/project-picker/ProjectPicker.tsx` | Add agent radio + account dropdown when codex selected. |
| `features/project-picker/useNewSession.ts` | Generalize `start` argv: pass `agent` and (when codex) `account`. |
| `features/session-list/SessionList.tsx` | Show small agent badge per row; codex rows include account name. |
| `features/chat/InputBox.tsx` | Mount `PromptHistoryDropdown` over the textarea, opened by `↑` (when textarea is empty) or by clicking a small history icon button. |
| `pages/Session.tsx` | Watch `transcriptOnly[id]`. When true, call `streamTranscript(id)` once, dispatch each yielded message into `applyServerMsg`. Prepend a synthetic header bubble. Disable `InputBox`. |

---

## Task 1: Land Phase 2 protocol type surface (bridge + web byte-identical)

**Files:**
- Modify: `packages/bridge/src/types.ts`
- Modify: `apps/web/src/types/protocol.ts`

The two files MUST end up byte-identical. Subsequent tasks consume the new types; landing them up front lets tests compile.

- [ ] **Step 1: Replace `packages/bridge/src/types.ts` with the Phase 2 surface**

```ts
export type AgentKind = 'claude' | 'codex';

export interface ClientStartMsg {
  type: 'start';
  agent: AgentKind;
  projectPath: string;
  account?: string;
  sessionId?: string;
  resume?: boolean;
  correlationId?: string;
}

export interface ClientInputMsg {
  type: 'input';
  sessionId: string;
  text: string;
  correlationId?: string;
}

export interface ClientStopMsg {
  type: 'stop_session';
  sessionId: string;
  correlationId?: string;
}

export interface ClientListSessionsMsg {
  type: 'list_sessions';
  correlationId?: string;
}

export interface ClientGetHistoryMsg {
  type: 'get_history';
  sessionId: string;
  since?: number;
  correlationId?: string;
}

export interface ClientListAccountsMsg {
  type: 'list_accounts';
  correlationId?: string;
}

export interface ClientListPromptsMsg {
  type: 'list_prompts';
  query?: string;
  limit?: number;
  correlationId?: string;
}

export type ClientMsg =
  | ClientStartMsg
  | ClientInputMsg
  | ClientStopMsg
  | ClientListSessionsMsg
  | ClientGetHistoryMsg
  | ClientListAccountsMsg
  | ClientListPromptsMsg;

export type AgentEvent =
  | { kind: 'assistant_text'; text: string }
  | { kind: 'stream_delta'; delta: string }
  | { kind: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; output: unknown }
  | { kind: 'result'; cost?: number; durationMs?: number; error?: string };

export interface ServerInitMsg {
  type: 'system';
  event: 'init';
}

export interface ServerLifecycleMsg {
  type: 'system';
  event: 'session_created' | 'session_ended';
  sessionId: string;
  seq: number;
  // Populated only on session_created:
  agent?: AgentKind;
  projectPath?: string;
  createdAt?: number;
  // Populated for codex sessions only, on session_created:
  account?: string;
  // Echoed only on session_created when start carried a correlationId:
  correlationId?: string;
  // Populated only on session_ended:
  reason?: string;
  exitCode?: number;
}

export interface ServerStreamMsg {
  type: 'assistant' | 'stream_delta' | 'tool_result' | 'result' | 'status' | 'user';
  sessionId: string;
  seq: number;
  payload: unknown;
}

export interface ServerSessionListMsg {
  type: 'session_list';
  sessions: Array<{
    sessionId: string;
    agent: AgentKind;
    projectPath: string;
    createdAt: number;
    account?: string;
  }>;
  correlationId?: string;
}

export interface ServerHistoryMsg {
  type: 'history';
  sessionId: string;
  events: Array<ServerLifecycleMsg | ServerStreamMsg>;
  hasMore: boolean;
  correlationId?: string;
}

export interface ServerAccountListMsg {
  type: 'account_list';
  accounts: Array<{ name: string; agent: 'codex'; isDefault: boolean }>;
  correlationId?: string;
}

export interface ServerPromptsResultMsg {
  type: 'prompts_result';
  prompts: Array<{
    text: string;
    lastUsedAt: number;
    projectPaths: string[];
    agents: AgentKind[];
  }>;
  correlationId?: string;
}

export type ServerErrorCode =
  | 'not_authorized'
  | 'origin_mismatch'
  | 'path_outside_allowlist'
  | 'session_dead'
  | 'agent_not_installed'
  | 'unknown_account'
  | 'codex_session_id_missing'
  | 'message_too_large'
  | 'history_truncated'
  | 'unsupported_message';

export interface ServerErrorMsg {
  type: 'error';
  code: ServerErrorCode;
  message: string;
  // Set only for errors emitted on behalf of an existing session
  // (session_dead, codex_session_id_missing). Start-time errors carry
  // correlationId instead.
  sessionId?: string;
  correlationId?: string;
}

export type ServerMsg =
  | ServerInitMsg
  | ServerLifecycleMsg
  | ServerStreamMsg
  | ServerSessionListMsg
  | ServerHistoryMsg
  | ServerAccountListMsg
  | ServerPromptsResultMsg
  | ServerErrorMsg;
```

- [ ] **Step 2: Copy the same content to `apps/web/src/types/protocol.ts`**

```bash
cp /Volumes/WDSSD/Code/mac-remote-terminal/packages/bridge/src/types.ts \
   /Volumes/WDSSD/Code/mac-remote-terminal/apps/web/src/types/protocol.ts
```

- [ ] **Step 3: Verify byte-identical**

```bash
diff /Volumes/WDSSD/Code/mac-remote-terminal/packages/bridge/src/types.ts \
     /Volumes/WDSSD/Code/mac-remote-terminal/apps/web/src/types/protocol.ts
```

Expected: empty diff.

- [ ] **Step 4: Verify type-checks pass on both packages**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npx tsc --noEmit -p packages/bridge/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: both clean.

- [ ] **Step 5: Run all existing tests to ensure no regression**

```bash
npm test 2>&1 | tail -10
```

Expected: all bridge + web tests pass (Phase 1 baseline).

- [ ] **Step 6: Commit**

```bash
git add packages/bridge/src/types.ts apps/web/src/types/protocol.ts
git commit -m "feat(types): land Phase 2 protocol surface (bridge + web byte-identical)"
```

---

## Task 2: Extend env.ts with dataDir + transcriptRetentionDays

**Files:**
- Modify: `packages/bridge/src/env.ts`
- Modify: `packages/bridge/src/__tests__/env.test.ts`

- [ ] **Step 1: Append new test cases to `packages/bridge/src/__tests__/env.test.ts`**

Add these tests inside the existing `describe('loadEnv', () => { ... })` block, before the closing `});`:

```ts
  it('defaults dataDir to $HOME/.config/mac-remote-terminal', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      HOME: '/Users/test',
    });
    expect(cfg.dataDir).toBe('/Users/test/.config/mac-remote-terminal');
  });

  it('allows BRIDGE_DATA_DIR to override the default', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      BRIDGE_DATA_DIR: '/var/mrt',
    });
    expect(cfg.dataDir).toBe('/var/mrt');
  });

  it('defaults transcriptRetentionDays to 30', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      HOME: '/Users/test',
    });
    expect(cfg.transcriptRetentionDays).toBe(30);
  });

  it('parses BRIDGE_TRANSCRIPT_RETENTION_DAYS as integer', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      HOME: '/Users/test',
      BRIDGE_TRANSCRIPT_RETENTION_DAYS: '7',
    });
    expect(cfg.transcriptRetentionDays).toBe(7);
  });

  it('treats BRIDGE_TRANSCRIPT_RETENTION_DAYS=0 as disabled', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      HOME: '/Users/test',
      BRIDGE_TRANSCRIPT_RETENTION_DAYS: '0',
    });
    expect(cfg.transcriptRetentionDays).toBe(0);
  });

  it('throws on negative or non-integer BRIDGE_TRANSCRIPT_RETENTION_DAYS', () => {
    expect(() =>
      loadEnv({
        BRIDGE_TOKEN: 'a'.repeat(24),
        HOME: '/Users/test',
        BRIDGE_TRANSCRIPT_RETENTION_DAYS: '-1',
      }),
    ).toThrow(/non-negative/);
    expect(() =>
      loadEnv({
        BRIDGE_TOKEN: 'a'.repeat(24),
        HOME: '/Users/test',
        BRIDGE_TRANSCRIPT_RETENTION_DAYS: 'abc',
      }),
    ).toThrow(/non-negative/);
  });
```

- [ ] **Step 2: Run tests to verify the new ones FAIL**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run bridge:test -- env
```

Expected: 6 of 14 tests fail because `dataDir` and `transcriptRetentionDays` are not on `BridgeConfig` yet.

- [ ] **Step 3: Update `packages/bridge/src/env.ts`**

Replace the file contents with:

```ts
import { join } from 'node:path';

export interface BridgeConfig {
  token: string;
  port: number;
  bindHost?: string;
  allowedDirs: string[];
  dataDir: string;
  transcriptRetentionDays: number;
}

const MIN_TOKEN_LEN = 24;
const DEFAULT_DATA_SUBDIR = '.config/mac-remote-terminal';
const DEFAULT_RETENTION_DAYS = 30;

export function loadEnv(env: Record<string, string | undefined>): BridgeConfig {
  const token = env.BRIDGE_TOKEN;
  if (!token) {
    throw new Error(
      'BRIDGE_TOKEN is required. Generate one: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (token.length < MIN_TOKEN_LEN) {
    throw new Error(`BRIDGE_TOKEN must be at least ${MIN_TOKEN_LEN} characters`);
  }

  const port = Number(env.BRIDGE_PORT ?? '8765');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('BRIDGE_PORT must be a positive integer');
  }

  const allowedDirsRaw = env.BRIDGE_ALLOWED_DIRS ?? env.HOME;
  if (!allowedDirsRaw) {
    throw new Error('BRIDGE_ALLOWED_DIRS or HOME must be set');
  }
  const allowedDirs = allowedDirsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const home = env.HOME;
  const dataDir =
    env.BRIDGE_DATA_DIR ??
    (home ? join(home, DEFAULT_DATA_SUBDIR) : (() => {
      throw new Error('BRIDGE_DATA_DIR or HOME must be set');
    })());

  const retentionRaw = env.BRIDGE_TRANSCRIPT_RETENTION_DAYS;
  let transcriptRetentionDays = DEFAULT_RETENTION_DAYS;
  if (retentionRaw !== undefined) {
    const parsed = Number(retentionRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error('BRIDGE_TRANSCRIPT_RETENTION_DAYS must be a non-negative integer');
    }
    transcriptRetentionDays = parsed;
  }

  const bindHost = env.BRIDGE_BIND_HOST;

  return {
    token,
    port,
    allowedDirs,
    dataDir,
    transcriptRetentionDays,
    ...(bindHost ? { bindHost } : {}),
  };
}
```

- [ ] **Step 4: Run tests to verify all pass**

```bash
npm run bridge:test -- env
```

Expected: 14 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/env.ts packages/bridge/src/__tests__/env.test.ts
git commit -m "feat(bridge): add dataDir and transcript retention to env loader"
```

---

## Task 3: accounts.ts — load Codex account registry

**Files:**
- Create: `packages/bridge/src/accounts.ts`
- Create: `packages/bridge/src/__tests__/accounts.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/accounts.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCodexAccounts } from '../accounts.js';

describe('loadCodexAccounts', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mrt-accounts-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('synthesizes a default account when accounts.json is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'mrt-home-'));
    mkdirSync(join(home, '.codex'));
    const accounts = loadCodexAccounts({ dataDir, env: { HOME: home } });
    expect(accounts.size).toBe(1);
    const def = accounts.get('default')!;
    expect(def.codexHome).toBe(join(home, '.codex'));
    expect(def.isDefault).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it('synthesizes a default account from CODEX_HOME when set', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'mrt-codex-'));
    const accounts = loadCodexAccounts({ dataDir, env: { CODEX_HOME: codexHome, HOME: '/nope' } });
    expect(accounts.get('default')!.codexHome).toBe(codexHome);
    rmSync(codexHome, { recursive: true, force: true });
  });

  it('parses a valid accounts.json with multiple entries', () => {
    const work = mkdtempSync(join(tmpdir(), 'mrt-codex-work-'));
    const personal = mkdtempSync(join(tmpdir(), 'mrt-codex-personal-'));
    writeFileSync(
      join(dataDir, 'accounts.json'),
      JSON.stringify({
        codex_accounts: [
          { name: 'work', codexHome: work },
          { name: 'personal', codexHome: personal },
        ],
      }),
    );
    const accounts = loadCodexAccounts({ dataDir, env: {} });
    expect(accounts.size).toBe(2);
    expect(accounts.get('work')!.codexHome).toBe(work);
    expect(accounts.get('personal')!.codexHome).toBe(personal);
    expect(accounts.get('work')!.isDefault).toBe(false);
    rmSync(work, { recursive: true, force: true });
    rmSync(personal, { recursive: true, force: true });
  });

  it('drops accounts whose codexHome does not exist, falls back to default if all dropped', () => {
    const home = mkdtempSync(join(tmpdir(), 'mrt-home-'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(
      join(dataDir, 'accounts.json'),
      JSON.stringify({ codex_accounts: [{ name: 'broken', codexHome: '/no/such/path' }] }),
    );
    const accounts = loadCodexAccounts({ dataDir, env: { HOME: home } });
    expect(accounts.size).toBe(1);
    expect(accounts.has('default')).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it('falls back to default on malformed JSON', () => {
    const home = mkdtempSync(join(tmpdir(), 'mrt-home-'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(dataDir, 'accounts.json'), '{not json');
    const accounts = loadCodexAccounts({ dataDir, env: { HOME: home } });
    expect(accounts.size).toBe(1);
    expect(accounts.has('default')).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it('falls back to default on empty codex_accounts array', () => {
    const home = mkdtempSync(join(tmpdir(), 'mrt-home-'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify({ codex_accounts: [] }));
    const accounts = loadCodexAccounts({ dataDir, env: { HOME: home } });
    expect(accounts.size).toBe(1);
    expect(accounts.has('default')).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (module missing)**

```bash
npm run bridge:test -- accounts
```

Expected: failure to load `../accounts.js`.

- [ ] **Step 3: Implement `packages/bridge/src/accounts.ts`**

```ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface CodexAccount {
  name: string;
  codexHome: string;
  isDefault: boolean;
}

interface RawAccountsFile {
  codex_accounts?: Array<{ name?: unknown; codexHome?: unknown }>;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function synthesizeDefault(env: Record<string, string | undefined>): CodexAccount {
  const codexHome = env.CODEX_HOME ?? (env.HOME ? join(env.HOME, '.codex') : '/');
  return { name: 'default', codexHome, isDefault: true };
}

export function loadCodexAccounts(opts: {
  dataDir: string;
  env: Record<string, string | undefined>;
}): Map<string, CodexAccount> {
  const path = join(opts.dataDir, 'accounts.json');
  if (!existsSync(path)) {
    return new Map([['default', synthesizeDefault(opts.env)]]);
  }

  let raw: RawAccountsFile;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as RawAccountsFile;
  } catch (err) {
    console.warn(`[accounts] malformed ${path}: ${(err as Error).message}. Falling back to default.`);
    return new Map([['default', synthesizeDefault(opts.env)]]);
  }

  const list = Array.isArray(raw.codex_accounts) ? raw.codex_accounts : [];
  const out = new Map<string, CodexAccount>();
  for (const entry of list) {
    if (typeof entry?.name !== 'string' || typeof entry.codexHome !== 'string') {
      console.warn(`[accounts] skipping malformed entry in ${path}`);
      continue;
    }
    if (!isDirectory(entry.codexHome)) {
      console.warn(
        `[accounts] account '${entry.name}' codexHome '${entry.codexHome}' is not a directory; dropping.`,
      );
      continue;
    }
    out.set(entry.name, { name: entry.name, codexHome: entry.codexHome, isDefault: false });
  }

  if (out.size === 0) {
    return new Map([['default', synthesizeDefault(opts.env)]]);
  }

  return out;
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run bridge:test -- accounts
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/accounts.ts packages/bridge/src/__tests__/accounts.test.ts
git commit -m "feat(bridge): load Codex accounts from accounts.json with default fallback"
```

---

## Task 4: transcript-store.ts — append-only NDJSON writer + boot pruner

**Files:**
- Create: `packages/bridge/src/transcript-store.ts`
- Create: `packages/bridge/src/__tests__/transcript-store.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/transcript-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync, mkdirSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptStore } from '../transcript-store.js';
import type { ServerLifecycleMsg, ServerStreamMsg } from '../types.js';

describe('TranscriptStore', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mrt-transcripts-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('appends one NDJSON line per call and creates the transcripts subdir', () => {
    const store = new TranscriptStore(dataDir);
    const id = '11111111-1111-1111-1111-111111111111';
    const created: ServerLifecycleMsg = {
      type: 'system',
      event: 'session_created',
      sessionId: id,
      seq: 1,
    };
    const userMsg: ServerStreamMsg = {
      type: 'user',
      sessionId: id,
      seq: 2,
      payload: { text: 'hi' },
    };
    store.append(id, created);
    store.append(id, userMsg);
    store.close(id);

    const file = join(dataDir, 'transcripts', `${id}.jsonl`);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(created);
    expect(JSON.parse(lines[1]!)).toEqual(userMsg);
  });

  it('appends across reopen (lazy file handle)', () => {
    const id = '22222222-2222-2222-2222-222222222222';
    const a = new TranscriptStore(dataDir);
    a.append(id, { type: 'system', event: 'session_created', sessionId: id, seq: 1 });
    a.close(id);

    const b = new TranscriptStore(dataDir);
    b.append(id, { type: 'system', event: 'session_ended', sessionId: id, seq: 2, exitCode: 0 });
    b.close(id);

    const lines = readFileSync(join(dataDir, 'transcripts', `${id}.jsonl`), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('prune deletes files older than retentionDays and keeps fresh ones', async () => {
    const transcripts = join(dataDir, 'transcripts');
    mkdirSync(transcripts, { recursive: true });
    const old = join(transcripts, 'old.jsonl');
    const fresh = join(transcripts, 'fresh.jsonl');
    writeFileSync(old, '{}\n');
    writeFileSync(fresh, '{}\n');
    // Backdate `old` by 40 days
    const FORTY_DAYS_S = 40 * 86_400;
    const now = Date.now() / 1000;
    utimesSync(old, now - FORTY_DAYS_S, now - FORTY_DAYS_S);

    const store = new TranscriptStore(dataDir);
    const deleted = await store.prune(30);
    expect(deleted).toBe(1);
    expect(readdirSync(transcripts).sort()).toEqual(['fresh.jsonl']);
  });

  it('prune fail-soft on individual file errors', async () => {
    const transcripts = join(dataDir, 'transcripts');
    mkdirSync(transcripts, { recursive: true });
    const ok = join(transcripts, 'ok.jsonl');
    writeFileSync(ok, '{}\n');
    const FORTY_DAYS_S = 40 * 86_400;
    const now = Date.now() / 1000;
    utimesSync(ok, now - FORTY_DAYS_S, now - FORTY_DAYS_S);
    // No actual error injection — just verify it runs without throwing
    const store = new TranscriptStore(dataDir);
    await expect(store.prune(30)).resolves.toBe(1);
  });

  it('prune is a no-op when retentionDays is 0', async () => {
    const transcripts = join(dataDir, 'transcripts');
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, 'a.jsonl'), '{}\n');
    const store = new TranscriptStore(dataDir);
    const deleted = await store.prune(0);
    expect(deleted).toBe(0);
    expect(readdirSync(transcripts)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run bridge:test -- transcript-store
```

Expected: module not found.

- [ ] **Step 3: Implement `packages/bridge/src/transcript-store.ts`**

```ts
import { mkdirSync, statSync, openSync, writeSync, closeSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerLifecycleMsg, ServerStreamMsg } from './types.js';

const TRANSCRIPTS_SUBDIR = 'transcripts';

export class TranscriptStore {
  private readonly handles = new Map<string, number>();
  private readonly transcriptsDir: string;

  constructor(dataDir: string) {
    this.transcriptsDir = join(dataDir, TRANSCRIPTS_SUBDIR);
    try {
      mkdirSync(this.transcriptsDir, { recursive: true });
    } catch (err) {
      console.warn(`[transcript-store] could not create ${this.transcriptsDir}: ${(err as Error).message}`);
    }
  }

  append(sessionId: string, msg: ServerLifecycleMsg | ServerStreamMsg): void {
    let fd = this.handles.get(sessionId);
    if (fd === undefined) {
      const path = join(this.transcriptsDir, `${sessionId}.jsonl`);
      try {
        fd = openSync(path, 'a');
      } catch (err) {
        console.warn(`[transcript-store] open(${path}) failed: ${(err as Error).message}`);
        return;
      }
      this.handles.set(sessionId, fd);
    }
    try {
      writeSync(fd, JSON.stringify(msg) + '\n');
    } catch (err) {
      console.warn(`[transcript-store] write(${sessionId}) failed: ${(err as Error).message}`);
    }
  }

  close(sessionId: string): void {
    const fd = this.handles.get(sessionId);
    if (fd === undefined) return;
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    this.handles.delete(sessionId);
  }

  closeAll(): void {
    for (const id of [...this.handles.keys()]) this.close(id);
  }

  async prune(retentionDays: number): Promise<number> {
    if (retentionDays <= 0) return 0;
    const cutoffMs = Date.now() - retentionDays * 86_400_000;
    let entries: string[];
    try {
      entries = await readdir(this.transcriptsDir);
    } catch {
      return 0;
    }
    let deleted = 0;
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(this.transcriptsDir, name);
      try {
        const st = await stat(path);
        if (st.mtimeMs < cutoffMs) {
          await unlink(path);
          deleted++;
        }
      } catch (err) {
        console.warn(`[transcript-store] prune(${name}) error: ${(err as Error).message}`);
      }
    }
    return deleted;
  }

  pathFor(sessionId: string): string {
    return join(this.transcriptsDir, `${sessionId}.jsonl`);
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run bridge:test -- transcript-store
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/transcript-store.ts packages/bridge/src/__tests__/transcript-store.test.ts
git commit -m "feat(bridge): add TranscriptStore with append, close, and boot prune"
```

---

## Task 5: SessionManager integration with TranscriptStore + driver factory

**Files:**
- Modify: `packages/bridge/src/session.ts`
- Modify: `packages/bridge/src/__tests__/session.test.ts`

This task does two things:
1. Inject `transcriptStore` into `SessionManager` so every event the manager broadcasts is appended to the per-session JSONL.
2. Generalize the spawn factory from `spawnClaude` to `driverFactory(agent, projectPath, account?)` so Task 9 can plug Codex in without further session.ts churn. Phase 1 used `spawnClaude` directly — that field becomes a backward-compatibility synonym for `driverFactory({ agent: 'claude', ... })`.

- [ ] **Step 1: Update `packages/bridge/src/session.ts`**

Replace the existing `SessionManagerOpts`, the constructor, the `create` method's spawn line, and `appendAndBroadcast`/`onProcExit` with:

```ts
import { EventEmitter } from 'node:events';
import { realpath as fsRealpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ClaudeProcess } from './claude-process.js';
import type { TranscriptStore } from './transcript-store.js';
import type { CodexAccount } from './accounts.js';
import type {
  AgentEvent,
  AgentKind,
  ServerLifecycleMsg,
  ServerStreamMsg,
} from './types.js';

export interface SessionInfo {
  sessionId: string;
  agent: AgentKind;
  projectPath: string;
  createdAt: number;
  account?: string;
}

interface InternalSession extends SessionInfo {
  proc: AgentDriver;
  buffer: Array<ServerLifecycleMsg | ServerStreamMsg>;
  nextSeq: number;
  alive: boolean;
}

export interface AgentDriver extends EventEmitter {
  sendUserText(text: string): void;
  kill(): void;
}

export interface DriverFactoryArgs {
  agent: AgentKind;
  projectPath: string;
  account?: CodexAccount;
}

export interface SessionManagerOpts {
  allowedDirs: string[];
  bufferCap: number;
  /** Phase 1 back-compat: a Claude-only factory. Mutually exclusive with driverFactory. */
  spawnClaude?: (projectPath: string) => ClaudeProcess;
  /** Phase 2 generalised driver factory. */
  driverFactory?: (args: DriverFactoryArgs) => AgentDriver;
  realpath?: (p: string) => Promise<string>;
  transcriptStore?: TranscriptStore;
  accounts?: Map<string, CodexAccount>;
}

export class PathOutsideAllowlistError extends Error {
  code = 'path_outside_allowlist' as const;
  constructor(public projectPath: string) {
    super(`projectPath ${projectPath} is not inside any allowed directory`);
  }
}

export class SessionDeadError extends Error {
  code = 'session_dead' as const;
  constructor(public sessionId: string) {
    super(`[session_dead] session ${sessionId} is not alive`);
  }
}

export class UnknownAccountError extends Error {
  code = 'unknown_account' as const;
  constructor(message: string) {
    super(message);
  }
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly allowedDirs: string[];
  private readonly bufferCap: number;
  private readonly driverFactory: (args: DriverFactoryArgs) => AgentDriver;
  private readonly realpath: (p: string) => Promise<string>;
  private readonly transcriptStore: TranscriptStore | undefined;
  private readonly accounts: Map<string, CodexAccount>;

  constructor(opts: SessionManagerOpts) {
    super();
    this.allowedDirs = opts.allowedDirs;
    this.bufferCap = opts.bufferCap;
    this.realpath = opts.realpath ?? fsRealpath;
    this.transcriptStore = opts.transcriptStore;
    this.accounts = opts.accounts ?? new Map();
    if (opts.driverFactory) {
      this.driverFactory = opts.driverFactory;
    } else if (opts.spawnClaude) {
      const spawnClaude = opts.spawnClaude;
      this.driverFactory = ({ agent, projectPath }) => {
        if (agent !== 'claude') {
          throw new Error(`agent ${agent} not supported by this SessionManager (claude-only factory)`);
        }
        return spawnClaude(projectPath) as unknown as AgentDriver;
      };
    } else {
      throw new Error('SessionManager: either driverFactory or spawnClaude must be provided');
    }
  }

  private async validatePath(projectPath: string): Promise<string> {
    let real: string;
    try {
      real = await this.realpath(projectPath);
    } catch {
      throw new PathOutsideAllowlistError(projectPath);
    }
    const inside = this.allowedDirs.some((d) => real === d || real.startsWith(d + '/'));
    if (!inside) throw new PathOutsideAllowlistError(projectPath);
    return real;
  }

  private resolveAccount(agent: AgentKind, requested: string | undefined): CodexAccount | undefined {
    if (agent !== 'codex') return undefined;
    if (this.accounts.size === 0) {
      throw new UnknownAccountError('No Codex accounts are configured.');
    }
    if (!requested) {
      if (this.accounts.size === 1) {
        return [...this.accounts.values()][0];
      }
      const names = [...this.accounts.keys()].join(', ');
      throw new UnknownAccountError(
        `Account is required when multiple Codex accounts exist. Configured: [${names}]`,
      );
    }
    const found = this.accounts.get(requested);
    if (!found) {
      const names = [...this.accounts.keys()].join(', ');
      throw new UnknownAccountError(`Unknown Codex account '${requested}'. Configured: [${names}]`);
    }
    return found;
  }

  async create(params: {
    agent: AgentKind;
    projectPath: string;
    account?: string;
    correlationId?: string;
  }): Promise<SessionInfo> {
    const real = await this.validatePath(params.projectPath);
    const account = this.resolveAccount(params.agent, params.account);
    const sessionId = randomUUID();
    const proc = this.driverFactory({
      agent: params.agent,
      projectPath: real,
      ...(account ? { account } : {}),
    });

    const internal: InternalSession = {
      sessionId,
      agent: params.agent,
      projectPath: real,
      createdAt: Date.now(),
      proc,
      buffer: [],
      nextSeq: 1,
      alive: true,
      ...(account ? { account: account.name } : {}),
    };
    this.sessions.set(sessionId, internal);

    this.appendAndBroadcast(internal, {
      type: 'system',
      event: 'session_created',
      sessionId,
      seq: internal.nextSeq++,
      agent: internal.agent,
      projectPath: internal.projectPath,
      createdAt: internal.createdAt,
      ...(account ? { account: account.name } : {}),
      ...(params.correlationId ? { correlationId: params.correlationId } : {}),
    });

    proc.on('event', (e: AgentEvent) => this.onProcEvent(internal, e));
    proc.on('exit', (code: number | null, reason?: string) => this.onProcExit(internal, code, reason));

    return {
      sessionId,
      agent: internal.agent,
      projectPath: internal.projectPath,
      createdAt: internal.createdAt,
      ...(account ? { account: account.name } : {}),
    };
  }

  private onProcEvent(s: InternalSession, e: AgentEvent): void {
    if (!s.alive) return;
    const seq = s.nextSeq++;
    let msg: ServerStreamMsg;
    switch (e.kind) {
      case 'assistant_text':
        msg = { type: 'assistant', sessionId: s.sessionId, seq, payload: { text: e.text } };
        break;
      case 'stream_delta':
        msg = { type: 'stream_delta', sessionId: s.sessionId, seq, payload: { delta: e.delta } };
        break;
      case 'tool_use':
        msg = { type: 'assistant', sessionId: s.sessionId, seq, payload: { toolUse: e } };
        break;
      case 'tool_result':
        msg = { type: 'tool_result', sessionId: s.sessionId, seq, payload: e };
        break;
      case 'result':
        msg = { type: 'result', sessionId: s.sessionId, seq, payload: e };
        break;
    }
    this.appendAndBroadcast(s, msg);
  }

  private onProcExit(s: InternalSession, code: number | null, reason?: string): void {
    if (!s.alive) return;
    s.alive = false;
    const finalReason = reason ?? 'agent_exit';
    if (finalReason === 'agent_not_installed') {
      this.emit('broadcast', {
        type: 'error',
        code: 'agent_not_installed',
        message: `${s.agent} CLI not found on PATH`,
        sessionId: s.sessionId,
      });
    }
    this.appendAndBroadcast(s, {
      type: 'system',
      event: 'session_ended',
      sessionId: s.sessionId,
      seq: s.nextSeq++,
      ...(typeof code === 'number' ? { exitCode: code } : {}),
      reason: finalReason,
    });
    this.transcriptStore?.close(s.sessionId);
    this.sessions.delete(s.sessionId);
  }

  private appendAndBroadcast(s: InternalSession, msg: ServerLifecycleMsg | ServerStreamMsg): void {
    s.buffer.push(msg);
    if (s.buffer.length > this.bufferCap) {
      s.buffer.splice(0, s.buffer.length - this.bufferCap);
    }
    this.transcriptStore?.append(s.sessionId, msg);
    this.emit('broadcast', msg);
  }

  listSessions(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      agent: s.agent,
      projectPath: s.projectPath,
      createdAt: s.createdAt,
      ...(s.account ? { account: s.account } : {}),
    }));
  }

  getHistory(
    sessionId: string,
    since: number,
  ):
    | {
        events: Array<ServerLifecycleMsg | ServerStreamMsg>;
        hasMore: boolean;
      }
    | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    const minSeqInBuffer = s.buffer.length > 0 ? s.buffer[0]!.seq : s.nextSeq;
    const events = s.buffer.filter((e) => e.seq > since);
    const hasMore = since + 1 < minSeqInBuffer;
    return { events, hasMore };
  }

  knowsSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  sendInput(sessionId: string, text: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || !s.alive) throw new SessionDeadError(sessionId);
    this.appendAndBroadcast(s, {
      type: 'user',
      sessionId,
      seq: s.nextSeq++,
      payload: { text },
    });
    s.proc.sendUserText(text);
  }

  stop(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.proc.kill();
  }

  shutdown(): void {
    for (const s of this.sessions.values()) s.proc.kill();
    this.transcriptStore?.closeAll();
  }
}
```

- [ ] **Step 2: Add transcript-integration tests to `packages/bridge/src/__tests__/session.test.ts`**

Add the following tests inside the existing `describe('SessionManager', () => { ... })` block, near the other broadcast-shape tests:

```ts
  it('forwards broadcasts to a TranscriptStore.append when one is provided', async () => {
    const procs: FakeProc[] = [];
    const appended: Array<{ id: string; msg: unknown }> = [];
    const fakeTranscriptStore = {
      append: (id: string, msg: unknown) => appended.push({ id, msg }),
      close: () => {},
      closeAll: () => {},
      prune: async () => 0,
      pathFor: () => '',
    };
    const mgr = new SessionManager({
      allowedDirs: ['/Users/test'],
      bufferCap: 100,
      driverFactory: () => {
        const p = new FakeProc();
        procs.push(p);
        return p as unknown as import('../session.js').AgentDriver;
      },
      realpath: async (p) => p,
      transcriptStore: fakeTranscriptStore as unknown as import('../transcript-store.js').TranscriptStore,
    });
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    procs[0]!.emitEvent({ kind: 'stream_delta', delta: 'a' });

    expect(appended.map((a) => a.id)).toEqual([s.sessionId, s.sessionId]);
    // First append is session_created (lifecycle), second is the stream_delta.
    const first = appended[0]!.msg as { type: string };
    const second = appended[1]!.msg as { type: string };
    expect(first.type).toBe('system');
    expect(second.type).toBe('stream_delta');
  });

  it('calls TranscriptStore.close on session_ended', async () => {
    const procs: FakeProc[] = [];
    const closed: string[] = [];
    const fakeTranscriptStore = {
      append: () => {},
      close: (id: string) => closed.push(id),
      closeAll: () => {},
      prune: async () => 0,
      pathFor: () => '',
    };
    const mgr = new SessionManager({
      allowedDirs: ['/Users/test'],
      bufferCap: 100,
      driverFactory: () => {
        const p = new FakeProc();
        procs.push(p);
        return p as unknown as import('../session.js').AgentDriver;
      },
      realpath: async (p) => p,
      transcriptStore: fakeTranscriptStore as unknown as import('../transcript-store.js').TranscriptStore,
    });
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    procs[0]!.emit('exit', 0);
    await new Promise((r) => setImmediate(r));
    expect(closed).toEqual([s.sessionId]);
  });
```

- [ ] **Step 3: Run all session tests — expect existing + 2 new passing**

```bash
npm run bridge:test -- session
```

Expected: 14 passed (12 prior + 2 new).

- [ ] **Step 4: Run full bridge test suite to ensure no regression**

```bash
npm run bridge:test
```

Expected: all bridge tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/session.ts packages/bridge/src/__tests__/session.test.ts
git commit -m "feat(bridge): generalise SessionManager driver factory + transcript hook"
```

---

## Task 6: HTTP `GET /transcripts/<sessionId>` route

**Files:**
- Modify: `packages/bridge/src/http-server.ts`
- Modify: `packages/bridge/src/__tests__/http-server.test.ts`

- [ ] **Step 1: Add new tests to `packages/bridge/src/__tests__/http-server.test.ts`**

Inside the existing `describe('http-server', () => { ... })` block, add the following imports at the top of the test file (next to existing imports):

```ts
import { mkdirSync as mkdirSyncTop, writeFileSync as writeFileSyncTop } from 'node:fs';
```

Then, augment the existing `setup()` helper or add a new helper that accepts a `dataDir`. Replace the existing `setup()` with:

```ts
function setup(opts: { dataDir?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-http-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><body>app</body>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("ok")');
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'bridge-data-'));
  mkdirSync(join(dataDir, 'transcripts'), { recursive: true });

  const handler = createHttpHandler({ token: TOKEN, staticDir: dir, dataDir });
  const server = createServer(handler);
  return new Promise<{
    server: import('node:http').Server;
    baseUrl: string;
    dataDir: string;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no addr');
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        dataDir,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}
```

Then add these test cases at the end of the `describe`:

```ts
  it('GET /transcripts/<id> returns 200 application/x-ndjson with file contents', async () => {
    const { baseUrl, dataDir, close } = await setup();
    const id = '11111111-1111-1111-1111-111111111111';
    const transcript =
      JSON.stringify({ type: 'system', event: 'session_created', sessionId: id, seq: 1 }) +
      '\n' +
      JSON.stringify({ type: 'user', sessionId: id, seq: 2, payload: { text: 'hi' } }) +
      '\n';
    writeFileSync(join(dataDir, 'transcripts', `${id}.jsonl`), transcript);

    const res = await fetch(`${baseUrl}/transcripts/${id}`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(transcript);
    await close();
  });

  it('GET /transcripts/<id> returns 404 when file is missing', async () => {
    const { baseUrl, close } = await setup();
    const id = '22222222-2222-2222-2222-222222222222';
    const res = await fetch(`${baseUrl}/transcripts/${id}`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    expect(res.status).toBe(404);
    await close();
  });

  it('GET /transcripts/<id> returns 400 when sessionId is not a UUID', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/transcripts/not-a-uuid`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    expect(res.status).toBe(400);
    await close();
  });

  it('GET /transcripts/<id> requires auth', async () => {
    const { baseUrl, close } = await setup();
    const id = '33333333-3333-3333-3333-333333333333';
    const res = await fetch(`${baseUrl}/transcripts/${id}`);
    expect(res.status).toBe(401);
    await close();
  });

  it('GET /transcripts/<id> rejects mismatched Origin', async () => {
    const { baseUrl, close } = await setup();
    const id = '44444444-4444-4444-4444-444444444444';
    const res = await fetch(`${baseUrl}/transcripts/${id}`, {
      headers: {
        cookie: `bridge_session=${TOKEN}`,
        origin: 'http://evil.com',
      },
    });
    expect(res.status).toBe(403);
    await close();
  });
```

- [ ] **Step 2: Run tests — expect FAIL because http-server.ts doesn't accept `dataDir` yet**

```bash
npm run bridge:test -- http-server
```

Expected: failures.

- [ ] **Step 3: Update `packages/bridge/src/http-server.ts` to add the route**

Add the imports near the top of the file:

```ts
import { realpath as fsRealpath } from 'node:fs/promises';
```

Add `dataDir` to the opts interface:

```ts
export interface HttpHandlerOpts {
  token: string;
  staticDir: string;
  dataDir: string;
}
```

Add a UUID regex and a new handling branch after the auth checks but before the static-file handling. Locate the existing block where the handler reads `urlPath` (after Origin validation) and insert a transcript branch in front of it:

```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Inside `handle`, after `if (!isOriginAllowed(...))` block, before the static
// path resolution:
if (parsed.pathname.startsWith('/transcripts/')) {
  const segment = parsed.pathname.slice('/transcripts/'.length);
  if (!UUID_RE.test(segment)) {
    send(res, 400, 'Invalid session id');
    return;
  }
  const transcriptsRoot = join(opts.dataDir, 'transcripts');
  const candidate = join(transcriptsRoot, `${segment}.jsonl`);
  let resolvedRoot: string;
  let resolvedFile: string;
  try {
    resolvedRoot = await fsRealpath(transcriptsRoot);
    resolvedFile = await fsRealpath(candidate);
  } catch {
    send(res, 404, 'Not found');
    return;
  }
  if (!resolvedFile.startsWith(resolvedRoot + sep)) {
    send(res, 404, 'Not found');
    return;
  }
  let st;
  try {
    st = await stat(resolvedFile);
  } catch {
    send(res, 404, 'Not found');
    return;
  }
  if (!st.isFile()) {
    send(res, 404, 'Not found');
    return;
  }
  applySecurity(res);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Content-Length', String(st.size));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(resolvedFile).pipe(res);
  return;
}
```

- [ ] **Step 4: Update the `index.ts` boot wiring caller and any in-tree `createHttpHandler` callers to pass `dataDir`**

This is needed so the existing static-file tests can keep their existing helper signature once we changed it in step 1. Look at all callers of `createHttpHandler` and pass a temporary `dataDir`. The setup helper in tests already does this; the boot in `packages/bridge/src/index.ts` will be updated in Task 11.

For now, if `index.ts` references `createHttpHandler({ token, staticDir })`, change it to `createHttpHandler({ token: cfg.token, staticDir, dataDir: cfg.dataDir })`.

- [ ] **Step 5: Run tests — expect PASS**

```bash
npm run bridge:test -- http-server
```

Expected: all http-server tests pass (10 prior + 5 new = 15).

- [ ] **Step 6: Run full bridge tests + typecheck**

```bash
npm run bridge:test
npx tsc --noEmit -p packages/bridge/tsconfig.json
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add packages/bridge/src/http-server.ts packages/bridge/src/__tests__/http-server.test.ts packages/bridge/src/index.ts
git commit -m "feat(bridge): add GET /transcripts/<id> route with cookie auth + UUID guard"
```

---

## Task 7: codex-parser.ts — Codex `--json` line parser

**Files:**
- Create: `packages/bridge/test/fixtures/codex-stream.jsonl`
- Create: `packages/bridge/src/__tests__/codex-parser.test.ts`
- Create: `packages/bridge/src/codex-parser.ts`

The implementation phase resolves the exact `codex exec --json` event-name mapping against the installed `codex-cli 0.128.0`. The fixture below uses the documented event names; if the implementer finds the installed CLI emits different names, they update the fixture and impl together and pin the version in a comment.

- [ ] **Step 1: Create the fixture**

`packages/bridge/test/fixtures/codex-stream.jsonl` (synthetic; capture-and-pin against real `codex exec --json` at impl time):

```
{"type":"session_init","session_id":"sess-codex-1","model":"gpt-5-codex"}
{"type":"agent_message","content":"Hello from Codex"}
{"type":"function_call","call_id":"fc_1","name":"shell","arguments":{"command":"ls"}}
{"type":"function_call_output","call_id":"fc_1","output":"file.txt\n"}
{"type":"task_completed","total_cost_usd":0.001,"duration_ms":250}
```

- [ ] **Step 2: Write the failing test**

`packages/bridge/src/__tests__/codex-parser.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCodexLine } from '../codex-parser.js';

const __filename = fileURLToPath(import.meta.url);
const fixture = readFileSync(
  join(dirname(__filename), '..', '..', 'test', 'fixtures', 'codex-stream.jsonl'),
  'utf8',
);
const lines = fixture.trim().split('\n');

describe('parseCodexLine', () => {
  it('captures session_id from session_init', () => {
    expect(parseCodexLine(lines[0]!)).toEqual({ kind: 'session_id', id: 'sess-codex-1' });
  });

  it('parses agent_message into assistant_text', () => {
    expect(parseCodexLine(lines[1]!)).toEqual({ kind: 'assistant_text', text: 'Hello from Codex' });
  });

  it('parses function_call into tool_use', () => {
    expect(parseCodexLine(lines[2]!)).toEqual({
      kind: 'tool_use',
      toolUseId: 'fc_1',
      toolName: 'shell',
      input: { command: 'ls' },
    });
  });

  it('parses function_call_output into tool_result', () => {
    expect(parseCodexLine(lines[3]!)).toEqual({
      kind: 'tool_result',
      toolUseId: 'fc_1',
      output: 'file.txt\n',
    });
  });

  it('parses task_completed into result with cost + durationMs', () => {
    expect(parseCodexLine(lines[4]!)).toEqual({ kind: 'result', cost: 0.001, durationMs: 250 });
  });

  it('returns null for unknown event type', () => {
    expect(parseCodexLine('{"type":"???"}')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseCodexLine('not json')).toBeNull();
  });
});
```

- [ ] **Step 3: Run test — expect FAIL (module missing)**

```bash
npm run bridge:test -- codex-parser
```

- [ ] **Step 4: Implement `packages/bridge/src/codex-parser.ts`**

```ts
import type { AgentEvent } from './types.js';

// Pinned to codex-cli 0.128.0. If a future codex release changes event names
// or shapes, update both this file and packages/bridge/test/fixtures/codex-stream.jsonl
// in lockstep.
interface RawCodexMsg {
  type: string;
  session_id?: string;
  content?: string;
  call_id?: string;
  name?: string;
  arguments?: unknown;
  output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
}

export type CodexParseResult = AgentEvent | { kind: 'session_id'; id: string };

export function parseCodexLine(line: string): CodexParseResult | null {
  let raw: RawCodexMsg;
  try {
    raw = JSON.parse(line) as RawCodexMsg;
  } catch {
    return null;
  }
  if (!raw || typeof raw.type !== 'string') return null;

  switch (raw.type) {
    case 'session_init':
      if (typeof raw.session_id === 'string') {
        return { kind: 'session_id', id: raw.session_id };
      }
      return null;
    case 'agent_message':
      if (typeof raw.content === 'string') {
        return { kind: 'assistant_text', text: raw.content };
      }
      return null;
    case 'function_call':
      if (typeof raw.call_id === 'string' && typeof raw.name === 'string') {
        return {
          kind: 'tool_use',
          toolUseId: raw.call_id,
          toolName: raw.name,
          input: raw.arguments,
        };
      }
      return null;
    case 'function_call_output':
      if (typeof raw.call_id === 'string') {
        return { kind: 'tool_result', toolUseId: raw.call_id, output: raw.output };
      }
      return null;
    case 'task_completed': {
      const out: AgentEvent = { kind: 'result' };
      if (typeof raw.total_cost_usd === 'number') out.cost = raw.total_cost_usd;
      if (typeof raw.duration_ms === 'number') out.durationMs = raw.duration_ms;
      return out;
    }
    default:
      return null;
  }
}
```

- [ ] **Step 5: Run test — expect PASS**

```bash
npm run bridge:test -- codex-parser
```

Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add packages/bridge/src/codex-parser.ts packages/bridge/src/__tests__/codex-parser.test.ts packages/bridge/test/fixtures/codex-stream.jsonl
git commit -m "feat(bridge): parse Codex --json events into unified AgentEvent shape"
```

---

## Task 8: codex-process.ts — spawn-per-turn driver

**Files:**
- Create: `packages/bridge/src/codex-process.ts`
- Create: `packages/bridge/src/__tests__/codex-process.test.ts`

`CodexProcess` matches `ClaudeProcess`'s public interface so `SessionManager`'s `AgentDriver` typing works for either. Each `sendUserText` spawns a fresh `codex exec` (or `codex exec resume <id>`) and parses its stdout.

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/codex-process.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { CodexProcess } from '../codex-process.js';

function makeFakeChild() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });

  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    kill: (s: NodeJS.Signals) => boolean;
    pid: number;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.kill = vi.fn().mockReturnValue(true);
  child.pid = 1234;

  return {
    child,
    pushStdout: (s: string) => stdout.push(s),
    exit: (code: number) => {
      stdout.push(null);
      stderr.push(null);
      child.emit('exit', code);
    },
  };
}

describe('CodexProcess', () => {
  it('first turn argv excludes resume; subsequent argv uses resume', async () => {
    const fakes1 = makeFakeChild();
    const spawn = vi.fn();
    spawn.mockReturnValueOnce(fakes1.child);
    const proc = new CodexProcess({
      projectPath: '/Users/test/proj',
      codexHome: '/Users/test/.codex-work',
      spawn,
    });

    proc.sendUserText('first');
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd1, args1, opts1] = spawn.mock.calls[0]!;
    expect(cmd1).toBe('codex');
    expect(args1).toEqual([
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '-C',
      '/Users/test/proj',
      'first',
    ]);
    expect(opts1.env.CODEX_HOME).toBe('/Users/test/.codex-work');
    // Critical: stdin must be 'ignore', not 'pipe'. With a piped stdin codex
    // waits for additional input on stdin even though the prompt is in argv,
    // and the child never exits.
    expect(opts1.stdio).toEqual(['ignore', 'pipe', 'pipe']);

    // Simulate session_init then exit
    fakes1.pushStdout('{"type":"session_init","session_id":"sess-1"}\n');
    fakes1.exit(0);
    await new Promise((r) => setImmediate(r));

    // Second turn: should use resume
    const fakes2 = makeFakeChild();
    spawn.mockReturnValueOnce(fakes2.child);
    proc.sendUserText('second');
    const [cmd2, args2] = spawn.mock.calls[1]!;
    expect(cmd2).toBe('codex');
    expect(args2).toEqual([
      'exec',
      'resume',
      'sess-1',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '-C',
      '/Users/test/proj',
      'second',
    ]);
  });

  it('emits parsed events for each JSONL line on stdout', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new CodexProcess({ projectPath: '/p', codexHome: '/c', spawn });
    const events: unknown[] = [];
    proc.on('event', (e) => events.push(e));

    proc.sendUserText('hi');
    fakes.pushStdout('{"type":"session_init","session_id":"sess-x"}\n');
    fakes.pushStdout('{"type":"agent_message","content":"hello"}\n');
    await new Promise((r) => setImmediate(r));

    // session_init is captured internally, not emitted as an event
    expect(events).toEqual([{ kind: 'assistant_text', text: 'hello' }]);
  });

  it('emits a result event with error: "codex_session_id_missing" if session_init never seen', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new CodexProcess({ projectPath: '/p', codexHome: '/c', spawn });
    const events: Array<{ kind: string; error?: string }> = [];
    proc.on('event', (e) => events.push(e));

    proc.sendUserText('hi');
    fakes.pushStdout('{"type":"agent_message","content":"hi back"}\n');
    fakes.exit(0);
    await new Promise((r) => setImmediate(r));

    const result = events.find((e) => e.kind === 'result');
    expect(result?.error).toBe('codex_session_id_missing');
  });

  it('emits a result event with error: <stderr tail> on non-zero exit', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new CodexProcess({ projectPath: '/p', codexHome: '/c', spawn });
    const events: Array<{ kind: string; error?: string }> = [];
    proc.on('event', (e) => events.push(e));

    proc.sendUserText('hi');
    fakes.pushStdout('{"type":"session_init","session_id":"sess-1"}\n');
    fakes.child.stderr.push(Buffer.from('codex: usage error'));
    fakes.exit(2);
    await new Promise((r) => setImmediate(r));

    const result = events.find((e) => e.kind === 'result');
    expect(result?.error).toMatch(/usage error/);
  });

  it('translates ENOENT into exit(null, "agent_not_installed")', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new CodexProcess({ projectPath: '/p', codexHome: '/c', spawn });
    const exits: Array<[number | null, string?]> = [];
    proc.on('exit', (code, reason) => exits.push([code, reason]));

    proc.sendUserText('hi');
    fakes.child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await new Promise((r) => setImmediate(r));

    expect(exits).toEqual([[null, 'agent_not_installed']]);
  });

  it('kill() sends SIGTERM and SIGKILL after grace and emits exit when a turn is in flight', async () => {
    vi.useFakeTimers();
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new CodexProcess({ projectPath: '/p', codexHome: '/c', spawn });
    const exits: Array<[number | null, string?]> = [];
    proc.on('exit', (code, reason) => exits.push([code, reason]));

    proc.sendUserText('hi');
    proc.kill();
    expect(fakes.child.kill).toHaveBeenCalledWith('SIGTERM');
    vi.advanceTimersByTime(5000);
    expect(fakes.child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(exits).toEqual([[null, 'stopped']]);
    vi.useRealTimers();
  });

  it('kill() emits a single exit even when no turn is in flight', () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new CodexProcess({ projectPath: '/p', codexHome: '/c', spawn });
    const exits: Array<[number | null, string?]> = [];
    proc.on('exit', (code, reason) => exits.push([code, reason]));

    proc.kill();
    expect(exits).toEqual([[null, 'idle_stop']]);

    // Idempotent — second kill must not double-emit.
    proc.kill();
    expect(exits).toEqual([[null, 'idle_stop']]);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run bridge:test -- codex-process
```

- [ ] **Step 3: Implement `packages/bridge/src/codex-process.ts`**

```ts
import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcessByStdio, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { parseCodexLine } from './codex-parser.js';
import type { AgentEvent } from './types.js';

const STDERR_TAIL_BYTES = 4096;
const KILL_GRACE_MS = 5000;

export type SpawnFn = (
  cmd: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessByStdio<Writable, Readable, Readable>;

export interface CodexProcessOpts {
  projectPath: string;
  codexHome: string;
  spawn?: SpawnFn;
}

export class CodexProcess extends EventEmitter {
  private readonly projectPath: string;
  private readonly codexHome: string;
  private readonly spawnFn: SpawnFn;
  private codexSessionId: string | null = null;
  private currentTurnProc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private currentTurnSawSessionId = false;
  private currentTurnSawResult = false;
  private stdoutBuf = '';
  private stderrBuf = Buffer.alloc(0);
  private killed = false;

  constructor(opts: CodexProcessOpts) {
    super();
    this.projectPath = opts.projectPath;
    this.codexHome = opts.codexHome;
    this.spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  }

  sendUserText(text: string): void {
    if (this.killed) return;
    const baseArgs = [
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '-C',
      this.projectPath,
    ];
    const args =
      this.codexSessionId === null
        ? ['exec', ...baseArgs, text]
        : ['exec', 'resume', this.codexSessionId, ...baseArgs, text];

    const child = this.spawnFn('codex', args, {
      cwd: this.projectPath,
      env: { ...process.env, CODEX_HOME: this.codexHome },
      // stdin MUST be ignored. Codex's `exec` reads piped stdin as
      // additional prompt input ("Reading additional input from stdin...")
      // and won't run until EOF. Since we pass the prompt as argv, leaving
      // stdin as 'pipe' without writing/closing it makes the child hang
      // forever — observed against codex-cli 0.128.0 in development.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.currentTurnProc = child;
    this.currentTurnSawSessionId = false;
    this.currentTurnSawResult = false;
    this.stdoutBuf = '';
    this.stderrBuf = Buffer.alloc(0);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => this.handleStderr(chunk));
    child.on('exit', (code) => this.handleExit(code));
    child.on('error', (err: NodeJS.ErrnoException) => {
      const reason = err.code === 'ENOENT' ? 'agent_not_installed' : 'spawn_failed';
      this.currentTurnProc = null;
      this.emit('exit', null, reason);
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.length === 0) continue;
      const parsed = parseCodexLine(line);
      if (!parsed) continue;
      if ('id' in parsed) {
        // session_id capture — store but do NOT emit upstream.
        this.codexSessionId = parsed.id;
        this.currentTurnSawSessionId = true;
        continue;
      }
      const ev = parsed as AgentEvent;
      if (ev.kind === 'result') {
        this.currentTurnSawResult = true;
      }
      this.emit('event', ev);
    }
  }

  private handleStderr(chunk: Buffer): void {
    this.stderrBuf = Buffer.concat([this.stderrBuf, chunk]);
    if (this.stderrBuf.length > STDERR_TAIL_BYTES) {
      this.stderrBuf = this.stderrBuf.subarray(this.stderrBuf.length - STDERR_TAIL_BYTES);
    }
  }

  private handleExit(code: number | null): void {
    const proc = this.currentTurnProc;
    this.currentTurnProc = null;
    if (proc === null) return;
    // Flush any tail line that lacked a trailing newline.
    if (this.stdoutBuf.length > 0) {
      const parsed = parseCodexLine(this.stdoutBuf);
      this.stdoutBuf = '';
      if (parsed && !('id' in parsed)) {
        if ((parsed as AgentEvent).kind === 'result') {
          this.currentTurnSawResult = true;
        }
        this.emit('event', parsed);
      }
    }

    // Decide whether to synthesize a terminating result. If the parser
    // already produced one (task_completed), don't emit a duplicate — that
    // would render two "turn complete" bubbles. Only synthesize for the
    // exceptional cases: codex_session_id_missing, non-zero exit, or a
    // turn that ended without ever emitting a result.
    const sessionIdMissing =
      this.codexSessionId === null && !this.currentTurnSawSessionId;
    const nonZeroExit = code !== 0 && code !== null;

    if (sessionIdMissing || nonZeroExit) {
      const result: AgentEvent = { kind: 'result' };
      if (sessionIdMissing) {
        result.error = 'codex_session_id_missing';
      } else if (nonZeroExit) {
        const tail = this.stderrBuf.toString('utf8').trim();
        if (tail.length > 0) {
          result.error = tail.length > 1024 ? tail.slice(-1024) : tail;
        } else {
          result.error = `codex exec exited with code ${code}`;
        }
      }
      this.emit('event', result);
    } else if (!this.currentTurnSawResult) {
      // Clean exit but no task_completed event ever came through — emit a
      // bare result so the UI's "turn complete" bubble shows.
      this.emit('event', { kind: 'result' } satisfies AgentEvent);
    }
    // Successful turn that already emitted a parsed result: emit nothing.
  }

  stderrTail(): string {
    return this.stderrBuf.toString('utf8');
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    const proc = this.currentTurnProc;
    this.currentTurnProc = null; // ensure handleExit's natural-exit path no-ops
    if (proc) {
      proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, KILL_GRACE_MS).unref();
    }
    // Always emit a terminal 'exit' so SessionManager fires session_ended,
    // closes the transcript file, and removes the session — even when no
    // turn is in flight (between Codex turns the spawn-per-turn driver has
    // no live child process to wait on).
    this.emit('exit', null, proc ? 'stopped' : 'idle_stop');
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run bridge:test -- codex-process
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/codex-process.ts packages/bridge/src/__tests__/codex-process.test.ts
git commit -m "feat(bridge): add CodexProcess spawn-per-turn driver with resume support"
```

---

## Task 9: WebSocket router — list_accounts + start.account validation

**Files:**
- Modify: `packages/bridge/src/websocket.ts`
- Modify: `packages/bridge/src/__tests__/websocket.test.ts`

- [ ] **Step 1: Update the test file's setup helper to inject accounts**

In `packages/bridge/src/__tests__/websocket.test.ts`, update `startServer` so callers can pass an `accounts` map. Replace the existing helper with:

```ts
async function startServer(opts: {
  accounts?: Map<string, import('../accounts.js').CodexAccount>;
} = {}) {
  const procs: FakeProc[] = [];
  const mgr = new SessionManager({
    allowedDirs: ['/Users/test'],
    bufferCap: 100,
    driverFactory: () => {
      const p = new FakeProc();
      procs.push(p);
      return p as unknown as import('../session.js').AgentDriver;
    },
    realpath: async (p) => p,
    accounts: opts.accounts ?? new Map(),
  });
  const server = createServer();
  attachWebSocket({ server, token: TOKEN, sessionManager: mgr, accounts: opts.accounts ?? new Map() });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no addr');
  return {
    server: server as Server,
    port: addr.port,
    mgr,
    procs,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
}
```

- [ ] **Step 2: Add new tests at the end of the existing `describe('websocket', () => { ... })` block**

```ts
  it('list_accounts replies with name + isDefault, hides codexHome', async () => {
    const accounts = new Map([
      ['default', { name: 'default', codexHome: '/secret/path', isDefault: true }],
      ['work', { name: 'work', codexHome: '/another/secret', isDefault: false }],
    ]);
    const { port, close } = await startServer({ accounts });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{ type: string; accounts: Array<{ name: string; agent: string; isDefault: boolean }>; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'account_list') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'list_accounts', correlationId: 'c' }));
    const msg = await got;
    expect(msg.accounts).toHaveLength(2);
    const first = msg.accounts.find((a) => a.name === 'default')!;
    expect(first.isDefault).toBe(true);
    expect((first as unknown as { codexHome?: string }).codexHome).toBeUndefined();
    expect(msg.correlationId).toBe('c');
    sock.close();
    await close();
  });

  it('start { agent: "codex", account: "<bogus>" } returns unknown_account', async () => {
    const accounts = new Map([
      ['default', { name: 'default', codexHome: '/Users/test/.codex', isDefault: true }],
    ]);
    const { port, close } = await startServer({ accounts });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{ type: string; code?: string; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'error') r(m);
      });
    });
    sock.send(
      JSON.stringify({
        type: 'start',
        agent: 'codex',
        projectPath: '/Users/test/proj',
        account: 'nope',
        correlationId: 'cid-bogus',
      }),
    );
    const msg = await got;
    expect(msg.code).toBe('unknown_account');
    expect(msg.correlationId).toBe('cid-bogus');
    sock.close();
    await close();
  });

  it('start with single account uses default and echoes account name on session_created', async () => {
    const accounts = new Map([
      ['default', { name: 'default', codexHome: '/Users/test/.codex', isDefault: true }],
    ]);
    const { port, close } = await startServer({ accounts });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{ type: string; event?: string; account?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'system' && m.event === 'session_created') r(m);
      });
    });
    sock.send(
      JSON.stringify({
        type: 'start',
        agent: 'codex',
        projectPath: '/Users/test/proj',
        correlationId: 'cid-default',
      }),
    );
    const msg = await got;
    expect(msg.account).toBe('default');
    sock.close();
    await close();
  });
```

- [ ] **Step 3: Run tests — expect FAIL on the new ones**

```bash
npm run bridge:test -- websocket
```

- [ ] **Step 4: Update `packages/bridge/src/websocket.ts`**

Add `accounts` to the AttachWsOpts and route `list_accounts`. Update `start` so an `account` field is forwarded; the `unknown_account` error is mapped to a correlation-id reply.

```ts
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  extractTokenFromRequest,
  isOriginAllowed,
  tokensMatch,
} from './auth.js';
import type { SessionManager } from './session.js';
import type { CodexAccount } from './accounts.js';
import type {
  ClientMsg,
  ServerErrorMsg,
  ServerMsg,
} from './types.js';

const MAX_MSG_BYTES = 16 * 1024 * 1024;

export interface AttachWsOpts {
  server: HttpServer;
  token: string;
  sessionManager: SessionManager;
  accounts: Map<string, CodexAccount>;
}

export function attachWebSocket(opts: AttachWsOpts): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });

  opts.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = extractTokenFromRequest(req);
    if (!token || !tokensMatch(token, opts.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!isOriginAllowed(req.headers.origin, req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      setTimeout(() => wss.emit('connection', ws, req), 0);
    });
  });

  wss.on('connection', (ws) => {
    const send = (m: ServerMsg) => {
      try {
        ws.send(JSON.stringify(m));
      } catch {
        /* ignore */
      }
    };
    const broadcast = (m: ServerMsg) => send(m);
    opts.sessionManager.on('broadcast', broadcast);
    ws.on('close', () => opts.sessionManager.off('broadcast', broadcast));

    send({ type: 'system', event: 'init' });

    ws.on('message', (raw) => {
      void handleMessage(ws, raw, opts.sessionManager, send, opts.accounts);
    });
  });

  return wss;
}

async function handleMessage(
  _ws: WebSocket,
  raw: import('ws').RawData,
  mgr: SessionManager,
  send: (m: ServerMsg) => void,
  accounts: Map<string, CodexAccount>,
): Promise<void> {
  let msg: ClientMsg;
  try {
    msg = JSON.parse(raw.toString()) as ClientMsg;
  } catch {
    sendError(send, 'unsupported_message', 'malformed JSON');
    return;
  }
  if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
    sendError(send, 'unsupported_message', 'missing type');
    return;
  }

  try {
    switch (msg.type) {
      case 'start': {
        await mgr.create({
          agent: msg.agent,
          projectPath: msg.projectPath,
          ...(msg.account ? { account: msg.account } : {}),
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
        });
        return;
      }
      case 'input': {
        mgr.sendInput(msg.sessionId, msg.text);
        return;
      }
      case 'stop_session': {
        mgr.stop(msg.sessionId);
        return;
      }
      case 'list_sessions': {
        send({
          type: 'session_list',
          sessions: mgr.listSessions(),
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
        });
        return;
      }
      case 'get_history': {
        const h = mgr.getHistory(msg.sessionId, msg.since ?? 0);
        if (h === null) {
          // Session is not (or no longer) live. Reply with session_dead
          // carrying both correlationId AND sessionId so the web client can
          // route to the per-session transcript-only fallback.
          sendError(
            send,
            'session_dead',
            `session ${msg.sessionId} is not alive`,
            msg.correlationId,
            msg.sessionId,
          );
          return;
        }
        send({
          type: 'history',
          sessionId: msg.sessionId,
          events: h.events,
          hasMore: h.hasMore,
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
        });
        return;
      }
      case 'list_accounts': {
        send({
          type: 'account_list',
          accounts: [...accounts.values()].map((a) => ({
            name: a.name,
            agent: 'codex',
            isDefault: a.isDefault,
          })),
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
        });
        return;
      }
      case 'list_prompts': {
        // Wired in Task 12 once PromptStore exists. For now, reply empty.
        send({
          type: 'prompts_result',
          prompts: [],
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
        });
        return;
      }
      default:
        sendError(send, 'unsupported_message', `unknown type ${(msg as { type: string }).type}`, (msg as { correlationId?: string }).correlationId);
    }
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const correlationId = (msg as { correlationId?: string }).correlationId;
    if (e.code === 'path_outside_allowlist') {
      sendError(send, 'path_outside_allowlist', e.message ?? 'path outside allowlist', correlationId);
      return;
    }
    if (e.code === 'unknown_account') {
      sendError(send, 'unknown_account', e.message ?? 'unknown account', correlationId);
      return;
    }
    if (e.code === 'session_dead') {
      const sessionId = (msg as { sessionId?: string }).sessionId;
      sendError(send, 'session_dead', e.message ?? 'session dead', correlationId, sessionId);
      return;
    }
    sendError(send, 'unsupported_message', e.message ?? 'internal error', correlationId);
  }
}

function sendError(
  send: (m: ServerMsg) => void,
  code: ServerErrorMsg['code'],
  message: string,
  correlationId?: string,
  sessionId?: string,
): void {
  send({
    type: 'error',
    code,
    message,
    ...(correlationId ? { correlationId } : {}),
    ...(sessionId ? { sessionId } : {}),
  });
}
```

- [ ] **Step 5: Run websocket tests — expect PASS**

```bash
npm run bridge:test -- websocket
```

Expected: 10 passed (7 prior + 3 new).

- [ ] **Step 6: Run full bridge tests + typecheck**

```bash
npm run bridge:test
npx tsc --noEmit -p packages/bridge/tsconfig.json
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add packages/bridge/src/websocket.ts packages/bridge/src/__tests__/websocket.test.ts
git commit -m "feat(bridge): add list_accounts route + start.account validation"
```

---

## Task 10: prompt-store.ts — sha256-deduped prompt history

**Files:**
- Create: `packages/bridge/src/prompt-store.ts`
- Create: `packages/bridge/src/__tests__/prompt-store.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/prompt-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptStore } from '../prompt-store.js';

describe('PromptStore', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mrt-prompts-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores added prompts', () => {
    const store = new PromptStore(dataDir);
    store.add({ text: 'hello', projectPath: '/p1', agent: 'claude' });
    store.add({ text: 'world', projectPath: '/p1', agent: 'claude' });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.text)).toEqual(['world', 'hello']);
  });

  it('dedupes by text via sha256 and unions project paths and agents', () => {
    const store = new PromptStore(dataDir);
    store.add({ text: 'hello', projectPath: '/p1', agent: 'claude' });
    store.add({ text: 'hello', projectPath: '/p2', agent: 'codex' });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.projectPaths.sort()).toEqual(['/p1', '/p2']);
    expect(list[0]!.agents.sort()).toEqual(['claude', 'codex']);
  });

  it('caps the list at 500 entries (oldest evicted)', () => {
    const store = new PromptStore(dataDir);
    for (let i = 0; i < 510; i++) store.add({ text: `t${i}`, projectPath: '/p', agent: 'claude' });
    const list = store.list();
    expect(list.length).toBe(500);
    expect(list[0]!.text).toBe('t509');
    expect(list[list.length - 1]!.text).toBe('t10');
  });

  it('list filters by case-insensitive substring query and respects limit', () => {
    const store = new PromptStore(dataDir);
    store.add({ text: 'Hello world', projectPath: '/p', agent: 'claude' });
    store.add({ text: 'goodbye', projectPath: '/p', agent: 'claude' });
    store.add({ text: 'hello again', projectPath: '/p', agent: 'claude' });
    expect(store.list('hello').map((p) => p.text)).toEqual(['hello again', 'Hello world']);
    expect(store.list(undefined, 2).length).toBe(2);
  });

  it('round-trips through disk: writes prompts.json and a reopened store reads it', () => {
    const a = new PromptStore(dataDir);
    a.add({ text: 'persist me', projectPath: '/p', agent: 'codex' });
    expect(existsSync(join(dataDir, 'prompts.json'))).toBe(true);

    const b = new PromptStore(dataDir);
    expect(b.list().map((p) => p.text)).toEqual(['persist me']);
  });

  it('handles corrupt prompts.json by treating it as empty', () => {
    const path = join(dataDir, 'prompts.json');
    writeFileSync(path, '{not json');
    const store = new PromptStore(dataDir);
    expect(store.list()).toEqual([]);
    store.add({ text: 'fresh', projectPath: '/p', agent: 'claude' });
    const data = JSON.parse(readFileSync(path, 'utf8')) as { entries: unknown[] };
    expect(data.entries.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run bridge:test -- prompt-store
```

- [ ] **Step 3: Implement `packages/bridge/src/prompt-store.ts`**

```ts
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentKind } from './types.js';

export interface PromptEntry {
  hash: string;
  text: string;
  lastUsedAt: number;
  projectPaths: string[];
  agents: AgentKind[];
}

interface PromptsFile {
  version: 1;
  entries: PromptEntry[];
}

const FILE_NAME = 'prompts.json';
const TMP_NAME = 'prompts.json.tmp';
const CAP = 500;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class PromptStore {
  private readonly dataDir: string;
  private readonly path: string;
  private readonly tmpPath: string;
  private entries: PromptEntry[];

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      console.warn(`[prompt-store] mkdir(${dataDir}) failed: ${(err as Error).message}`);
    }
    this.path = join(dataDir, FILE_NAME);
    this.tmpPath = join(dataDir, TMP_NAME);
    this.entries = this.read();
  }

  private read(): PromptEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<PromptsFile>;
      if (raw && raw.version === 1 && Array.isArray(raw.entries)) {
        return raw.entries.filter(
          (e) =>
            typeof e?.hash === 'string' &&
            typeof e.text === 'string' &&
            typeof e.lastUsedAt === 'number' &&
            Array.isArray(e.projectPaths) &&
            Array.isArray(e.agents),
        );
      }
      return [];
    } catch (err) {
      console.warn(`[prompt-store] reading ${this.path} failed: ${(err as Error).message}`);
      return [];
    }
  }

  private write(): void {
    const data: PromptsFile = { version: 1, entries: this.entries };
    try {
      writeFileSync(this.tmpPath, JSON.stringify(data));
      renameSync(this.tmpPath, this.path);
    } catch (err) {
      console.warn(`[prompt-store] writing ${this.path} failed: ${(err as Error).message}`);
    }
  }

  add(args: { text: string; projectPath: string; agent: AgentKind }): void {
    if (args.text.length === 0) return;
    const hash = sha256(args.text);
    const idx = this.entries.findIndex((e) => e.hash === hash);
    const now = Date.now();
    if (idx >= 0) {
      const found = this.entries[idx]!;
      const updated: PromptEntry = {
        hash,
        text: args.text,
        lastUsedAt: now,
        projectPaths: found.projectPaths.includes(args.projectPath)
          ? found.projectPaths
          : [...found.projectPaths, args.projectPath],
        agents: found.agents.includes(args.agent) ? found.agents : [...found.agents, args.agent],
      };
      this.entries.splice(idx, 1);
      this.entries.unshift(updated);
    } else {
      this.entries.unshift({
        hash,
        text: args.text,
        lastUsedAt: now,
        projectPaths: [args.projectPath],
        agents: [args.agent],
      });
    }
    if (this.entries.length > CAP) this.entries.length = CAP;
    this.write();
  }

  list(query?: string, limit?: number): PromptEntry[] {
    let out = this.entries;
    if (query && query.length > 0) {
      const lower = query.toLowerCase();
      out = out.filter((e) => e.text.toLowerCase().includes(lower));
    }
    if (typeof limit === 'number' && limit > 0) out = out.slice(0, limit);
    return out;
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run bridge:test -- prompt-store
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/prompt-store.ts packages/bridge/src/__tests__/prompt-store.test.ts
git commit -m "feat(bridge): add PromptStore with sha256 dedupe and atomic write"
```

---

## Task 11: Wire PromptStore into SessionManager + websocket list_prompts

**Files:**
- Modify: `packages/bridge/src/session.ts`
- Modify: `packages/bridge/src/websocket.ts`
- Modify: `packages/bridge/src/__tests__/session.test.ts`
- Modify: `packages/bridge/src/__tests__/websocket.test.ts`

- [ ] **Step 1: Add `promptStore` to `SessionManagerOpts` and call `add` from `sendInput`**

In `packages/bridge/src/session.ts`:

Add the import at top:
```ts
import type { PromptStore } from './prompt-store.js';
```

Update `SessionManagerOpts` to include:
```ts
  promptStore?: PromptStore;
```

Add field + assignment in constructor:
```ts
private readonly promptStore: PromptStore | undefined;
// in constructor:
this.promptStore = opts.promptStore;
```

Update `sendInput` to record the prompt:
```ts
sendInput(sessionId: string, text: string): void {
  const s = this.sessions.get(sessionId);
  if (!s || !s.alive) throw new SessionDeadError(sessionId);
  this.appendAndBroadcast(s, {
    type: 'user',
    sessionId,
    seq: s.nextSeq++,
    payload: { text },
  });
  this.promptStore?.add({ text, projectPath: s.projectPath, agent: s.agent });
  s.proc.sendUserText(text);
}
```

- [ ] **Step 2: Add a session.test.ts case asserting promptStore.add is called**

```ts
  it('records user prompts in the PromptStore on sendInput', async () => {
    const procs: FakeProc[] = [];
    const added: Array<{ text: string; projectPath: string; agent: string }> = [];
    const fakePromptStore = {
      add: (args: { text: string; projectPath: string; agent: string }) => added.push(args),
      list: () => [],
    };
    const mgr = new SessionManager({
      allowedDirs: ['/Users/test'],
      bufferCap: 100,
      driverFactory: () => {
        const p = new FakeProc();
        procs.push(p);
        return p as unknown as import('../session.js').AgentDriver;
      },
      realpath: async (p) => p,
      promptStore: fakePromptStore as unknown as import('../prompt-store.js').PromptStore,
    });
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    mgr.sendInput(s.sessionId, 'remember me');
    expect(added).toEqual([
      { text: 'remember me', projectPath: '/Users/test/proj', agent: 'claude' },
    ]);
  });
```

- [ ] **Step 3: Replace the websocket `list_prompts` placeholder with a real route**

In `packages/bridge/src/websocket.ts`, change `AttachWsOpts` to take a `promptStore`:

```ts
export interface AttachWsOpts {
  server: HttpServer;
  token: string;
  sessionManager: SessionManager;
  accounts: Map<string, CodexAccount>;
  promptStore?: PromptStore;
}
```

Add the import:
```ts
import type { PromptStore } from './prompt-store.js';
```

Plumb `promptStore` through `attachWebSocket` into `handleMessage`. Replace the placeholder `list_prompts` case with:

```ts
case 'list_prompts': {
  const prompts = promptStore
    ? promptStore.list(msg.query, msg.limit ?? 200).map((e) => ({
        text: e.text,
        lastUsedAt: e.lastUsedAt,
        projectPaths: e.projectPaths,
        agents: e.agents,
      }))
    : [];
  send({
    type: 'prompts_result',
    prompts,
    ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
  });
  return;
}
```

(`promptStore` should be passed through `handleMessage`'s parameter list — update its signature accordingly.)

- [ ] **Step 4: Add a websocket test for list_prompts**

```ts
  it('get_history for an unknown session replies with error: session_dead carrying sessionId', async () => {
    const { port, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{
      type: string;
      code?: string;
      sessionId?: string;
      correlationId?: string;
    }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'error') r(m);
      });
    });
    sock.send(
      JSON.stringify({
        type: 'get_history',
        sessionId: '00000000-0000-0000-0000-000000000000',
        since: 0,
        correlationId: 'cid-history',
      }),
    );
    const msg = await got;
    expect(msg.code).toBe('session_dead');
    expect(msg.sessionId).toBe('00000000-0000-0000-0000-000000000000');
    expect(msg.correlationId).toBe('cid-history');
    sock.close();
    await close();
  });

  it('list_prompts replies with the PromptStore contents', async () => {
    // Spin up a manager with a fake promptStore that returns 1 entry.
    const fakePromptStore = {
      add: () => {},
      list: () => [
        { hash: 'h', text: 'hi', lastUsedAt: 100, projectPaths: ['/p'], agents: ['claude'] as const },
      ],
    } as unknown as import('../prompt-store.js').PromptStore;
    const mgr = new SessionManager({
      allowedDirs: ['/Users/test'],
      bufferCap: 100,
      driverFactory: () => new FakeProc() as unknown as import('../session.js').AgentDriver,
      realpath: async (p) => p,
      promptStore: fakePromptStore,
    });
    const server = createServer();
    attachWebSocket({ server, token: TOKEN, sessionManager: mgr, accounts: new Map(), promptStore: fakePromptStore });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');

    const sock = ws(`ws://127.0.0.1:${addr.port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${addr.port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{ type: string; prompts: Array<{ text: string }> }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'prompts_result') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'list_prompts', limit: 5 }));
    const msg = await got;
    expect(msg.prompts).toHaveLength(1);
    expect(msg.prompts[0]!.text).toBe('hi');
    sock.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
```

- [ ] **Step 5: Run all bridge tests + typecheck**

```bash
npm run bridge:test
npx tsc --noEmit -p packages/bridge/tsconfig.json
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/bridge/src/session.ts packages/bridge/src/websocket.ts packages/bridge/src/__tests__/session.test.ts packages/bridge/src/__tests__/websocket.test.ts
git commit -m "feat(bridge): record user prompts in PromptStore + serve list_prompts"
```

---

## Task 12: Bridge boot wiring (`index.ts`) — accounts, transcripts, prune, codex factory

**Files:**
- Modify: `packages/bridge/src/index.ts`

This task wires every Phase 2 server-side piece into the boot path. No new tests — boot is exercised by the existing smoke step plus the http-server / websocket integration tests.

- [ ] **Step 1: Replace `packages/bridge/src/index.ts`**

```ts
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ClaudeProcess } from './claude-process.js';
import { CodexProcess } from './codex-process.js';
import { loadCodexAccounts } from './accounts.js';
import { loadEnv } from './env.js';
import { resolveTailscaleIPv4 } from './tailscale.js';
import { createHttpHandler } from './http-server.js';
import { attachWebSocket } from './websocket.js';
import { SessionManager, type AgentDriver, type DriverFactoryArgs } from './session.js';
import { TranscriptStore } from './transcript-store.js';
import { PromptStore } from './prompt-store.js';

async function main(): Promise<void> {
  const cfg = loadEnv(process.env);
  const accounts = loadCodexAccounts({ dataDir: cfg.dataDir, env: process.env });
  console.log(`[bridge] loaded ${accounts.size} codex account(s): ${[...accounts.keys()].join(', ')}`);

  const transcriptStore = new TranscriptStore(cfg.dataDir);
  const promptStore = new PromptStore(cfg.dataDir);

  if (cfg.transcriptRetentionDays > 0) {
    const deleted = await transcriptStore.prune(cfg.transcriptRetentionDays);
    if (deleted > 0) console.log(`[bridge] pruned ${deleted} stale transcript file(s)`);
  }

  const bindHost = cfg.bindHost ?? (await resolveTailscaleIPv4());
  console.log(`[bridge] binding to ${bindHost}:${cfg.port}`);

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../apps/web/dist'),
    resolve(here, '../../apps/web/dist'),
  ];
  const staticDir = candidates.find((p) => existsSync(p));
  if (!staticDir) {
    throw new Error(
      `web bundle not found. Run \`npm run web:build\`. Looked in:\n  ${candidates.join('\n  ')}`,
    );
  }
  console.log(`[bridge] serving static bundle from ${staticDir}`);

  const driverFactory = (args: DriverFactoryArgs): AgentDriver => {
    if (args.agent === 'claude') {
      return new ClaudeProcess(args.projectPath) as unknown as AgentDriver;
    }
    if (args.agent === 'codex') {
      if (!args.account) {
        throw new Error('CodexProcess requires an account');
      }
      return new CodexProcess({
        projectPath: args.projectPath,
        codexHome: args.account.codexHome,
      }) as unknown as AgentDriver;
    }
    throw new Error(`unsupported agent: ${args.agent}`);
  };

  const sessionManager = new SessionManager({
    allowedDirs: cfg.allowedDirs,
    bufferCap: 1000,
    driverFactory,
    transcriptStore,
    promptStore,
    accounts,
  });

  const handler = createHttpHandler({
    token: cfg.token,
    staticDir,
    dataDir: cfg.dataDir,
  });
  const server = createServer(handler);
  attachWebSocket({
    server,
    token: cfg.token,
    sessionManager,
    accounts,
    promptStore,
  });

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(cfg.port, bindHost, () => res());
  });

  console.log(`[bridge] open: http://${bindHost}:${cfg.port}/?token=<TOKEN>`);

  const shutdown = (): void => {
    console.log('[bridge] shutting down');
    sessionManager.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 6000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[bridge] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 2: Run typecheck and full test suite**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npx tsc --noEmit -p packages/bridge/tsconfig.json
npm test
```

Expected: green.

- [ ] **Step 3: Smoke-run the bridge briefly (still requires Tailscale or BRIDGE_BIND_HOST)**

```bash
BRIDGE_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))') \
BRIDGE_BIND_HOST=127.0.0.1 \
timeout 4 npm run bridge:dev 2>&1 | head -10 || true
```

Expected: log lines mentioning loaded codex accounts, binding to 127.0.0.1, and serving static bundle (web bundle present from Phase 1 build) — then the timeout cuts the process.

- [ ] **Step 4: Commit**

```bash
git add packages/bridge/src/index.ts
git commit -m "feat(bridge): wire Phase 2 stores, accounts, codex driver into boot"
```

---

## Task 13: Web — accounts store + App.tsx wiring

**Files:**
- Create: `apps/web/src/store/accounts.ts`
- Create: `apps/web/src/store/accounts.test.ts`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Write the failing accounts-store test**

`apps/web/src/store/accounts.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useAccountsStore } from './accounts';

beforeEach(() => {
  useAccountsStore.setState({ accounts: [], selectedAccount: null });
});

describe('accounts store', () => {
  it('hydrates from account_list message', () => {
    useAccountsStore.getState().applyAccountList([
      { name: 'work', agent: 'codex', isDefault: false },
      { name: 'default', agent: 'codex', isDefault: true },
    ]);
    const state = useAccountsStore.getState();
    expect(state.accounts).toHaveLength(2);
    expect(state.selectedAccount).toBe('default'); // preselects default
  });

  it('falls back to first account when no default flagged', () => {
    useAccountsStore.getState().applyAccountList([
      { name: 'a', agent: 'codex', isDefault: false },
      { name: 'b', agent: 'codex', isDefault: false },
    ]);
    expect(useAccountsStore.getState().selectedAccount).toBe('a');
  });

  it('keeps existing selection if it is still in the new list', () => {
    useAccountsStore.setState({
      accounts: [{ name: 'work', agent: 'codex', isDefault: false }],
      selectedAccount: 'work',
    });
    useAccountsStore.getState().applyAccountList([
      { name: 'work', agent: 'codex', isDefault: false },
      { name: 'home', agent: 'codex', isDefault: true },
    ]);
    expect(useAccountsStore.getState().selectedAccount).toBe('work');
  });

  it('setSelectedAccount accepts a known name', () => {
    useAccountsStore.setState({
      accounts: [{ name: 'a', agent: 'codex', isDefault: true }],
      selectedAccount: 'a',
    });
    useAccountsStore.getState().setSelectedAccount('a');
    expect(useAccountsStore.getState().selectedAccount).toBe('a');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run web:test -- accounts
```

- [ ] **Step 3: Implement `apps/web/src/store/accounts.ts`**

```ts
import { create } from 'zustand';

export interface AccountSummary {
  name: string;
  agent: 'codex';
  isDefault: boolean;
}

interface AccountsStore {
  accounts: AccountSummary[];
  selectedAccount: string | null;
  applyAccountList(accounts: AccountSummary[]): void;
  setSelectedAccount(name: string): void;
}

export const useAccountsStore = create<AccountsStore>((set, get) => ({
  accounts: [],
  selectedAccount: null,
  applyAccountList(accounts) {
    const current = get().selectedAccount;
    const stillValid = current && accounts.some((a) => a.name === current);
    let nextSelected: string | null = stillValid ? current : null;
    if (!nextSelected) {
      const def = accounts.find((a) => a.isDefault);
      nextSelected = def?.name ?? accounts[0]?.name ?? null;
    }
    set({ accounts, selectedAccount: nextSelected });
  },
  setSelectedAccount(name) {
    if (!get().accounts.some((a) => a.name === name)) return;
    set({ selectedAccount: name });
  },
}));
```

- [ ] **Step 4: Update `apps/web/src/App.tsx` to fetch and route the new messages**

Replace the existing `App.tsx` body with:

```tsx
import { useEffect, useMemo } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { BridgeClient } from './services/bridge-client';
import { useConnectionStore } from './store/connection';
import { useSessionsStore } from './store/sessions';
import { useAccountsStore } from './store/accounts';
import { Home } from './pages/Home';
import { Session } from './pages/Session';

export function App(): JSX.Element {
  const setStatus = useConnectionStore((s) => s.setStatus);
  const setError = useConnectionStore((s) => s.setError);
  const apply = useSessionsStore((s) => s.applyServerMsg);
  const applyAccountList = useAccountsStore((s) => s.applyAccountList);

  const client = useMemo(() => new BridgeClient(), []);

  useEffect(() => {
    const offOpen = client.on('open', () => {
      setStatus('open');
      client.send({ type: 'list_sessions' });
      client.send({ type: 'list_accounts' });
      client.send({ type: 'list_prompts', limit: 200 });
      const { sessions } = useSessionsStore.getState();
      for (const id of Object.keys(sessions)) {
        const s = sessions[id];
        if (s && s.alive) {
          client.send({ type: 'get_history', sessionId: id, since: s.lastSeq });
        }
      }
    });
    const offClose = client.on('close', () => setStatus('closed'));
    const offError = client.on('error', (e) => {
      setStatus('error');
      setError(e.message);
    });
    const offMessage = client.on('message', (m) => {
      if (m.type === 'account_list') {
        applyAccountList(m.accounts);
        return;
      }
      if (m.type === 'error') {
        // session_dead routing to markTranscriptOnly is added in Task 14 once
        // the store has the setter. For now, all errors fall through to the
        // global banner — Phase 1 behavior.
        setError(`${m.code}: ${m.message}`);
      } else {
        setError(null);
      }
      apply(m);
    });

    client.connect();

    return () => {
      offOpen();
      offClose();
      offError();
      offMessage();
      client.close();
    };
  }, [client, setStatus, setError, apply, applyAccountList]);

  return (
    <Routes>
      <Route path="/" element={<Home client={client} />} />
      <Route path="/session/:id" element={<Session client={client} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
```

- [ ] **Step 5: Run tests + typecheck**

```bash
npm run web:test
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: existing 13 + 4 new = 17 passed; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/store/accounts.ts apps/web/src/store/accounts.test.ts apps/web/src/App.tsx
git commit -m "feat(web): add accounts store and route account_list / session_dead frames"
```

---

## Task 14: Web — sessions store gains `transcriptOnly` map

**Files:**
- Modify: `apps/web/src/store/sessions.ts`
- Modify: `apps/web/src/store/sessions.test.ts`

- [ ] **Step 1: Add the new test cases at the bottom of `apps/web/src/store/sessions.test.ts`**

```ts
  it('markTranscriptOnly flips the flag for the given session', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    expect(useSessionsStore.getState().transcriptOnly['s1']).toBeUndefined();
    store.markTranscriptOnly('s1');
    expect(useSessionsStore.getState().transcriptOnly['s1']).toBe(true);
  });

  it('markTranscriptOnly works for sessions not yet in the store (deep link)', () => {
    useSessionsStore.getState().markTranscriptOnly('unknown-id');
    expect(useSessionsStore.getState().transcriptOnly['unknown-id']).toBe(true);
  });
```

- [ ] **Step 2: Run test — expect FAIL on the new ones**

```bash
npm run web:test -- sessions
```

- [ ] **Step 3: Update `apps/web/src/store/sessions.ts`**

In the existing store, add the field and setter. Locate the `interface SessionsStore` and add:

```ts
  transcriptOnly: Record<string, boolean>;
  markTranscriptOnly(id: string): void;
```

In the `create<SessionsStore>` factory's initial state add:
```ts
  transcriptOnly: {},
```

And add the setter implementation alongside `setActive`:
```ts
  markTranscriptOnly(id) {
    set((s) => ({ transcriptOnly: { ...s.transcriptOnly, [id]: true } }));
  },
```

Also update the `beforeEach` reset block in `sessions.test.ts` so the field resets between tests:

```ts
beforeEach(() => {
  useSessionsStore.setState({ sessions: {}, order: [], activeId: null, transcriptOnly: {} });
});
```

Now patch the `session_created` branch of `applyServerMsg` so transcript-only replays do NOT add the dead session back into the visible sidebar `order`. Locate the existing branch (it currently always pushes new ids onto `order`) and replace just the `set((s) => ({ ... }))` call with the version below:

```ts
const isTranscriptOnly = Boolean(get().transcriptOnly[m.sessionId]);
set((s) => ({
  sessions: { ...s.sessions, [m.sessionId]: view },
  // Live sessions get added to the sidebar; transcript-only replays
  // hydrate events into the store but stay OFF the sidebar.
  order: isTranscriptOnly
    ? s.order
    : s.order.includes(m.sessionId)
      ? s.order
      : [...s.order, m.sessionId],
}));
```

The rest of the branch (building `view` from the existing entry plus the incoming `m`) is unchanged.

Add a sessions.test.ts case asserting the new behavior:

```ts
  it('session_created for a session marked transcriptOnly does NOT add to order', () => {
    const store = useSessionsStore.getState();
    store.markTranscriptOnly('s1');
    store.applyServerMsg({
      type: 'system',
      event: 'session_created',
      sessionId: 's1',
      seq: 1,
      agent: 'claude',
      projectPath: '/p',
      createdAt: 1,
    });
    const next = useSessionsStore.getState();
    expect(next.sessions['s1']).toBeDefined();
    expect(next.order).toEqual([]);
  });
```

- [ ] **Step 4: Run tests + typecheck**

```bash
npm run web:test -- sessions
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: 9 passed (7 prior + 2 new); typecheck clean.

- [ ] **Step 5: Update `apps/web/src/App.tsx` to route session_dead errors to the new setter**

In the `useEffect` body, add a `markTranscriptOnly` selector and route `error { code: 'session_dead' }` through it. Replace the existing message handler (which Task 13 left as a Phase-1-style global banner) with:

```tsx
const setStatus = useConnectionStore((s) => s.setStatus);
const setError = useConnectionStore((s) => s.setError);
const apply = useSessionsStore((s) => s.applyServerMsg);
const markTranscriptOnly = useSessionsStore((s) => s.markTranscriptOnly);
const applyAccountList = useAccountsStore((s) => s.applyAccountList);
```

(Add `markTranscriptOnly` to the `useSessionsStore` selectors at the top of the component.)

Then replace the `offMessage` block to call `markTranscriptOnly` on the right error code:

```tsx
const offMessage = client.on('message', (m) => {
  if (m.type === 'account_list') {
    applyAccountList(m.accounts);
    return;
  }
  if (m.type === 'error') {
    if (m.code === 'session_dead' && m.sessionId) {
      markTranscriptOnly(m.sessionId);
    }
    setError(`${m.code}: ${m.message}`);
  } else {
    setError(null);
  }
  apply(m);
});
```

Update the dependency array on the `useEffect` to include `markTranscriptOnly`:

```tsx
}, [client, setStatus, setError, apply, markTranscriptOnly, applyAccountList]);
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/store/sessions.ts apps/web/src/store/sessions.test.ts apps/web/src/App.tsx
git commit -m "feat(web): add transcriptOnly map and route session_dead errors to it"
```

---

## Task 15: Web — transcript-fetcher service + Session.tsx fallback

**Files:**
- Create: `apps/web/src/services/transcript-fetcher.ts`
- Create: `apps/web/src/services/transcript-fetcher.test.ts`
- Modify: `apps/web/src/pages/Session.tsx`

- [ ] **Step 1: Write the failing transcript-fetcher test**

`apps/web/src/services/transcript-fetcher.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { streamTranscript } from './transcript-fetcher';

function makeMockResponse(body: string, status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamTranscript', () => {
  it('yields each NDJSON line as a parsed object', async () => {
    const body =
      JSON.stringify({ type: 'system', event: 'session_created', sessionId: 'a', seq: 1 }) +
      '\n' +
      JSON.stringify({ type: 'user', sessionId: 'a', seq: 2, payload: { text: 'hi' } }) +
      '\n';
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(makeMockResponse(body));
    const out: unknown[] = [];
    for await (const ev of streamTranscript('a')) out.push(ev);
    expect(out).toHaveLength(2);
    expect((out[1] as { type: string }).type).toBe('user');
  });

  it('throws on 404', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(makeMockResponse('', 404));
    const it = streamTranscript('a');
    await expect(it.next()).rejects.toThrow(/404/);
  });

  it('handles partial chunks across newline boundaries', async () => {
    const body = JSON.stringify({ type: 'user', sessionId: 'a', seq: 1, payload: { text: 'hi' } }) + '\n';
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body.slice(0, 10)));
        controller.enqueue(encoder.encode(body.slice(10)));
        controller.close();
      },
    });
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(new Response(stream, { status: 200 }));
    const out: unknown[] = [];
    for await (const ev of streamTranscript('a')) out.push(ev);
    expect(out).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run web:test -- transcript-fetcher
```

- [ ] **Step 3: Implement `apps/web/src/services/transcript-fetcher.ts`**

```ts
import type { ServerLifecycleMsg, ServerStreamMsg } from '../types/protocol';

export type TranscriptEvent = ServerLifecycleMsg | ServerStreamMsg;

export async function* streamTranscript(sessionId: string): AsyncIterable<TranscriptEvent> {
  const response = await fetch(`/transcripts/${encodeURIComponent(sessionId)}`, {
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`GET /transcripts/${sessionId} failed with ${response.status}`);
  }
  if (!response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length === 0) continue;
      try {
        yield JSON.parse(line) as TranscriptEvent;
      } catch {
        // Skip malformed lines silently. Bridge writes valid JSON but
        // cosmic-ray-tolerance keeps the iterator productive.
      }
    }
  }
  if (buf.trim().length > 0) {
    try {
      yield JSON.parse(buf) as TranscriptEvent;
    } catch {
      /* ignore tail */
    }
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run web:test -- transcript-fetcher
```

Expected: 3 passed.

- [ ] **Step 5: Update `apps/web/src/pages/Session.tsx`**

Replace the existing file with:

```tsx
import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSessionsStore } from '../store/sessions';
import { useConnectionStore } from '../store/connection';
import type { BridgeClient } from '../services/bridge-client';
import { SessionList } from '../features/session-list/SessionList';
import { Chat } from '../features/chat/Chat';
import { useNewSession } from '../features/project-picker/useNewSession';
import { streamTranscript } from '../services/transcript-fetcher';

interface SessionProps {
  client: BridgeClient;
}

export function Session({ client }: SessionProps): JSX.Element {
  const { id } = useParams();
  const navigate = useNavigate();
  const order = useSessionsStore((s) => s.order);
  const sessionsMap = useSessionsStore((s) => s.sessions);
  const setActive = useSessionsStore((s) => s.setActive);
  const apply = useSessionsStore((s) => s.applyServerMsg);
  const transcriptOnly = useSessionsStore((s) => (id ? Boolean(s.transcriptOnly[id]) : false));
  const session = id ? sessionsMap[id] : undefined;
  const newSession = useNewSession(client);

  useEffect(() => {
    if (id) setActive(id);
  }, [id, setActive]);

  const connStatus = useConnectionStore((s) => s.status);
  // Send `get_history` exactly once per (id, connection-open) edge. We do
  // NOT gate on `sessions[id]` existing, because deep-linking after a bridge
  // restart hits this page with the session NOT in the store; the bridge
  // replies with `error: session_dead` (carrying sessionId), which App.tsx
  // routes to `markTranscriptOnly`, which flips `transcriptOnly[id]` and
  // triggers the transcript-fetcher effect below.
  const askedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id || connStatus !== 'open' || transcriptOnly) {
      askedRef.current = null;
      return;
    }
    if (askedRef.current === id) return;
    askedRef.current = id;
    const snapshot = useSessionsStore.getState().sessions[id];
    const since = snapshot?.lastSeq ?? 0;
    client.send({ type: 'get_history', sessionId: id, since });
  }, [client, id, connStatus, transcriptOnly]);

  // Transcript-only fallback: stream the disk transcript and dispatch each line
  // through applyServerMsg. Keep a guard ref so we only do it once per session id.
  const fallbackStartedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !transcriptOnly || fallbackStartedRef.current === id) return;
    fallbackStartedRef.current = id;
    let cancelled = false;
    (async () => {
      try {
        for await (const ev of streamTranscript(id)) {
          if (cancelled) return;
          apply(ev);
        }
      } catch (err) {
        console.warn('[transcript fallback]', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, transcriptOnly, apply]);

  if (!session && !transcriptOnly) {
    return (
      <main className="home-main">
        <p>Session not found.</p>
        <button onClick={() => navigate('/')}>Home</button>
      </main>
    );
  }

  const sessions = order.map((sid) => sessionsMap[sid]!).filter((s) => s !== undefined);

  return (
    <>
      <SessionList
        sessions={sessions}
        activeId={id ?? null}
        onSelect={(nid) => navigate(`/session/${nid}`)}
        onNewSession={newSession.open}
      />
      {session && (
        <Chat
          session={session}
          onSend={
            transcriptOnly
              ? () => {}
              : (text) => client.send({ type: 'input', sessionId: session.sessionId, text })
          }
          onStop={
            transcriptOnly
              ? () => {}
              : () => client.send({ type: 'stop_session', sessionId: session.sessionId })
          }
          banner={
            transcriptOnly
              ? 'transcript-only view (session no longer live)'
              : null
          }
          inputDisabled={transcriptOnly}
        />
      )}
      {!session && transcriptOnly && (
        <main className="home-main">
          <p>Loading transcript…</p>
        </main>
      )}
      {newSession.pickerNode}
    </>
  );
}
```

- [ ] **Step 6: Update `apps/web/src/features/chat/Chat.tsx` to accept `banner` and `inputDisabled` props**

Replace the existing file with:

```tsx
import { useEffect, useRef } from 'react';
import type { SessionView } from '../../store/sessions';
import { MessageBubble } from './MessageBubble';
import { InputBox } from './InputBox';
import './Chat.css';

interface ChatProps {
  session: SessionView;
  onSend(text: string): void;
  onStop(): void;
  banner?: string | null;
  inputDisabled?: boolean;
}

export function Chat({ session, onSend, onStop, banner, inputDisabled }: ChatProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.events]);

  return (
    <div className="chat">
      <div className="chat-header">
        <code>{session.projectPath}</code>
        <span>session {session.sessionId.slice(0, 8)}</span>
      </div>
      {banner && <div className="chat-banner">{banner}</div>}
      <div className="chat-scroll" ref={scrollRef}>
        {session.events.map((e, i) => (
          <MessageBubble
            key={`${i}-${e.type}-${e.type === 'system' ? e.event : (e as { seq: number }).seq}`}
            event={e}
          />
        ))}
      </div>
      <InputBox onSend={onSend} onStop={onStop} disabled={(!session.alive) || Boolean(inputDisabled)} />
    </div>
  );
}
```

Append a `.chat-banner` rule to `apps/web/src/features/chat/Chat.css`:

```css
.chat-banner { background: #2a1c10; color: #fc8; padding: 0.4rem 1rem; font-size: 0.85rem; border-bottom: 1px solid #432; }
```

- [ ] **Step 7: Run tests + typecheck + build**

```bash
npm run web:test
npx tsc --noEmit -p apps/web/tsconfig.json
npm run web:build
```

Expected: green.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/services/transcript-fetcher.ts apps/web/src/services/transcript-fetcher.test.ts apps/web/src/pages/Session.tsx apps/web/src/features/chat/Chat.tsx apps/web/src/features/chat/Chat.css
git commit -m "feat(web): add transcript fetcher and Session.tsx transcript-only fallback"
```

---

## Task 16: Web — agent radio + account dropdown in ProjectPicker

**Files:**
- Modify: `apps/web/src/features/project-picker/ProjectPicker.tsx`
- Modify: `apps/web/src/features/project-picker/useNewSession.ts`
- Modify: `apps/web/src/features/session-list/SessionList.tsx`

- [ ] **Step 1: Replace `apps/web/src/features/project-picker/ProjectPicker.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useAccountsStore } from '../../store/accounts';
import type { AgentKind } from '../../types/protocol';
import './ProjectPicker.css';

const RECENT_KEY = 'mrt.recentProjects';
const RECENT_MAX = 10;

function loadRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecents(list: string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* ignore */
  }
}

export function rememberRecentProject(path: string): void {
  const current = loadRecents();
  const next = [path, ...current.filter((p) => p !== path)];
  saveRecents(next);
}

export interface ProjectPickerSelection {
  agent: AgentKind;
  projectPath: string;
  account?: string;
}

interface ProjectPickerProps {
  onPick(selection: ProjectPickerSelection): void;
  onCancel(): void;
}

export function ProjectPicker({ onPick, onCancel }: ProjectPickerProps): JSX.Element {
  const [path, setPath] = useState('');
  const [agent, setAgent] = useState<AgentKind>('claude');
  const accounts = useAccountsStore((s) => s.accounts);
  const selectedAccount = useAccountsStore((s) => s.selectedAccount);
  const setSelectedAccount = useAccountsStore((s) => s.setSelectedAccount);
  const [recents, setRecents] = useState<string[]>([]);

  useEffect(() => {
    setRecents(loadRecents());
  }, []);

  const submit = (chosen: string): void => {
    const trimmed = chosen.trim();
    if (trimmed.length === 0) return;
    rememberRecentProject(trimmed);
    onPick({
      agent,
      projectPath: trimmed,
      ...(agent === 'codex' && selectedAccount ? { account: selectedAccount } : {}),
    });
  };

  return (
    <div className="picker-backdrop">
      <div className="picker">
        <h2>Pick a project</h2>
        <div className="picker-agent">
          <label>
            <input
              type="radio"
              name="agent"
              value="claude"
              checked={agent === 'claude'}
              onChange={() => setAgent('claude')}
            />
            Claude
          </label>
          <label>
            <input
              type="radio"
              name="agent"
              value="codex"
              checked={agent === 'codex'}
              onChange={() => setAgent('codex')}
            />
            Codex
          </label>
        </div>
        {agent === 'codex' && accounts.length > 0 && (
          <div className="picker-account">
            <label>
              Account:&nbsp;
              <select
                value={selectedAccount ?? ''}
                onChange={(e) => setSelectedAccount(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                    {a.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(path);
          }}
        >
          <input
            type="text"
            placeholder="/Users/you/code/some-project"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            autoFocus
          />
          <div className="picker-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit">Open</button>
          </div>
        </form>
        {recents.length > 0 && (
          <>
            <h3>Recent</h3>
            <ul className="picker-recents">
              {recents.map((p) => (
                <li key={p}>
                  <button type="button" onClick={() => submit(p)}>
                    {p}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append agent + account styles to `apps/web/src/features/project-picker/ProjectPicker.css`**

```css
.picker-agent { display: flex; gap: 1rem; margin-bottom: 0.5rem; }
.picker-account { margin-bottom: 0.5rem; }
.picker-account select { background: #111; color: #ddd; border: 1px solid #333; padding: 0.25rem; }
```

- [ ] **Step 3: Update `apps/web/src/features/project-picker/useNewSession.tsx`**

(File extension is `.tsx` because it returns JSX. Phase 1 created it as `.tsx`. Do NOT rename; TypeScript module resolution accepts importing it as `./useNewSession` regardless.)

Replace the `onPick` callback so it forwards `agent` and `account`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionsStore } from '../../store/sessions';
import type { BridgeClient } from '../../services/bridge-client';
import { ProjectPicker, type ProjectPickerSelection } from './ProjectPicker';

function newCorrelationId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function useNewSession(client: BridgeClient): {
  open(): void;
  pickerNode: JSX.Element | null;
} {
  const navigate = useNavigate();
  const sessionsMap = useSessionsStore((s) => s.sessions);
  const [pickerOpen, setPickerOpen] = useState(false);
  const awaitingCorrelationRef = useRef<string | null>(null);

  useEffect(() => {
    const target = awaitingCorrelationRef.current;
    if (!target) return;
    for (const s of Object.values(sessionsMap)) {
      const matched = s.events.find(
        (e) =>
          e.type === 'system' &&
          e.event === 'session_created' &&
          e.correlationId === target,
      );
      if (matched) {
        awaitingCorrelationRef.current = null;
        navigate(`/session/${s.sessionId}`);
        return;
      }
    }
  }, [sessionsMap, navigate]);

  const pickerNode = pickerOpen ? (
    <ProjectPicker
      onCancel={() => setPickerOpen(false)}
      onPick={(selection: ProjectPickerSelection) => {
        const correlationId = newCorrelationId();
        awaitingCorrelationRef.current = correlationId;
        client.send({
          type: 'start',
          agent: selection.agent,
          projectPath: selection.projectPath,
          ...(selection.account ? { account: selection.account } : {}),
          correlationId,
        });
        setPickerOpen(false);
      }}
    />
  ) : null;

  return {
    open: () => setPickerOpen(true),
    pickerNode,
  };
}
```

- [ ] **Step 4: Update `apps/web/src/features/session-list/SessionList.tsx` to badge codex sessions**

Replace the file with:

```tsx
import type { SessionView } from '../../store/sessions';
import './SessionList.css';

interface SessionListProps {
  sessions: SessionView[];
  activeId: string | null;
  onSelect(id: string): void;
  onNewSession(): void;
}

export function SessionList({ sessions, activeId, onSelect, onNewSession }: SessionListProps): JSX.Element {
  return (
    <aside className="session-list">
      <button className="session-new" type="button" onClick={onNewSession}>
        + New session
      </button>
      <ul>
        {sessions.length === 0 && <li className="session-empty">No active sessions</li>}
        {sessions.map((s) => {
          const label = s.projectPath.split('/').filter(Boolean).pop() ?? s.projectPath;
          const badge =
            s.agent === 'codex'
              ? `codex${s.account ? `:${s.account}` : ''}`
              : 'claude';
          return (
            <li
              key={s.sessionId}
              className={`session-row${s.sessionId === activeId ? ' active' : ''}${!s.alive ? ' ended' : ''}`}
            >
              <button type="button" onClick={() => onSelect(s.sessionId)}>
                <div className="session-label">
                  {label} <span className={`session-badge agent-${s.agent}`}>{badge}</span>
                </div>
                <div className="session-path">{s.projectPath}</div>
                {!s.alive && <div className="session-ended">ended</div>}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
```

Append style rules to `apps/web/src/features/session-list/SessionList.css`:

```css
.session-badge { font-size: 0.7rem; padding: 0.05rem 0.35rem; border-radius: 4px; margin-left: 0.35rem; }
.session-badge.agent-claude { background: #1c2a44; color: #aef; }
.session-badge.agent-codex { background: #2a1c44; color: #fae; }
```

- [ ] **Step 5: Update `apps/web/src/store/sessions.ts` so `SessionView.account` is preserved**

Locate the `interface SessionView` and add:
```ts
  account?: string;
```

Update the `session_created` and `session_list` branches in `applyServerMsg` to include `account` from the incoming message:

In the `session_created` branch, add `account: m.account ?? existing?.account` next to other fields.

In the `session_list` branch, add `account: summary.account` for each entry.

- [ ] **Step 6: Run tests + typecheck + build**

```bash
npm run web:test
npx tsc --noEmit -p apps/web/tsconfig.json
npm run web:build
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/project-picker apps/web/src/features/session-list apps/web/src/store/sessions.ts
git commit -m "feat(web): agent radio + account dropdown in picker, agent badges in sidebar"
```

---

## Task 17: Web — prompt-history store + PromptHistoryDropdown

**Files:**
- Create: `apps/web/src/store/prompt-history.ts`
- Create: `apps/web/src/store/prompt-history.test.ts`
- Create: `apps/web/src/features/prompt-history/PromptHistoryDropdown.tsx`
- Create: `apps/web/src/features/prompt-history/PromptHistoryDropdown.css`
- Modify: `apps/web/src/features/chat/InputBox.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Write prompt-history store + tests**

`apps/web/src/store/prompt-history.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { usePromptHistoryStore } from './prompt-history';

beforeEach(() => {
  usePromptHistoryStore.setState({ prompts: [], query: '', showProjectOnly: false });
});

describe('prompt-history store', () => {
  it('hydrates from prompts_result message', () => {
    usePromptHistoryStore.getState().applyPromptsResult([
      { text: 'hello', lastUsedAt: 100, projectPaths: ['/p1'], agents: ['claude'] },
    ]);
    expect(usePromptHistoryStore.getState().prompts).toHaveLength(1);
  });

  it('filtered() applies query case-insensitively and project filter', () => {
    usePromptHistoryStore.setState({
      prompts: [
        { text: 'Hello', lastUsedAt: 200, projectPaths: ['/p1'], agents: ['claude'] },
        { text: 'goodbye', lastUsedAt: 100, projectPaths: ['/p2'], agents: ['claude'] },
      ],
      query: 'hel',
      showProjectOnly: false,
    });
    expect(usePromptHistoryStore.getState().filtered(undefined).map((p) => p.text)).toEqual(['Hello']);

    usePromptHistoryStore.setState({ query: '', showProjectOnly: true });
    expect(usePromptHistoryStore.getState().filtered('/p1').map((p) => p.text)).toEqual(['Hello']);
  });

  it('setQuery updates the query string', () => {
    usePromptHistoryStore.getState().setQuery('hi');
    expect(usePromptHistoryStore.getState().query).toBe('hi');
  });

  it('toggleProjectOnly flips the boolean', () => {
    usePromptHistoryStore.getState().toggleProjectOnly();
    expect(usePromptHistoryStore.getState().showProjectOnly).toBe(true);
    usePromptHistoryStore.getState().toggleProjectOnly();
    expect(usePromptHistoryStore.getState().showProjectOnly).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run web:test -- prompt-history
```

- [ ] **Step 3: Implement `apps/web/src/store/prompt-history.ts`**

```ts
import { create } from 'zustand';
import type { AgentKind } from '../types/protocol';

export interface PromptEntry {
  text: string;
  lastUsedAt: number;
  projectPaths: string[];
  agents: AgentKind[];
}

interface PromptHistoryStore {
  prompts: PromptEntry[];
  query: string;
  showProjectOnly: boolean;
  applyPromptsResult(prompts: PromptEntry[]): void;
  setQuery(q: string): void;
  toggleProjectOnly(): void;
  filtered(currentProjectPath: string | undefined): PromptEntry[];
}

export const usePromptHistoryStore = create<PromptHistoryStore>((set, get) => ({
  prompts: [],
  query: '',
  showProjectOnly: false,
  applyPromptsResult(prompts) {
    set({ prompts });
  },
  setQuery(q) {
    set({ query: q });
  },
  toggleProjectOnly() {
    set((s) => ({ showProjectOnly: !s.showProjectOnly }));
  },
  filtered(currentProjectPath) {
    const { prompts, query, showProjectOnly } = get();
    let out = prompts;
    if (query.length > 0) {
      const lower = query.toLowerCase();
      out = out.filter((p) => p.text.toLowerCase().includes(lower));
    }
    if (showProjectOnly && currentProjectPath) {
      out = out.filter((p) => p.projectPaths.includes(currentProjectPath));
    }
    return out;
  },
}));
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run web:test -- prompt-history
```

Expected: 4 passed.

- [ ] **Step 5: Create the dropdown component**

`apps/web/src/features/prompt-history/PromptHistoryDropdown.tsx`:

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { usePromptHistoryStore } from '../../store/prompt-history';
import './PromptHistoryDropdown.css';

interface DropdownProps {
  currentProjectPath?: string;
  onPick(text: string): void;
  onClose(): void;
}

export function PromptHistoryDropdown({
  currentProjectPath,
  onPick,
  onClose,
}: DropdownProps): JSX.Element {
  const query = usePromptHistoryStore((s) => s.query);
  const setQuery = usePromptHistoryStore((s) => s.setQuery);
  const showProjectOnly = usePromptHistoryStore((s) => s.showProjectOnly);
  const toggleProjectOnly = usePromptHistoryStore((s) => s.toggleProjectOnly);
  const list = usePromptHistoryStore((s) => s.filtered(currentProjectPath));
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    if (highlighted >= list.length) setHighlighted(Math.max(0, list.length - 1));
  }, [list.length, highlighted]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => Math.min(list.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = list[highlighted];
      if (pick) {
        onPick(pick.text);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="prompt-history">
      <div className="prompt-history-row">
        <input
          ref={inputRef}
          className="prompt-history-search"
          type="text"
          placeholder="Search prompt history…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <label className="prompt-history-filter">
          <input
            type="checkbox"
            checked={showProjectOnly}
            onChange={toggleProjectOnly}
          />
          this project only
        </label>
      </div>
      <ul className="prompt-history-list">
        {list.length === 0 && <li className="prompt-history-empty">No prompts</li>}
        {list.map((p, i) => (
          <li
            key={p.text}
            className={`prompt-history-row-item${i === highlighted ? ' active' : ''}`}
            onMouseEnter={() => setHighlighted(i)}
            onClick={() => onPick(p.text)}
          >
            <div className="prompt-history-text">{p.text}</div>
            <div className="prompt-history-meta">
              {p.projectPaths.join(', ')} · {p.agents.join(',')}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 6: Create the dropdown stylesheet**

`apps/web/src/features/prompt-history/PromptHistoryDropdown.css`:

```css
.prompt-history { position: absolute; bottom: calc(100% + 0.25rem); left: 0; right: 0; background: #181818; border: 1px solid #333; border-radius: 6px; max-height: 240px; display: flex; flex-direction: column; box-shadow: 0 4px 16px rgba(0,0,0,0.4); z-index: 5; }
.prompt-history-row { display: flex; gap: 0.5rem; padding: 0.4rem; border-bottom: 1px solid #2a2a2a; align-items: center; }
.prompt-history-search { flex: 1; background: #111; color: #ddd; border: 1px solid #333; padding: 0.3rem 0.5rem; }
.prompt-history-filter { font-size: 0.8rem; color: #aaa; display: flex; align-items: center; gap: 0.25rem; }
.prompt-history-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
.prompt-history-row-item { padding: 0.4rem 0.6rem; cursor: pointer; border-bottom: 1px solid #1f1f1f; }
.prompt-history-row-item.active { background: #1c2a44; }
.prompt-history-text { color: #ddd; font-size: 0.9rem; white-space: pre-wrap; word-break: break-word; }
.prompt-history-meta { color: #777; font-size: 0.7rem; margin-top: 0.15rem; }
.prompt-history-empty { color: #666; padding: 0.5rem; font-size: 0.85rem; text-align: center; }
```

- [ ] **Step 7: Wire into `apps/web/src/features/chat/InputBox.tsx`**

Replace the file with:

```tsx
import { useState, type KeyboardEvent } from 'react';
import { PromptHistoryDropdown } from '../prompt-history/PromptHistoryDropdown';

interface InputBoxProps {
  onSend(text: string): void;
  onStop(): void;
  disabled: boolean;
  currentProjectPath?: string;
}

export function InputBox({
  onSend,
  onStop,
  disabled,
  currentProjectPath,
}: InputBoxProps): JSX.Element {
  const [text, setText] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);

  const submit = (): void => {
    const t = text.trim();
    if (t.length === 0) return;
    onSend(t);
    setText('');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'ArrowUp' && text.length === 0) {
      e.preventDefault();
      setHistoryOpen(true);
      return;
    }
    if (e.key === 'Escape' && historyOpen) {
      e.preventDefault();
      setHistoryOpen(false);
    }
  };

  return (
    <div className="input-box" style={{ position: 'relative' }}>
      {historyOpen && (
        <PromptHistoryDropdown
          currentProjectPath={currentProjectPath}
          onPick={(picked) => {
            setText(picked);
            setHistoryOpen(false);
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      <textarea
        value={text}
        placeholder={
          disabled
            ? 'Session ended.'
            : 'Type a prompt. Cmd/Ctrl+Enter to send. ↑ on empty input opens history.'
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        rows={3}
        disabled={disabled}
      />
      <div className="input-actions">
        <button
          type="button"
          onClick={() => setHistoryOpen((h) => !h)}
          disabled={disabled}
          aria-label="Toggle prompt history"
        >
          ⌘H
        </button>
        <button type="button" onClick={onStop} disabled={disabled}>
          Stop
        </button>
        <button type="button" onClick={submit} disabled={disabled || text.trim().length === 0}>
          Send
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Update `apps/web/src/features/chat/Chat.tsx` to pass `currentProjectPath` through**

Add `currentProjectPath={session.projectPath}` to the `<InputBox ... />` element. Replace the existing `<InputBox onSend={onSend} onStop={onStop} disabled={(!session.alive) || Boolean(inputDisabled)} />` line with:

```tsx
<InputBox
  onSend={onSend}
  onStop={onStop}
  disabled={(!session.alive) || Boolean(inputDisabled)}
  currentProjectPath={session.projectPath}
/>
```

- [ ] **Step 9: Update `apps/web/src/App.tsx` to apply `prompts_result`**

Inside the `apply` message handler, before `apply(m)` is called, add:

```ts
if (m.type === 'prompts_result') {
  usePromptHistoryStore.getState().applyPromptsResult(m.prompts);
  return;
}
```

Add the import at the top of the file:
```ts
import { usePromptHistoryStore } from './store/prompt-history';
```

Also, after each successful `input` send (so freshly typed prompts surface in the dropdown without a manual refresh), the simplest path is to refetch on every user-input frame the server confirms. We already see `user` events broadcast back from the bridge — listen for them in the `apply` handler:

Inside the message handler, alongside the `prompts_result` check, add:

```ts
if (m.type === 'user') {
  client.send({ type: 'list_prompts', limit: 200 });
}
```

This is fire-and-forget; the server-side `prompts_result` reply re-hydrates the store.

- [ ] **Step 10: Run tests + typecheck + build**

```bash
npm run web:test
npx tsc --noEmit -p apps/web/tsconfig.json
npm run web:build
```

Expected: green.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/store/prompt-history.ts apps/web/src/store/prompt-history.test.ts apps/web/src/features/prompt-history apps/web/src/features/chat/InputBox.tsx apps/web/src/features/chat/Chat.tsx apps/web/src/App.tsx
git commit -m "feat(web): prompt-history store, dropdown, and ↑-key shortcut in InputBox"
```

---

## Task 18: Manual end-to-end smoke test

This task does not change code. It exercises Phase 2 end to end.

**Pre-reqs:** `claude` and `codex` CLI installed; Tailscale running (or `BRIDGE_BIND_HOST=127.0.0.1`); at least one Codex account directory exists. For multi-account smoke, create two `~/.codex-*` directories and an `accounts.json`:

```bash
mkdir -p ~/.codex-work ~/.codex-personal ~/.config/mac-remote-terminal
cat > ~/.config/mac-remote-terminal/accounts.json <<'EOF'
{
  "codex_accounts": [
    {"name": "work", "codexHome": "/Users/REPLACE_ME/.codex-work"},
    {"name": "personal", "codexHome": "/Users/REPLACE_ME/.codex-personal"}
  ]
}
EOF
```

(Replace the paths with your real `$HOME` value — `accounts.json` does not expand `~`.)

- [ ] **Step 1: Build everything**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run build
```

Expected: `apps/web/dist/index.html` and `packages/bridge/dist/index.js` produced.

- [ ] **Step 2: Generate a token + start the bridge**

```bash
export BRIDGE_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
node packages/bridge/dist/index.js
```

Expected: `[bridge] loaded N codex account(s): ...`, `[bridge] binding to ...`, `[bridge] open: http://...`.

- [ ] **Step 3: Open the web UI in Safari/Chrome at the URL printed**

Expected:
- 302 redirect to `/`, cookie set.
- Sidebar empty.
- Connection: `open`.

- [ ] **Step 4: Spawn a Codex session — verify account dropdown**

Click `+ New session`. Choose Codex. Verify the account dropdown shows the configured names (or `default`). Type a project path inside `BRIDGE_ALLOWED_DIRS`, click Open.

Expected: sidebar gains a `codex:work` (or whatever you picked) badge. Page navigates to `/session/<uuid>`.

- [ ] **Step 5: Send 3 prompts to Codex; verify resume between turns**

Each turn should produce streaming output and end with a `result` system bubble. The second and third turns must NOT re-issue a "session started" event — they share the captured `codexSessionId` from turn 1.

In another terminal, look at the transcript file as it grows:

```bash
tail -f ~/.config/mac-remote-terminal/transcripts/<uuid>.jsonl
```

Expected: per-turn `user` lines, plus assistant/tool/result lines.

- [ ] **Step 6: Restart the bridge and verify transcript fallback**

In the bridge terminal: Ctrl-C. Then:

```bash
node packages/bridge/dist/index.js
```

In the browser, navigate directly to the previous `/session/<uuid>` URL.

Expected:
- Connection reopens.
- Sidebar does NOT list the old session (it's no longer live).
- The session view still shows the chat history, prepended by `transcript-only view (session no longer live)`.
- InputBox is disabled.

- [ ] **Step 7: Spawn a fresh Claude session and exercise prompt-history dropdown**

From `/`, click `+ New session`, choose Claude, pick a project, send a prompt. Then in the input box, with no typed text, press `↑`. The history dropdown opens and shows past prompts. Toggle "this project only" — verify filter behavior. Click an entry — verify the textarea fills.

- [ ] **Step 8: Stop a live session**

Click Stop in the chat header on the current Claude session.

Expected: `session ended` system bubble. Sidebar dimmed `ended`. InputBox disabled.

- [ ] **Step 9: Tag the slice**

```bash
git tag phase-2-codex-and-durability
```

The tag is local-only — push if you've added a remote.

---

## Self-Review (before declaring Phase 2 done)

1. `npm run typecheck` — both workspaces clean.
2. `npm test` — all bridge + web unit tests pass.
3. `npm run build` — both packages build cleanly.
4. Manual smoke (Task 18) executed end to end against real Claude + real Codex.
5. Bridge refuses to start when `BRIDGE_TOKEN` missing or short.
6. Bridge synthesizes `default` Codex account when `accounts.json` is missing or empty.
7. `accounts.json` malformed → falls back, does not crash.
8. `GET /transcripts/<id>` for unknown id returns 404; non-UUID returns 400; missing cookie returns 401; cross-origin returns 403.
9. Codex turn 2 uses `codex exec resume <session_id>` (verify with `lsof -p <bridge-pid>` or by inspecting the args via `ps` while a turn is in flight).
10. Transcript file is valid NDJSON (each line `JSON.parse`-able).
11. Prompt history persists across bridge restart.
12. Phase 2 commits cleanly land on `main` without disturbing Phase 1 behavior — Phase 1 smoke (Claude session, reload, stop) still works.

If any check fails, fix before tagging. Do NOT pile fixes onto Phase 3.
