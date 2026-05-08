# Phase 5 — History Viewer + Session Resume + Banner Cleanup

**Status:** Draft — codex review pending
**Date:** 2026-05-08
**Phases shipped:** 1, 2, 3, 4

## 1. Goal

Make any past Claude or Codex CLI session resumable from the web UI. Three coupled deliverables:

1. **Resume button** — every dead session (whether bridge-known or freshly discovered from native CLI history) gets a single-click resume action that re-spawns the CLI with `--resume <id>` and routes the user back into a live chat in the same project path.
2. **History viewer** — a sidebar drawer listing the 50 most-recent past sessions per agent (Claude + Codex tabs) found in the user's native CLI history dirs (`~/.claude/projects/*` and `~/.codex/sessions/*`). Click a row → resume.
3. **Banner cleanup** — the noisy `session_dead` error toast is silenced when transcript replay successfully shows the prior chat. Replaced by an inline "session ended — click Resume to continue" prompt above the input box.

## 2. Scope

### In scope

- Bridge: new `history-scanner.ts` module (read native CLI session dirs); new `session-registry.ts` (disk-persisted `webSessionId → metadata` map); `SessionManager.resume(webSessionId)`; two new WS message types (`list_history`, `resume_session`).
- Web: `HistoryPanel` drawer + `historyStore`; `ResumePrompt` inline banner; `MessageBubble`/`Chat` integration; auto-prompt-on-send for dead sessions; `error: session_dead` routed to per-session state instead of global error banner.
- Documentation: this spec + a Phase 5 implementation plan.

### Out of scope (deferred)

- Search / filter inside history list (chronological-only for now).
- Pagination beyond top-50 per agent.
- Turn count / token usage / cost in history rows (would require full file parse).
- Bulk-resume, archive, or per-row delete-history actions.
- Surfacing bridge's own transcripts (`.bridge/transcripts/*.jsonl`) as history rows. Bridge transcripts re-appear automatically via the persisted registry's live-sessions list after restart; they're not native CLI sessions.
- Multi-account selection UI on resume — Codex falls back to default profile if the original session had none recorded.

## 3. Architecture

```
┌─ Web (Vite + React 18) ────────────────────────────────────────────┐
│ pages/Sessions.tsx      ┌──────────────────────────────────────┐    │
│   ├─ live sessions list │  features/history/HistoryPanel.tsx   │    │
│   └─ <HistoryPanel />   │  Claude tab | Codex tab               │   │
│                         │  ▸ row · row · row (top-50 each)      │   │
│                         └──────────────────────────────────────┘    │
│ pages/Session.tsx                                                    │
│   ├─ message bubbles (Phase 4)                                       │
│   ├─ <ResumePrompt /> ← only when !alive                             │
│   └─ <InputBox /> ← auto-prompt-on-send when !alive                  │
│                                                                       │
│ store/sessions.ts                                                     │
│   ├─ resume(webSessionId)            ─┐                               │
│   ├─ resumeFromHistory(entry)        ─┼─→ ws send: resume_session     │
│   └─ session_dead → alive=false (per-session, not global)             │
│                                                                       │
│ store/historyStore.ts                                                 │
│   ├─ fetch()  ─→ ws send: list_history (60s cache)                    │
│   └─ { claude: [], codex: [], loading, lastFetched }                  │
└──────────────────────────────────────────────────────────────────────┘
                              ↕ WebSocket
┌─ Bridge (Node 20 ESM) ─────────────────────────────────────────────┐
│ history-scanner.ts                                                   │
│   ├─ scanClaude(allowedDirs) → walk ~/.claude/projects/*/<id>.jsonl  │
│   ├─ scanCodex(allowedDirs)  → walk ~/.codex/sessions/Y/M/D/*.jsonl  │
│   └─ returns top-50 per agent, sorted by mtime desc                  │
│                                                                       │
│ session-registry.ts                                                   │
│   ├─ load()/save() — atomic writes to .bridge/sessions.json          │
│   └─ map<webSessionId, { agent, projectPath, cliSessionId, ... }>    │
│                                                                       │
│ session-manager.ts (modified)                                         │
│   └─ resume(webSessionId)                                             │
│       ├─ Claude: spawn `claude --resume <claudeId> -p ...`            │
│       └─ Codex:  re-instantiate CodexDriver seeded with codexSessionId│
│                  so next send_text runs `codex exec resume <id>`      │
│                                                                       │
│ ws-server (handlers added)                                            │
│   ├─ list_history → scanner (60s in-memory cache) → history_list     │
│   └─ resume_session → SessionManager.resume() → session_resumed      │
└──────────────────────────────────────────────────────────────────────┘
```

### Resume model

Two paths converge into the same `resume()` flow on the bridge. Each is asymmetric per agent because Claude is a long-running child whereas Codex is spawn-per-turn (Phase 2).

**Path 1 — Resume a bridge-known dead session** (existing webSessionId in registry):

- Web sends `resume_session { webSessionId, account?, correlationId }`.
- Bridge looks up registry entry to retrieve `agent`, `projectPath`, `claudeSessionId | codexSessionId`.
- **Claude**: bridge spawns `claude --resume <claudeSessionId> -p --dangerously-skip-permissions --output-format stream-json --input-format stream-json --include-partial-messages --verbose` with `cwd: projectPath`. Reuses the existing ClaudeDriver factory.
- **Codex**: bridge instantiates a new `CodexDriver` for the same webSessionId, **seeded with `codexSessionId`** so the driver's "next-turn command" is `codex exec resume <codexSessionId> --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check` instead of `codex exec` (the seed is the same field the existing driver populates after the first turn). No spawn happens here — the spawn fires on the user's first `send_text` per the existing P2 spawn-per-turn flow.
- Both agents: bridge sets `alive: true` on the session entry, persists registry, replies `session_resumed { webSessionId, alive: true }`.
- Web flips local alive flag; ResumePrompt unmounts; input box becomes active.

**Path 2 — Resume a never-seen native CLI session from the History panel**:

- Web sends `resume_session { agent, sessionId, projectPath, account?, correlationId }` (no `webSessionId`).
- Bridge **must verify** the (agent, sessionId) pair against the scanned history before doing anything else (see §9 Security):
  - Look up the entry in the scanner cache (or rescan if absent). The scanner already establishes the file's ground-truth `cwd` via parsing.
  - If no entry exists for (agent, sessionId) → reject with `error: resume_failed, code: 'history_session_not_found'`.
  - If the file's ground-truth `cwd` is not inside `BRIDGE_ALLOWED_DIRS` → reject with `error: resume_failed, code: 'project_path_disallowed'`.
  - The client-supplied `projectPath` is treated as a HINT only; the bridge always uses the ground-truth `cwd` from the file when spawning. (If the hint disagrees, log a warning to bridge stderr but proceed with the ground truth.)
- Bridge issues a new webSessionId, persists registry with `claudeSessionId = sessionId` or `codexSessionId = sessionId`, then runs the same per-agent resume logic as Path 1 (Claude spawns; Codex seeds driver).
- Reply: `session_resumed { webSessionId, alive: true }`.
- Web routes to `/session/<webSessionId>`.

The same web sessionId is preserved across resumes for Path 1 — URL stays stable, transcript JSONL appends, reload-replay continues to work.

### Persisted registry

`.bridge/sessions.json` stores the metadata needed to resume across bridge restarts:

```json
{
  "sessions": {
    "<webSessionId>": {
      "agent": "claude",
      "projectPath": "/Volumes/WDSSD/Code/foo",
      "claudeSessionId": "7fd29a66-32c0-4475-ace4-6149647c7e7e",
      "transcriptPath": ".bridge/transcripts/<webSessionId>.jsonl",
      "createdAt": 1800000000000,
      "account": null
    },
    "<webSessionId-2>": {
      "agent": "codex",
      "projectPath": "/Volumes/WDSSD/Code/bar",
      "codexSessionId": "019dab5c-ebc2-7cd1-87a6-43b49397fa49",
      "transcriptPath": ".bridge/transcripts/<webSessionId-2>.jsonl",
      "createdAt": 1800000000000,
      "account": "default"
    }
  }
}
```

**Atomic + concurrency-safe write protocol**:

A naïve `tmp file + rename` is NOT safe under concurrent async writers in the same Node process — two overlapping `save()` calls share the same tmp path, race, and can lose the newer write or rename a missing file.

The registry uses three layers:

1. **Serialized write queue (in-process mutex)**. Every `save()` chains onto a module-level `writePromise` (a `let writePromise: Promise<void> = Promise.resolve()`). Each new save does `writePromise = writePromise.then(() => doWrite(state))`. The latest in-memory state is captured at the time `doWrite` runs, so coalesced writes are fine. Never two `doWrite` runs concurrently.
2. **Unique tmp filename per write**: `.bridge/sessions.json.tmp.<pid>.<counter>` where `counter` increments per call. Even if a future refactor parallelizes, two writers don't collide.
3. **Fsync before rename**: `await fh.write(...); await fh.sync(); await fh.close(); await fs.rename(tmp, final)`. On crash, either the old file remains intact OR the new one is fully durable — never a torn write.

On boot, bridge loads the file, populates `sessions` map with `alive: false` for each entry, and waits for resume actions or new spawns. If the file is missing or unparseable, log to stderr and start with an empty registry (no crash).

## 4. WS Protocol

### Client → Bridge

```ts
// List native CLI history (top-50 per agent, allowlist-filtered)
interface ClientListHistoryMsg {
  type: 'list_history';
  correlationId: string;
}

// Resume — two shapes share one message type:
//   (a) Bridge-known dead session: only webSessionId required; bridge looks up
//       agent + projectPath + cliSessionId from registry.
//   (b) Native history first-resume: agent + sessionId + projectPath required;
//       webSessionId absent (bridge issues a new one).
// Web carries webSessionId in its session store, but NEVER carries the CLI's
// own session uuid — that lives only in the bridge registry. So for shape (a)
// the web cannot supply sessionId.
type ClientResumeSessionMsg =
  | {
      type: 'resume_session';
      webSessionId: string;
      account?: string;
      correlationId: string;
    }
  | {
      type: 'resume_session';
      agent: 'claude' | 'codex';
      sessionId: string;       // CLI's own session uuid
      projectPath: string;     // cwd for the spawn
      account?: string;        // codex profile name; defaults to 'default'
      correlationId: string;
    };
```

### Bridge → Client

```ts
interface ServerHistoryListMsg {
  type: 'history_list';
  claude: HistoryEntry[];   // already top-50, sorted by mtime desc
  codex: HistoryEntry[];
  correlationId: string;
}

interface HistoryEntry {
  agent: 'claude' | 'codex';
  sessionId: string;        // CLI's session uuid (claude: filename without .jsonl; codex: from session_meta.payload.id)
  projectPath: string;      // ground-truth cwd extracted from file content (entries with no parseable user message are dropped, never surfaced)
  mtime: number;            // ms since epoch
  firstPrompt: string;      // first user message text, truncated to 80 chars
}

interface ServerSessionResumedMsg {
  type: 'session_resumed';
  webSessionId: string;
  alive: true;
  correlationId: string;
}

// Resume failure (typed error). The new error includes optional sessionId so
// the web can route the message to the right per-session view (matches the
// existing session_dead error shape from Phase 1, which also carries sessionId).
interface ServerErrorMsg {
  type: 'error';
  code:
    | 'resume_failed'
    | 'history_session_not_found'   // (agent, sessionId) not in scanner cache or filesystem
    | 'project_path_disallowed'     // ground-truth cwd outside BRIDGE_ALLOWED_DIRS
    | 'project_path_missing'        // projectPath no longer exists on disk
    | /* existing codes... */;
  message: string;
  sessionId?: string;               // present when the error is scoped to a specific session
  correlationId: string;
}
```

### Existing protocol changes

- New error code `'resume_failed'` on `ServerErrorMsg`.
- Existing `error: session_dead` is unchanged on the wire; web routes it differently (per-session `alive=false` instead of global error banner).

## 5. History scan

New module: `packages/bridge/src/history-scanner.ts`. Reads native CLI session directories, returns top-50 per agent.

### Algorithm

```ts
async function listHistory(allowedDirs: string[]): Promise<{
  claude: HistoryEntry[];
  codex: HistoryEntry[];
}> {
  const [claude, codex] = await Promise.all([
    scanClaude(allowedDirs),
    scanCodex(allowedDirs),
  ]);
  return { claude, codex };
}
```

### Pre-cap sort invariant

Both scanners must establish the candidate-by-mtime order BEFORE any cap is applied, otherwise the most-recent sessions sitting beyond the cap boundary disappear. The order is therefore:

1. Enumerate all candidate file paths (Claude: across all project dirs; Codex: across all date dirs).
2. `stat` each path — collect `{ filePath, mtime }`. (Cheap; even 5000 files = ~5000 stats < 100 ms on macOS.)
3. Sort the full list by mtime desc.
4. THEN take top 50.
5. THEN do per-file partial reads on those 50.

The intermediate cap of 200 mentioned in earlier drafts was wrong — it must be removed. The hard cap is only on per-file content reads (50 reads at 4-16 KB each = trivial).

### `scanClaude`

1. List `~/.claude/projects/*` directories (each name is an encoded cwd: `/` → `-`). The encoding is irreversible when path segments contain literal `-`, so dir names are NOT used for allowlist filtering.
2. List `*.jsonl` files inside each dir; collect `{ filePath, mtime }` via `stat`. No prefilter on dir names.
3. Sort all candidates by mtime desc; take **top 75** (over-read margin so allowlist-rejections don't shrink the surfaced list below 50).
4. For each top-75 entry: read first ~4 KB of the file. Parse line-by-line until a user message is found; extract its `cwd` (ground truth) and first text content (truncated to 80 chars).
5. Allowlist gate: reject entries whose ground-truth `cwd` is NOT inside `BRIDGE_ALLOWED_DIRS` (realpath + Phase 3 denylist gates). Drop them silently from the result.
6. If the file has no parseable user message in its first ~4 KB, drop the entry (we can't allowlist-validate without ground truth, so we don't surface it).
7. Cap the post-filter list at top 50 (still mtime-desc sorted).
8. Return `[{ agent: 'claude', sessionId: filename without .jsonl, projectPath: groundTruthCwd, mtime, firstPrompt }]`.

The over-read of 75 (vs the surfaced cap of 50) absorbs allowlist-rejections without re-introducing the prefilter false-negatives that made earlier drafts unsafe. If even more are rejected (rare), the surfaced list simply shrinks below 50; the spec does not retry with a larger over-read.

### `scanCodex`

1. Walk `~/.codex/sessions/<YYYY>/<MM>/<DD>/*.jsonl` (3-level glob). No cap during enumeration.
2. `stat` each file; sort all by mtime desc; take top 75 (over-read margin same as Claude).
3. For each: read first line — Codex's `session_meta` event has `payload.id` (sessionId), `payload.cwd` (project path), `payload.originator` (informational), `payload.git` (informational).
4. Allowlist gate: reject entries whose `cwd` isn't inside `BRIDGE_ALLOWED_DIRS`.
5. Bounded forward-scan (~16 KB) for first user message; truncate text to 80 chars. If none, `firstPrompt = ''`.
6. Cap the post-filter list at top 50.
7. Return `[{ agent: 'codex', sessionId: payload.id, projectPath: payload.cwd, mtime, firstPrompt }]`.

### Performance budget

- ~5000 stat calls + 75 partial-file reads (4-16 KB each) per agent per call. Target <200 ms cold-cache on a typical SSD-backed home dir.
- Bridge caches the `history_list` reply in-memory for 60 s to dedupe rapid reloads. Cache key is "everything" (no per-arg variation since args are static). Cache invalidates immediately on `resume_session` success (so a fresh resume's mtime bump is reflected next time).

### Path-decoding ambiguity (Claude)

Claude encodes `/` as `-` in dir names — irreversible when path segments contain literal `-`. The earlier draft tried to dir-decode for prefiltering and failed both ways: false positives (read a file we'd reject) AND false negatives (drop a file we'd accept). The fix above sidesteps the issue entirely:

- Dir names are NEVER used for allowlist decisions.
- Allowlist is enforced ONLY against the ground-truth `cwd` extracted from the file content.
- A file with no parseable user message is dropped (can't validate without ground truth).

## 6. Banner cleanup

### Web behavior change

`applyServerMsg` for `error.code === 'session_dead'`:
- Sets `session.alive = false` for the named sessionId in `useSessionsStore`.
- Does NOT push to `useConnectionStore.errors` (the global error banner source).

`Session.tsx` already calls `streamTranscript()` on dead sessions. After fallback resolves:

| Transcript yielded | Display |
|---|---|
| ≥1 event | `<ResumePrompt />` above InputBox: "session ended — [Resume to continue]" |
| 0 events | inline notice: "session ended; transcript unavailable — [New session]" |

The global error banner is reserved for genuinely-cross-cutting errors (auth fail, bridge unreachable). Per-session lifecycle errors stay scoped to the session view.

### Bridge behavior

No protocol change. Bridge continues replying `session_dead` for unknown sessions; the routing change is purely in the web client.

## 7. Resume UX

### Trigger surfaces

- **Header button**: dead sessions show `[Resume]` in the chat header strip.
- **Inline ResumePrompt**: rendered above InputBox on dead sessions.
- **Auto-prompt-on-send**: if user types into InputBox on a dead session and clicks send, the send is intercepted; ResumePrompt swaps to a "Resume + send" CTA inline. On click, resume runs; the queued first message flushes once `alive: true` arrives. Subsequent messages typed while resume is in-flight stay in InputBox until user re-clicks send.

### History panel

- Collapsible drawer below the existing Live sessions list in `pages/Sessions.tsx`.
- Two tabs: Claude (count) | Codex (count).
- Each row: project basename · first-prompt preview (truncated) · relative time (e.g. "2h ago").
- Hover tooltip: full project path + full first-prompt + ISO timestamp.
- Empty tab placeholder: "No past sessions for {agent}".
- Lazy-fetch on first expand. 60 s store-side dedupe.

### Resume action wiring

```
Click handler                                             ⇣

  // Path (a): resuming a session the bridge already knows about.
  // Web has webSessionId, NOT the CLI session uuid (that lives in bridge registry).
  resume(webSessionId):
    ws.send({ type: 'resume_session', webSessionId, correlationId })
    on 'session_resumed' → set sessions[webSessionId].alive = true
    on 'error'           → render inline error in Session.tsx

  // Path (b): resuming a native CLI session never seen by the bridge.
  // Web has agent + sessionId + projectPath from the HistoryPanel row.
  resumeFromHistory(entry):
    ws.send({ type: 'resume_session',
              agent: entry.agent,
              sessionId: entry.sessionId,
              projectPath: entry.projectPath,
              correlationId })
    on 'session_resumed' → navigate(`/session/${webSessionId}`)  // bridge issued the id
    on 'error'           → render inline error, refresh history list
```

## 8. Errors + Edge Cases

| Failure | Behavior |
|---|---|
| `claude --resume <id>` rejected by Claude (id missing from local cache) | Bridge captures stderr; replies `error: code='resume_failed', message: "Claude does not recognize session <id>", sessionId: webSessionId`. Web shows inline "Session unavailable — [Open new session in this folder]". |
| `codex exec resume <id>` rejected (first send after resume fails) | Same shape; bridge surfaces stderr verbatim. The driver was seeded with the resume id but the spawn fails on the first send. |
| `projectPath` no longer exists | Bridge stat-checks before spawn. Missing → `error: code='project_path_missing', message: "Project path no longer exists: <path>"`. Inline "[Open new session]" CTA. |
| `projectPath` outside `BRIDGE_ALLOWED_DIRS` (allowlist tightened since session was created) | `error: code='project_path_disallowed', message: "Project path is not in BRIDGE_ALLOWED_DIRS"`. Same inline path. |
| Path 2 resume: client supplies `(agent, sessionId)` not present in scanner cache or filesystem | `error: code='history_session_not_found', message: "No history session found for <agent>:<sessionId>"`. Web auto-refreshes history list. |
| Double-click Resume | Bridge dedupes: in-flight resume returns the same promise; second WS reply mirrors the first. |
| Bridge restart mid-session | Registry persists; on startup all sessions load with `alive: false`. Existing reconnect-replay uses transcript fallback. User clicks Resume to continue. |
| History entry's CLI session file deleted between scan and click | Bridge stat-checks JSONL existence at resume time. Missing → `resume_failed: "session file no longer exists"`. Tell user; auto-refresh history. |
| Two concurrent Claude resumes for same project | Allowed. Each spawns its own bridge child + webSessionId. |
| Scanner can't read one file (permissions / partial / corrupt) | Skip; continue. Reply still has the rest. Log to bridge stderr. |
| Codex `session_meta` line malformed | Skip entry. |
| Claude dir-decoded path is wrong (hyphen-ambiguity) → ground-truth cwd disagrees | Use ground truth. Re-check it against allowlist. Reject silently if it now fails (entry doesn't appear in results). |
| 0 history sessions for one or both agents | Empty-state placeholder. |
| Auto-prompt-on-send: user types another message while resume in-flight | Only the first message auto-flushes after resume. Second stays in InputBox until user clicks send manually. |
| Concurrent `list_history` from two browser tabs | Bridge 60 s cache returns cached result; no double-scan. |
| User runs Claude in terminal while bridge is also running, creating a new session in same project | Next history scan picks it up via mtime sort. No collision. |
| Resume against Claude history entry never seen by bridge → no `webSessionId` in registry | Bridge issues new webSessionId, persists registry, then spawns. |
| Codex profile/account selection on resume | Use the `account` from `ClientResumeSessionMsg` if provided, else `'default'`. UI does not prompt — silent default. |

## 9. Security

- **Allowlist enforcement (history scan)**: history scanner enforces `BRIDGE_ALLOWED_DIRS` + Phase 3 denylist (DENIED_PATH_SEGMENTS, DENIED_SEGMENT_RUNS, DENIED_BASENAMES_CI, DENIED_BASENAME_PATTERNS) ONLY against the file's ground-truth `cwd` (extracted from content). Dir-name decoding is never trusted. No leak of paths outside allowlist.
- **Allowlist enforcement (resume)**: every resume — both Path 1 (bridge-known) and Path 2 (native history) — re-validates `projectPath` against `BRIDGE_ALLOWED_DIRS` + Phase 3 denylist immediately before spawn. The earlier scanner check is not load-bearing for security; the resume-time check is.
- **Native-history resume binding (anti-spoofing)**: client cannot supply an arbitrary `(agent, sessionId, projectPath)` tuple to coax the bridge into spawning at a wrong path. Bridge invariants:
  1. Look up `(agent, sessionId)` in the scanner cache (re-running the scan if cache is stale or absent).
  2. If not found → reject (`history_session_not_found`).
  3. The `projectPath` the bridge spawns under is ALWAYS the file's ground-truth `cwd`, NOT the client-supplied hint.
  4. Validate ground-truth `cwd` against allowlist; reject if it fails.
  This means even if the operator's web client is compromised and sends `{agent: 'claude', sessionId: 'arbitrary', projectPath: '/safe'}`, the bridge will still only spawn against the actual `cwd` in Claude's recorded session metadata, and only if that cwd is allowed.
- **Spawn arguments**: Claude/Codex session id is a uuid (validated `^[0-9a-f-]{36}$` regex case-insensitive before passing to `--resume`). `cwd` is realpath'd. `child_process.spawn(cmd, args, { cwd })` doesn't invoke a shell, so no metacharacter risk.
- **Registry file**: `.bridge/sessions.json` written with `0o600` mode (owner-only). Located inside `.bridge/` which is project-local and `.gitignore`d. Tmp file inherits same mode.
- **Concurrency**: registry writes are serialized through an in-process promise chain (see §3 Persisted Registry). No two writers can produce a torn file.
- **No new env vars**, no new endpoints beyond the two WS message types, no new exfiltration surface.
- **History scan does NOT read message content beyond the first user-message text (truncated to 80 chars).** Other event types are ignored. No tool-output, no assistant-text, no file content leaks into history rows.

## 10. Testing

### Bridge unit tests

`packages/bridge/src/__tests__/`:

- **`history-scanner.test.ts`** — mocked tmpdir with synthetic Claude + Codex layouts:
  - Top-50 cap holds across a 100-file dir (final surfaced list ≤ 50 mtime-desc)
  - Sort-then-cap order: a file with the newest mtime sitting at position 90 in directory-walk order still appears in the top-50 (proves stat-all-then-sort-then-cap pipeline)
  - Allowlist filter: ground-truth `cwd` outside `BRIDGE_ALLOWED_DIRS` → entry dropped (no dir-name pre-filter — allowlist enforced ONLY against file-content `cwd`)
  - File with no parseable user message in first 4 KB → entry dropped (no ground truth to validate)
  - Over-read top-75 then cap to 50: if allowlist rejects some, final list can be <50 but never duplicates or jumps order
  - Path-decoding ambiguity: dir name `-foo-bar-baz` with file's user-message `cwd: "/foo-bar/baz"` → ground truth wins
  - Malformed JSONL line: skipped, scan continues
  - First-prompt truncation at 80 chars
  - Empty/missing dir handled gracefully (returns `[]`)
  - Codex `session_meta` extraction from first line
  - 60 s cache: two `listHistory` calls < 60s apart run scanner once

- **`session-registry.test.ts`** — atomic write (tmp + rename), load on startup with `alive: false` enforcement, mutation persistence after each call, corrupt-file fallback to empty registry (logged to stderr, no crash), 0o600 mode on write.

- **`session-manager.test.ts`** (modified) — `resume(webSessionId)` for Claude spawns with `--resume <claudeSessionId>` and `cwd: projectPath`; Codex resume flips alive=true without spawn; resume-failed propagates spawn-exit-nonzero stderr; resume against non-existent projectPath rejects with typed error; concurrent-resume dedup returns same promise.

- **`ws-protocol.test.ts`** (modified) — `list_history` → `history_list` reply; `resume_session` happy path → `session_resumed`; `resume_session` with bad payload → `error: invalid_request`; new error code `'resume_failed'` is preserved across the wire.

### Web unit tests

`apps/web/src/`:

- **`historyStore.test.ts`** — `fetch()` sends `list_history`; reply populates store; 60 s dedupe; loading flag toggles.
- **`HistoryPanel.test.tsx`** — empty state placeholder per tab; renders 50 rows max; tab switching preserves scroll; row click calls `resumeFromHistory(entry)`; relative-time formatting.
- **`ResumePrompt.test.tsx`** — renders only when `!alive`; click `[Resume]` calls `resume(webSessionId)`; on `session_resumed` reply, prompt unmounts.
- **`sessions.test.ts`** (modified) — `error: session_dead` flips `alive: false` (NOT pushed to global errors); other error codes still route to global; `resume()` and `resumeFromHistory()` actions send correct WS payloads and update local state on reply.
- **`Session.test.tsx`** (modified) — dead + transcript-yielded-events → `<ResumePrompt />` rendered, no global banner; dead + 0 events → "transcript unavailable" inline notice; auto-prompt-on-send: send while dead → prompt + queue; on resume success → flush.

### Manual e2e smoke

Operator:

1. Boot bridge with old transcripts + native CLI history already on disk.
2. Open History panel → confirm both Claude + Codex tabs populated; rows show project + first-prompt preview + relative time. Tooltip shows full path + ISO timestamp.
3. Click Claude history row from a different project → routes to `/session/<new-id>`; chat shows replayed turns; input box live; send a message → Claude continues conversation in original cwd.
4. Click Codex history row → similar; Codex resumes via `codex exec resume`.
5. Open an existing live session, kill bridge, restart bridge, reload web → session shows as dead, transcript replayed silently (no error banner), `[Resume]` button visible. Click → spawns Claude with `--resume`; chat continues.
6. Send message into a dead session WITHOUT clicking Resume → inline auto-prompt with "Resume + send" CTA. Click → resume + first message flushes; subsequent typed messages stay queued in input.
7. Manually delete a history row's JSONL file from disk; click Resume on that row in the UI → clean inline error notice; history list auto-refreshes.
8. Verify resume against now-non-existent `projectPath` (move/rename the project folder) → clean inline error notice.
9. DevTools console — zero CSP violations, zero React errors during normal use.

## 11. Environment

No new environment variables. No new config files. Reuses:

- `BRIDGE_ALLOWED_DIRS` (Phase 3) — gates history scan + resume project path.
- `BRIDGE_TOKEN`, Tailscale IP bind (Phase 1) — unchanged auth.
- `~/.claude/` and `~/.codex/` — read-only access to native CLI history dirs (no writes).
- `.bridge/sessions.json` — new persistent registry file, project-local, 0o600.
- `.bridge/transcripts/*.jsonl` — existing transcript files (Phase 2), unchanged.

## 12. Open Items Deferred to Implementation

- Exact relative-time formatter ("2h ago" vs "2 hours ago"): pick at impl time; no `date-fns` dep churn unless already a transitive dependency.
- Whether `HistoryPanel`'s 60 s cache should invalidate on bridge restart event (e.g., a fresh WS connection). Current design: 60 s wall-clock TTL; reload-on-fresh-connection is a nice-to-have.
- Whether to show CLI version in the row tooltip (Codex's `cli_version` field is available; Claude's isn't always). Defer.
- Whether to surface failed-to-resume entries in a "Recently failed" sublist. Defer until the use-case appears.

## 13. Implementation Phasing

The Phase 5 plan (separate doc under `docs/superpowers/plans/`) breaks into ~13-15 tasks following the same TDD cadence as Phases 1-4:

1. Protocol type additions (bridge + web byte-identical types)
2. `session-registry.ts` + tests (disk persistence)
3. `history-scanner.ts` + tests (scanClaude + scanCodex + cache)
4. WS handlers: `list_history` + `resume_session` + tests
5. `SessionManager.resume(webSessionId)` + tests (Claude spawn-with-resume, Codex flip-alive)
6. Bridge boot wiring: registry load, scanner init
7. Web `historyStore.ts` + tests
8. `HistoryPanel.tsx` + `HistoryRow.tsx` + tests + history.css
9. Sessions.tsx integration: render `<HistoryPanel />`
10. `ResumePrompt.tsx` + tests + styling
11. Web `error: session_dead` re-routing + tests
12. Session.tsx integration: render `<ResumePrompt />`; transcript-unavailable notice
13. InputBox auto-prompt-on-send + tests
14. `resume(webSessionId)` + `resumeFromHistory(entry)` actions in sessions store + tests
15. Manual e2e smoke
