# Phase 2 — Codex Agent + Durability — Design

**Date:** 2026-05-07
**Status:** Drafted (pre codex review)
**Builds on:** Phase 1 (`docs/superpowers/specs/2026-05-07-web-claude-codex-spawner-design.md`, plan `docs/superpowers/plans/2026-05-07-phase-1-vertical-slice.md`)

## 1. Goals

Add Codex agent support and an on-disk durability layer to the existing Phase 1 vertical slice. Specifically:

- A second agent kind, `codex`, alongside Phase 1's `claude`. Yolo-equivalent (`--dangerously-bypass-approvals-and-sandbox`). Multi-turn via `codex exec resume <session_id>` per turn.
- Multiple Codex accounts, declared in a JSON config file under `BRIDGE_DATA_DIR`. Each account is a `CODEX_HOME` directory that the bridge sets at spawn time. UI shows an account dropdown when starting a Codex session.
- On-disk transcript JSONL per session, retained for `BRIDGE_TRANSCRIPT_RETENTION_DAYS` (default 30). One-shot prune at boot.
- `GET /transcripts/<sessionId>` HTTP endpoint, cookie-authed, streams the raw NDJSON file as `application/x-ndjson`.
- Prompt history persistence: `prompts.json` under `BRIDGE_DATA_DIR`, deduped by sha256, capped at last 500. UI dropdown above `InputBox` with project-filter toggle.
- Web: agent selector + account dropdown in `ProjectPicker`; transcript-only fallback view in `Session.tsx` when the live session is gone but a disk transcript exists.

## 2. Non-Goals

- Image attachments (Phase 3+).
- File explorer / `list_dirs` / `read_tree` / `read_file` API (Phase 4).
- Markdown rendering (cut from spec entirely).
- Playwright E2E (Phase 5).
- HTTPS termination (covered by Tailscale).
- Background prune timer — pruning is a one-shot scan at bridge boot.
- Multi-account claude — Phase 2 only addresses Codex accounts.

## 3. Architecture Diff vs. Phase 1

```
                                    ┌─ list_accounts ←──────────────┐
                                    ▼                              │
┌──────────────┐ ws (cookie+Origin) ┌──────────────────────┐       │
│ Browser      │ ───────────────────▶│ Bridge (Node + TS)   │ ──────┘
│ React SPA    │ ◀───── account_list │ packages/bridge      │
└──────────────┘                     └──┬───────────────────┘
       ▲                                │ spawn (CODEX_HOME=<account>)
       │ GET /transcripts/<id>          │
       │ (cookie-only, NDJSON)          ├──▶ claude (long-lived per session)
       │                                └──▶ codex exec (per-turn, resume by id)
       │                                       │ stdout JSONL
       │                                       ▼
       │                                  unified AgentEvent
       │                                       │
       │      ┌────────────────────────────────┴──────────────────────┐
       │      │ ring buffer (in-memory)  →  ws fan-out to subscribers │
       │      │ transcript-store         →  ${DATA}/transcripts/<id>.jsonl
       │      │ prompt-store (user input only) → ${DATA}/prompts.json │
       │      └───────────────────────────────────────────────────────┘
       │
       └──── transcript fallback when SessionManager has no live session
```

The Phase 1 plumbing for Claude (long-lived `claude -p` process with stdin NDJSON) is unchanged. Codex is a parallel driver with a different lifecycle. `SessionManager` selects driver by `agent` field. Both drivers expose the same `event` / `exit` EventEmitter interface.

## 4. WebSocket Protocol Diff

### Client → Server

**New:**

| Type | Fields | Purpose |
|---|---|---|
| `list_accounts` | `correlationId?` | Fetch configured Codex accounts. |

**Changed:**

| Type | Diff |
|---|---|
| `start` | Adds `account?: string`. Required when `agent === 'codex'`. Ignored for `claude`. Bridge synthesizes `default` if account missing for codex AND only one account is configured. |

### Server → Client

**New:**

| Type | Fields | Purpose |
|---|---|---|
| `account_list` | `accounts: Array<{ name: string; agent: 'codex'; isDefault: boolean }>`, `correlationId?` | Reply to `list_accounts`. `codexHome` paths NOT exposed. |

**Changed:**

| Type | Diff |
|---|---|
| `system { event: 'session_created' }` | Adds `account?: string` (only on codex sessions). |
| `session_list[]` | Each entry adds `account?: string`. |
| `error.code` | Adds `unknown_account`, `no_codex_accounts_configured`, `codex_session_id_missing`. |
| `error` shape | Adds optional `sessionId?: string`. Populated for session-scoped errors so the web client can route them per session instead of per connection. |

### `AgentKind`

`'claude' | 'codex'`. Both `packages/bridge/src/types.ts` and `apps/web/src/types/protocol.ts` updated, kept byte-identical.

### `list_prompts` (formalized; defined in Phase 1 spec but unimplemented)

**Client → Server:**

| Type | Fields |
|---|---|
| `list_prompts` | `query?: string`, `limit?: number` (default 200), `correlationId?` |

**Server → Client:**

| Type | Fields |
|---|---|
| `prompts_result` | `prompts: Array<{ text: string; lastUsedAt: number; projectPaths: string[]; agents: AgentKind[] }>`, `correlationId?` |

Filtering: `query` is plain substring match (case-insensitive). Project filter is client-side from the returned `projectPaths`.

## 5. Components

### Bridge — new files

| File | Responsibility |
|---|---|
| `accounts.ts` | Sync read of `${BRIDGE_DATA_DIR}/accounts.json` at boot. Returns `Map<accountName, { codexHome }>`. Synthesizes a single `default` entry when the file is missing, malformed, or `codex_accounts` is empty. Validates each `codexHome` exists and is a directory; drops invalid entries with a log warning. If all are dropped, falls back to `default`. |
| `codex-process.ts` | One instance per session. Methods: `sendUserText(text: string): void`, `kill(): void`. State: `codexSessionId: string \| null`, `currentTurnProc: ChildProcess \| null`. Each `sendUserText` spawns a fresh process with `CODEX_HOME` set to the session's account path. First turn invocation captures `session_id` from parsed output and stores it on `this`. Emits `event: AgentEvent` and `exit: (code, reason?)` matching Phase 1's `ClaudeProcess` shape so `SessionManager` swaps drivers polymorphically. |
| `codex-parser.ts` | `parseCodexLine(line: string): AgentEvent \| { kind: 'session_id'; id: string } \| null`. Handles the subset of `codex --json` events needed for plain-text chat: agent message → `assistant_text`, function/command call → `tool_use`, command/function output → `tool_result`, task completion → `result`, plus the session-init event that carries `session_id`. Returns `null` for unrecognized types and logs the type name once per process. Concrete event-name mappings are confirmed against installed Codex output at implementation time and pinned in a comment. |
| `transcript-store.ts` | `class TranscriptStore`. Methods: `append(sessionId, msg): void` (lazy file open + append-NDJSON), `close(sessionId): void` (called from `session_ended`), `prune(retentionDays): Promise<number>` (one-shot scan, returns count deleted). Files live at `${BRIDGE_DATA_DIR}/transcripts/<sessionId>.jsonl`. |
| `prompt-store.ts` | `class PromptStore` over `${BRIDGE_DATA_DIR}/prompts.json`. Methods: `add({ text, projectPath, agent }): void` (sha256-dedupe by text, push-to-front, cap 500), `list(query?, limit?): PromptEntry[]` (substring filter, sort by `lastUsedAt` desc, slice). Atomic write via temp-file + rename. |

### Bridge — modified files

| File | Change |
|---|---|
| `types.ts` | `AgentKind = 'claude' \| 'codex'`. Add `account?` to `ServerLifecycleMsg` and `ServerSessionListMsg.sessions[i]`. Add `ClientListAccountsMsg`, `ClientListPromptsMsg`, `ServerAccountListMsg`, `ServerPromptsResultMsg`. Extend `ServerErrorCode` with new codes. |
| `env.ts` | Read `BRIDGE_DATA_DIR` (default `~/.config/mac-remote-terminal`), `BRIDGE_TRANSCRIPT_RETENTION_DAYS` (default 30, integer ≥0; 0 disables). Make `dataDir` and `transcriptRetentionDays` part of `BridgeConfig`. |
| `session.ts` | `InternalSession` gains `account?: string`. `create({ agent, projectPath, account?, correlationId? })`: when `agent === 'codex'`, validate account against `accountsRegistry`; if exactly one account and none specified, use it; if none specified and >1 accounts exist, error `unknown_account` with the configured names. Spawn driver via injected factory keyed by agent. `appendAndBroadcast` calls `transcriptStore.append`. `sendInput` adds `promptStore.add` after the user-event broadcast. `onProcExit` calls `transcriptStore.close`. |
| `websocket.ts` | New routes: `list_accounts` → reply `account_list`; `list_prompts` → reply `prompts_result`. Existing `start` forwards `account` to `mgr.create`. |
| `http-server.ts` | New route `GET /transcripts/<sessionId>`. UUID regex on path segment (400 if not). Cookie auth same as static. Resolve to `${BRIDGE_DATA_DIR}/transcripts/<sessionId>.jsonl`, realpath, prefix-check against transcripts dir. 404 if missing. Stream file with `application/x-ndjson`. |
| `index.ts` | Boot: load `accounts.ts` registry, instantiate `TranscriptStore` and `PromptStore` rooted at `cfg.dataDir`, run `transcriptStore.prune(cfg.transcriptRetentionDays)` (only if >0). Pass dependencies into `SessionManager`. Wire driver factory: `agent === 'claude'` → `new ClaudeProcess(...)`, `agent === 'codex'` → `new CodexProcess(projectPath, account.codexHome)`. |

### Web — new files

| File | Responsibility |
|---|---|
| `store/accounts.ts` | Zustand store: `accounts: AccountSummary[]`, `selectedAccount: string \| null`. Hydrated from `account_list` server message. |
| `store/prompt-history.ts` | Zustand store: `prompts: PromptEntry[]`, `query: string`, `showProjectOnly: boolean`. Hydrated from `prompts_result`. |
| `services/transcript-fetcher.ts` | `async function* streamTranscript(sessionId: string): AsyncIterable<SessionEvent>`. `fetch('/transcripts/<id>')` → reader → newline-split → `JSON.parse` each line. Throws on 401/403/404. |
| `features/prompt-history/PromptHistoryDropdown.tsx` | Searchable dropdown rendered above `InputBox`. Inputs: live `query`, list source, `onPick`. Project-filter checkbox. Keyboard nav: ↑/↓/Enter/Esc. |
| `features/prompt-history/PromptHistoryDropdown.css` | Styles. |

### Web — modified files

| File | Change |
|---|---|
| `types/protocol.ts` | Mirror bridge `types.ts` byte-for-byte. |
| `App.tsx` | On `open`: also send `list_accounts` and `list_prompts`. Route `account_list` and `prompts_result` to their stores. |
| `features/project-picker/ProjectPicker.tsx` | Add agent radio (`claude` / `codex`). When `codex` selected and `>1` accounts known, render dropdown of account names. |
| `features/project-picker/useNewSession.ts` | Pass `account` to `start` when agent is codex. |
| `features/session-list/SessionList.tsx` | Show small agent badge on each row. For codex, suffix the account name. |
| `features/chat/InputBox.tsx` | Host `PromptHistoryDropdown` above the textarea, anchored with a `↑` keyboard shortcut to open. On pick, fill the textarea and close. |
| `pages/Session.tsx` | When `get_history` returns `error: session_dead`, switch to transcript-only mode: call `streamTranscript(id)`, dispatch each event into the sessions store, render a single synthetic header bubble `transcript-only view (session no longer live)`. Disable the input box. |

## 6. Data Flow

### Codex turn

1. Browser sends `input { sessionId, text }`.
2. Bridge `SessionManager.sendInput`:
   - Append user event (`type: 'user'`, monotonic seq) to ring buffer + transcript file + broadcast (Phase 1 behavior).
   - Call `promptStore.add({ text, projectPath: session.projectPath, agent: session.agent })`.
   - Call `session.proc.sendUserText(text)`.
3. `CodexProcess.sendUserText`:
   - Build argv. Common: `['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-C', projectPath]`. If `codexSessionId !== null`, prepend `resume <id>` form: `['exec', 'resume', codexSessionId, '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-C', projectPath]`. Pass prompt as positional last arg, OR pipe to stdin if length > some threshold (resolve at impl).
   - Spawn `codex` with env `{ ...process.env, CODEX_HOME: this.codexHome }`. Stdio: `['ignore' | 'pipe', 'pipe', 'pipe']` — stdin is `pipe` only if we pipe the prompt; otherwise `'ignore'`.
   - Stdout → line-buffer → `parseCodexLine` → events emitted on `this`.
   - First-turn behavior: when parser yields `{ kind: 'session_id', id }`, store on `this.codexSessionId`. Do not re-emit to SessionManager.
   - Process exit: clear `currentTurnProc`. If `codexSessionId` is still null after the run, emit a single error event: `{ kind: 'error', code: 'codex_session_id_missing' }` translated by SessionManager into a broadcast `error` message.
4. SessionManager forwards `event` items into its event pipeline (same `appendAndBroadcast` Claude uses).

### Account selection

1. Browser opens WS. App's existing `open` handler also sends `list_accounts`.
2. Bridge replies `account_list`. Web `accounts.ts` store hydrates.
3. UI: project picker shows agent radio. Codex selection populates dropdown from store. Default account preselected.
4. `start { agent: 'codex', projectPath, account: 'work', correlationId }`.
5. Bridge validates account name. Mismatch → `error: unknown_account` with valid names listed in `message`.
6. SessionManager creates session, spawns `CodexProcess(projectPath, account.codexHome)`, broadcasts `session_created` with `account: 'work'`.

### Transcript-only fallback

The Phase 1 `App.tsx` stringifies error messages into `connection.lastError` for the global banner, which is too lossy for a fallback decision. Phase 2 introduces a typed session-scoped error path so `Session.tsx` can react reliably.

1. The web `sessions.ts` store gains a `transcriptOnly: Record<sessionId, boolean>` field. Setter `markTranscriptOnly(sessionId)`.
2. `App.tsx`'s message handler is extended: when an `error` message arrives with `code: 'session_dead'` AND a session-scoped sessionId is recoverable (we add an optional `sessionId?: string` field on `ServerErrorMsg` and have the bridge populate it for session-scoped errors), call `useSessionsStore.getState().markTranscriptOnly(sessionId)` before falling through to the global error setter.
3. `Session.tsx` watches `transcriptOnly[id]`. When true, calls `streamTranscript(id)` once. Each yielded event dispatches `applyServerMsg` into the sessions store as if it were live history. A synthetic header is prepended client-side: `transcript-only view (session no longer live)`. `InputBox` disabled when `transcriptOnly[id] === true`.
4. The bridge populates `ServerErrorMsg.sessionId` for `session_dead`, `path_outside_allowlist`, `unknown_account`, and `codex_session_id_missing`. Client-only / connection-level errors leave it unset.

Schema update: `ServerErrorMsg` adds optional `sessionId?: string`. Mirrored to web protocol.

### Prune

- At bridge boot in `index.ts`: if `cfg.transcriptRetentionDays > 0`, call `await transcriptStore.prune(cfg.transcriptRetentionDays)`. Returns count, log it.
- `prune` reads each file's `mtime`. Files older than `now - days * 86400_000` are unlinked. Files belonging to sessions that are about to be live (the manager hasn't constructed any yet) are not specially excluded — moot at boot.

### Prompt history

- `promptStore.add` is called from `SessionManager.sendInput` per user prompt (Phase 1 protocol).
- File: `${BRIDGE_DATA_DIR}/prompts.json`. Schema:
  ```jsonc
  {
    "version": 1,
    "entries": [
      {
        "hash": "<sha256(text)>",
        "text": "<original prompt>",
        "lastUsedAt": 1714999999999,
        "projectPaths": ["/Users/me/proj-a"],
        "agents": ["claude", "codex"]
      }
    ]
  }
  ```
- On add: lookup by hash. If found, push to front, update `lastUsedAt`, union projectPaths and agents. Else insert at front. Trim to 500.
- Atomic write: serialize → write to `prompts.json.tmp` → `rename` over the real file.
- `list(query?, limit?)`: case-insensitive substring on `text`. Sort by `lastUsedAt` desc. Slice to `limit ?? 200`.

## 7. Errors

| Failure | Behavior |
|---|---|
| `accounts.json` missing | Synthesize `default` from `process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')`. No log. |
| `accounts.json` malformed JSON | Log warning. Synthesize `default`. Do not crash. |
| Account `codexHome` not a directory | Drop with log warning. If all dropped, fall back to default. |
| `start` with `account` not in registry | `error: unknown_account` with `message: "Unknown Codex account '<name>'. Configured: [a, b, c]"`. |
| `start` with `agent: 'codex'` and >1 accounts but no `account` | `error: unknown_account` with `message: "Account is required when multiple Codex accounts exist"`. |
| Codex spawn ENOENT | Same path as Claude — `exit(null, 'agent_not_installed')` → SessionManager broadcasts `error: agent_not_installed`. |
| Codex first-turn never emits `session_id` | `error: codex_session_id_missing` broadcast once for the session. UI surfaces it as a system bubble in the chat (rendered by `MessageBubble` for `error` events with this code, similar to existing `session_ended`). Subsequent turns fall back to fresh `codex exec` (no resume) — they work but cumulative state is reset between turns. |
| `codex exec` non-zero exit | `result` event with `error: <stderr-tail-4KB>`, session stays alive. |
| Transcript file write fails | Log error. Continue broadcast. Subsequent appends retry; failure does not block the live stream. |
| `GET /transcripts/<id>` non-UUID id | 400. |
| `GET /transcripts/<id>` file missing | 404. |
| `GET /transcripts/<id>` with no/bad cookie | 401 / 403 (existing http-server logic). |
| `prompts.json` corrupted | Log warning, treat as empty, overwrite on next `add`. |
| Prune disk error | Log per file, continue. Fail-soft. |

## 8. Security

- `accountsRegistry` keeps `codexHome` paths server-side only. Wire protocol exposes only account names + `isDefault`.
- `codexHome` not allowlisted against `BRIDGE_ALLOWED_DIRS` — they're agent config dirs (`~/.codex-*`), not project dirs. Operator owns the JSON file.
- `GET /transcripts/<sessionId>`:
  - Cookie auth (same as static bundle).
  - Origin/Host validation when an `Origin` header is present (existing `isOriginAllowed`).
  - sessionId path segment must match `^[0-9a-f-]{36}$`. Reject otherwise (400).
  - Resolved file path realpath'd; reject if not under `${BRIDGE_DATA_DIR}/transcripts/`. Defends against future symlinks-in-data-dir mistakes.
  - Content-Type `application/x-ndjson`; `X-Content-Type-Options: nosniff` to prevent browser sniff.
- `prompts.json` plaintext on disk. Operator is single user. Documented; no encryption at rest.
- Agent process inherits operator's env including secrets. Same trust model as Phase 1.
- `accounts.json` path is `${BRIDGE_DATA_DIR}/accounts.json`. `BRIDGE_DATA_DIR` defaults under `$HOME/.config/`. Operator-owned.

## 9. Testing

### Bridge unit tests

- `accounts.test.ts` — missing file fallback, malformed JSON fallback, valid multi-account file, dropping invalid `codexHome`, default-when-all-dropped, `process.env.CODEX_HOME` override for default fallback.
- `codex-parser.test.ts` — recorded fixture from real `codex exec --json` output (capture at impl time). Assert event mapping for: agent message, function call, function output, task complete, session-init capture. Unknown event types → null + warn-once.
- `codex-process.test.ts` — argv assembly for first turn vs resume, `CODEX_HOME` injected into env, JSONL parsing, session-id capture (after which subsequent calls use `resume`), kill mid-turn, exit-code propagation, `agent_not_installed` translation.
- `transcript-store.test.ts` — append writes one NDJSON line per call, file format valid (each line `JSON.parse`-able), close releases handle, prune deletes files older than retention, prune spares fresh files, prune fail-soft on EACCES.
- `prompt-store.test.ts` — dedupe by hash, cap eviction, atomic write via tmp+rename, query substring case-insensitive, sort by lastUsedAt desc, projectPaths/agents unioned.
- `session.test.ts` (additions) — codex create with no account uses default, with valid account echoes name, with bogus account `unknown_account` error, codex driver receives sendUserText, transcriptStore.append called for every broadcast event including user, promptStore.add called for user input only.
- `http-server.test.ts` (additions) — `GET /transcripts/<id>` happy path returns 200 + NDJSON, 404 missing, 400 non-UUID, 401 no cookie, 403 origin mismatch, content-type correct.
- `websocket.test.ts` (additions) — `list_accounts` returns name list, `list_prompts` returns prompts_result, `start` with `account` forwards to mgr.create.

### Web unit tests

- `accounts` store — hydration, default selection.
- `prompt-history` store — hydration, query filter, project-only toggle.
- `PromptHistoryDropdown` — render filtered list, keyboard nav, click pick fires onPick, esc closes.
- `transcript-fetcher` — split partial chunks, propagate JSON parse errors, throw on 4xx.
- `Session.tsx` (additions) — when sessions store has session and lastError matches session_dead+id, calls streamTranscript and dispatches events. Header bubble visible. InputBox disabled.

### Bridge integration tests

- Codex E2E gated behind `RUN_E2E=1`: spawn real `codex exec --json` against a sandbox project and confirm the parser produces sane events.
- Bridge restart simulation: write a transcript file, boot bridge, request `GET /transcripts/<id>` over a real HTTP server, parse and confirm round-trip.

### Manual smoke

Run after Phase 2 lands. Same shape as Phase 1 Task 20:

1. Start bridge with at least one Codex account configured.
2. Create a Codex session — verify account dropdown.
3. Send 3 prompts — verify resume works (no re-init bubble between turns).
4. Stop bridge mid-conversation. Restart. Open `/session/<old-id>` directly. Verify transcript-only fallback view.
5. Type `↑` in InputBox of a fresh session — verify prompt history dropdown shows past prompts. Toggle "this project only".

## 10. Environment

| Variable | Default | Description |
|---|---|---|
| `BRIDGE_TOKEN` | (required, ≥24 chars) | Phase 1 — unchanged. |
| `BRIDGE_PORT` | `8765` | Phase 1 — unchanged. |
| `BRIDGE_BIND_HOST` | (Tailscale IPv4) | Phase 1 — unchanged. |
| `BRIDGE_ALLOWED_DIRS` | `$HOME` | Phase 1 — unchanged. |
| `BRIDGE_DATA_DIR` | `~/.config/mac-remote-terminal` | Used in Phase 2 for `accounts.json`, `prompts.json`, and `transcripts/`. |
| `BRIDGE_TRANSCRIPT_RETENTION_DAYS` | `30` | Phase 2 — pruner threshold. `0` disables pruning. |
| `CODEX_HOME` | (operator-set, optional) | Used as the implicit default account's `codexHome` when no `accounts.json` is present. |

## 11. Open Items Deferred to Implementation

- Exact Codex `--json` event-name mapping. Capture a real `codex exec --json` run against `Codex CLI 0.128.0` (currently installed) and pin the mapping in `codex-parser.ts` with a `// pinned to codex-cli 0.128.0` comment.
- Whether to pass the prompt as argv or via stdin. Decision threshold ~8 KB. Resolve from real-world prompt sizes during impl.
- Atomic-write strategy on filesystems that don't support `rename` over an existing open file (Windows). Not relevant for macOS/Linux but worth a single-line note.
- Whether `PromptHistoryDropdown` should also surface the project path on each entry. Likely yes — adds context — but not load-bearing for the design.

## 12. Implementation Phasing

The Phase 2 plan (separate doc under `docs/superpowers/plans/`) breaks into ~11 tasks ordered to ship testable software at every step:

1. `accounts.ts` loader + tests + boot wiring.
2. `transcript-store.ts` + tests + integrate into `SessionManager.appendAndBroadcast`.
3. `GET /transcripts/<id>` HTTP route + tests.
4. `codex-parser.ts` with recorded fixture + tests.
5. `codex-process.ts` with mocked spawn + tests; `SessionManager` learns to swap drivers by `agent`.
6. `list_accounts` + account validation in `start` + bridge tests.
7. Web — accounts store + Codex agent + account dropdown in `ProjectPicker`.
8. Web — transcript-only fallback in `Session.tsx`.
9. `prompt-store.ts` + `list_prompts` route + bridge tests.
10. Web — prompt-history store + `PromptHistoryDropdown` mounted above `InputBox`.
11. Manual e2e smoke.

Each step gets its own commit cluster (test → impl → spec review → quality review) following the Phase 1 cadence.
