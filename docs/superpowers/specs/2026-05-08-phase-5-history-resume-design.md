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
│       └─ Codex:  flip alive=true; spawn-per-turn handles rest         │
│                                                                       │
│ ws-server (handlers added)                                            │
│   ├─ list_history → scanner (60s in-memory cache) → history_list     │
│   └─ resume_session → SessionManager.resume() → session_resumed      │
└──────────────────────────────────────────────────────────────────────┘
```

### Resume model

Two paths converge into the same `resume(webSessionId)` action:

1. **Resume a bridge-known dead session** (existing webSessionId in registry):
   - Web sends `resume_session { webSessionId, ... }`.
   - Bridge looks up registry entry, spawns CLI, marks alive.
   - Reply: `session_resumed { webSessionId, alive: true }`.
   - Web flips local alive flag; ResumePrompt unmounts; input box becomes active.

2. **Resume a never-seen native CLI session from the History panel**:
   - Web sends `resume_session { agent, sessionId, projectPath, account?, /* no webSessionId */ }`.
   - Bridge issues a NEW webSessionId, persists it to registry with `cliSessionId = sessionId`, then spawns CLI.
   - Reply: `session_resumed { webSessionId, alive: true }`.
   - Web routes to `/session/<webSessionId>`.

The same web sessionId is preserved across resumes for path #1 — URL stays stable, transcript JSONL appends, reload-replay continues to work.

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

Atomic write: `tmp` file + `rename`. On boot, bridge loads the file, populates `sessions` map with `alive: false`, and waits for resume actions or new spawns.

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
  projectPath: string;      // ground-truth cwd extracted from file content; falls back to dir-decode
  mtime: number;            // ms since epoch
  firstPrompt: string;      // first user message text, truncated to 80 chars
}

interface ServerSessionResumedMsg {
  type: 'session_resumed';
  webSessionId: string;
  alive: true;
  correlationId: string;
}

// Resume failure (typed error)
interface ServerErrorMsg {
  type: 'error';
  code: 'resume_failed' | /* existing codes... */;
  message: string;
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

### `scanClaude`

1. List `~/.claude/projects/*` directories (each name is an encoded cwd: `/` → `-`).
2. Best-effort decode dir name (`-Volumes-WDSSD-Code-foo` → `/Volumes/WDSSD/Code/foo`); accept ambiguity for paths with `-` in segments.
3. Filter: keep only dirs whose decoded path is inside one of `BRIDGE_ALLOWED_DIRS` (using realpath + same denylist gates as Phase 3 fs-api).
4. List `*.jsonl` files inside each kept dir; collect `{ filePath, mtime }` via `stat`.
5. Cap candidate set at 200 total; sort by mtime desc; take top 50.
6. For each top-50 entry: read first ~4 KB of the file. Parse line-by-line until a user message is found; extract its `cwd` (ground truth) and first text content (truncated to 80 chars).
7. Re-validate ground-truth `cwd` against allowlist (drop entry if it now fails).
8. Return `[{ agent: 'claude', sessionId: filename without .jsonl, projectPath, mtime, firstPrompt }]`.

### `scanCodex`

1. Walk `~/.codex/sessions/<YYYY>/<MM>/<DD>/*.jsonl` (3-level glob). Cap candidates at 200.
2. Sort by mtime desc, take top 50.
3. For each: read first line — Codex's `session_meta` event has `payload.id` (sessionId), `payload.cwd` (project path), `payload.originator` (informational), `payload.git` (informational).
4. Filter out entries whose `cwd` isn't inside allowlist.
5. Bounded forward-scan (~16 KB) for first user message; truncate text to 80 chars. If none, `firstPrompt = ''`.
6. Return `[{ agent: 'codex', sessionId: payload.id, projectPath: payload.cwd, mtime, firstPrompt }]`.

### Performance budget

- 200 stat calls + 100 partial-file reads (4-16 KB each) per call.
- Target <100 ms cold-cache on a typical SSD-backed home dir.
- Bridge caches the `history_list` reply in-memory for 60 s to dedupe rapid reloads. Cache key is "everything" (no per-arg variation since args are static).

### Path-decoding ambiguity

Claude encodes `/` as `-` in dir names — irreversible when path segments contain literal `-`. Mitigation order:

1. Prefer `cwd` from the file's user-message events (ground truth).
2. Fall back to the dir-decoded path (still used for the allowlist pre-filter — false positives mean we read a file we'd reject after parsing; safe).

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
| `claude --resume <id>` rejected by Claude (id missing from local cache) | Bridge captures stderr; replies `error: resume_failed, message: "Claude does not recognize session <id>"`. Web shows inline "Session unavailable — [Open new session in this folder]". |
| `codex exec resume <id>` rejected | Same shape; bridge surfaces stderr verbatim. |
| `projectPath` no longer exists | Bridge stat-checks before spawn. Missing → `resume_failed: "Project path no longer exists: <path>"`. Inline "[Open new session]" CTA. |
| `projectPath` outside `BRIDGE_ALLOWED_DIRS` (allowlist tightened since session was created) | `resume_failed: "Project path is not in BRIDGE_ALLOWED_DIRS"`. Same inline path. |
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

- **Allowlist enforcement**: history scanner filters every entry through `BRIDGE_ALLOWED_DIRS` + Phase 3 denylist (DENIED_PATH_SEGMENTS, DENIED_SEGMENT_RUNS, DENIED_BASENAMES_CI, DENIED_BASENAME_PATTERNS). Both directory pre-filter AND post-parse ground-truth cwd are checked. No leak of paths outside allowlist.
- **Spawn arguments**: Claude session id is a uuid (validated `[0-9a-f-]{36}` regex before passing to `--resume`). Codex session id is similarly validated. Project path is realpath'd and re-checked against allowlist before being passed as `cwd:`. No shell metacharacters reach `spawn()` — `child_process.spawn(cmd, args, { cwd })` doesn't invoke a shell.
- **Registry file**: `.bridge/sessions.json` written with `0o600` mode (owner-only). Located inside `.bridge/` which is project-local and `.gitignore`d.
- **No new env vars**, no new endpoints beyond the two WS message types, no new exfiltration surface.
- **History scan does NOT read message content beyond the first user-message text (truncated to 80 chars).** Other event types are ignored. No tool-output, no assistant-text, no file content leaks into history rows.

## 10. Testing

### Bridge unit tests

`packages/bridge/src/__tests__/`:

- **`history-scanner.test.ts`** — mocked tmpdir with synthetic Claude + Codex layouts:
  - Top-50 cap holds across a 100-file dir
  - Sort by mtime desc verified
  - Allowlist filter: entry under disallowed cwd is dropped (both pre-filter and post-parse ground-truth check)
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
