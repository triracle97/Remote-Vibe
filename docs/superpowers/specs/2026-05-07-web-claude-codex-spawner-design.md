# Web-based Claude / Codex Session Spawner — Design

**Date:** 2026-05-07
**Status:** Approved (brainstorming complete)
**Repo:** `/Volumes/WDSSD/Code/mac-remote-terminal`

## 1. Problem & Goals

Build a self-hosted web app that lets the user spawn and control Claude Code and OpenAI Codex CLI sessions on their Mac from any browser reachable over their Tailscale network. The UX should mirror the existing [ccpocket](https://github.com/K9i-0/ccpocket) Flutter app's chat-style interface, but live in a browser and target a single trusted operator.

Sessions run in fully autonomous mode:
- Claude Code: `--dangerously-skip-permissions`
- Codex: YOLO mode

The approval flow ccpocket centers around (mid-session permission prompts, AskUserQuestion) is intentionally bypassed.

### Non-goals

- Multi-tenant / multi-user (single token, single trusted operator).
- Mobile-native client (web is the only frontend).
- Markdown rendering in chat bubbles.
- Git diff viewer / stage / commit UI.
- Approval / permission-request UI.
- HTTPS termination (Tailscale provides transport encryption).

## 2. Architecture

```
┌──────────────────┐ ws:// (token + Tailscale-IP only) ┌──────────────────────┐
│ Browser (React)  │ ─────────────────────────────────▶│ Bridge (Node + TS)   │
│ apps/web         │ ◀─────────────────────────────────│ packages/bridge      │
└──────────────────┘   stream-json frames              └─────────┬────────────┘
                                                                 │ spawn (zsh -li -c "exec ...")
                                                    ┌────────────┴────────────┐
                                                    ▼                         ▼
                                       claude --dangerously-          codex (yolo)
                                       skip-permissions               --json
                                       --output-format stream-json
                                       --input-format stream-json
                                       --verbose
```

The bridge is a single Node.js process. It serves both the WebSocket protocol and the static built React bundle on the same Tailscale-bound port.

### Repository layout

```
mac-remote-terminal/
├── packages/bridge/          # TypeScript WebSocket server
│   └── src/
│       ├── index.ts          # boot
│       ├── tailscale.ts      # resolve & bind Tailscale IPv4
│       ├── websocket.ts      # auth + routing
│       ├── session.ts        # SessionManager
│       ├── claude-process.ts # Claude spawn + stream-json
│       ├── codex-process.ts  # Codex spawn + JSON
│       ├── parser.ts         # stream-json parsers (Claude + Codex)
│       ├── fs-api.ts         # allowlist-guarded file browser
│       ├── history-store.ts  # on-disk prompt history + transcript log
│       └── image-store.ts    # image upload temp storage
├── apps/web/                 # React + Vite + TypeScript
│   ├── src/
│   │   ├── pages/            # Home, Session
│   │   ├── features/
│   │   │   ├── session-list/
│   │   │   ├── chat/
│   │   │   ├── project-picker/
│   │   │   ├── file-explorer/
│   │   │   ├── prompt-history/
│   │   │   └── image-attach/
│   │   ├── services/bridge-client.ts
│   │   ├── store/            # Zustand (sessions, connection)
│   │   └── components/
│   └── vite.config.ts
├── ccpocket/                 # gitignored reference checkout
├── docs/superpowers/specs/
├── .gitignore
└── package.json              # npm workspaces root
```

The bridge logic is forked from ccpocket's `packages/bridge/src/` under its FSL-1.1-MIT Bridge Redistribution Exception, then trimmed: approval/AskUserQuestion paths removed, Tailscale-bind added, agent flags hardcoded to skip-permissions / YOLO.

## 3. Components

### Bridge

| File | Responsibility |
|---|---|
| `index.ts` | Load env vars, resolve Tailscale IP, start HTTP+WS, serve `apps/web/dist` static bundle, expose `GET /transcripts/<sessionId>?token=...` for disk transcript fallback. |
| `tailscale.ts` | Run `tailscale ip --4`. Return IPv4 string. Fail-closed if Tailscale not running or returns no address. `BRIDGE_BIND_HOST` env var overrides for local dev (e.g. `127.0.0.1`). |
| `websocket.ts` | Validate `?token=` on HTTP upgrade with constant-time compare. Per-connection routing of message types. |
| `session.ts` | `SessionManager`: `Map<sessionId, AgentSession>`. Lifecycle (start/stop/list). Per-session in-memory event ring buffer (~1000 events) for reconnect-replay. Fan-out to all subscribed WS clients. |
| `claude-process.ts` | Spawn Claude via `node-pty`. Argv: `zsh -li -c 'exec claude --dangerously-skip-permissions --output-format stream-json --input-format stream-json --verbose'`. cwd = validated `projectPath`. Pipe NDJSON to stdin, parse NDJSON from stdout. |
| `codex-process.ts` | Spawn Codex similarly. Exact YOLO flag confirmed against Codex CLI docs at implementation time. |
| `parser.ts` | Parse Claude and Codex stream JSON into a unified internal event shape (`assistant`, `stream_delta`, `tool_result`, `result`, etc.). |
| `fs-api.ts` | `list_dirs(path)`, `read_tree(path, depth)`, `read_file(path)`. Every input path is `realpath`-resolved and checked against `BRIDGE_ALLOWED_DIRS`. Symlink escapes rejected. Hard denylist for `.ssh`, `.aws`, `.gnupg`, `.config/keys`. File reads capped at 5 MB. |
| `history-store.ts` | JSON files under `~/.config/mac-remote-terminal/`: `prompts.json` (rolling, deduped by hash, capped at last 500), `transcripts/<sessionId>.jsonl` (append-only event log). |
| `image-store.ts` | Receive base64 image from WS. Cap: 10 MB per image, 4 images per message. Write to `~/.config/mac-remote-terminal/images/<sessionId>/`. Reference passed in stream-json `content` block. Cleared on session stop. |

### Web

| Area | Responsibility |
|---|---|
| `services/bridge-client.ts` | WebSocket wrapper. Reconnect with exponential backoff. On reconnect, send `get_history { sessionId, since: lastSeq }` per session. Request/response correlation by `correlationId`. |
| `store/sessions.ts` | Zustand store: session list, active sessionId, per-session event log, status (`idle` / `running`). |
| `store/connection.ts` | Bridge URL, token, connection state. |
| `features/session-list/` | Sidebar grouped by agent + project. "+ New session" button. |
| `features/chat/` | Message list with bubbles (assistant text, user, tool-use rendered collapsed). Input box with image-paste, prompt-history dropdown, stop button. Plain-text rendering only — no Markdown. |
| `features/project-picker/` | Modal: pinned recent projects (last 10) plus tree browser rooted at allowlist directories. |
| `features/file-explorer/` | Right-side drawer. Tree of current session's project. Click to preview text; binaries show metadata only. |
| `features/prompt-history/` | Searchable dropdown above input. Recall and edit before send. |
| `features/image-attach/` | Paste/drag-drop handler. Thumbnail strip in input row. Sends as base64 in `input` message. |
| `pages/Home.tsx`, `pages/Session.tsx` | Routing scaffold. |

## 4. WebSocket Protocol

Forked and trimmed from ccpocket. Token check happens once at WebSocket upgrade; all message types are accepted on an authed connection.

### Client → Server

| Type | Fields | Purpose |
|---|---|---|
| `start` | `agent: "claude" \| "codex"`, `projectPath`, `sessionId?`, `resume?: boolean` | Spawn new session, or resume an alive session by id. |
| `input` | `sessionId`, `text`, `images?: [{mime, base64}]` | Send user message to agent stdin. |
| `stop_session` | `sessionId` | SIGTERM agent, cleanup. |
| `list_sessions` | — | Return all alive sessions. |
| `get_history` | `sessionId`, `since?: eventSeq` | Replay buffered events on reconnect. |
| `list_dirs` | `path` | File-browser directory listing (allowlist enforced). |
| `read_tree` | `path`, `depth?` | Project tree fetch. |
| `read_file` | `path` | File preview. |
| `list_prompts` | `query?`, `limit?` | Prompt-history search. |

### Server → Client

| Type | Fields | Purpose |
|---|---|---|
| `system` | `event: "init" \| "session_created" \| "session_ended"`, `sessionId?`, `reason?`, `exitCode?` | Lifecycle. |
| `assistant` | `sessionId`, `seq`, `content` (text + tool_use blocks) | Agent response chunk. |
| `stream_delta` | `sessionId`, `seq`, `delta` | Streaming text fragment. |
| `tool_result` | `sessionId`, `seq`, `toolName`, `output` | Tool execution result (display only). |
| `result` | `sessionId`, `seq`, `cost?`, `durationMs?` | Final turn result. |
| `status` | `sessionId`, `status: "idle" \| "running"` | Session run state. (No `waiting_approval` — YOLO.) |
| `session_list` | `sessions: [...]` | Response to `list_sessions`. |
| `history` | `sessionId`, `events: [...]`, `hasMore` | Response to `get_history`. |
| `dirs_result` / `tree_result` / `file_result` / `prompts_result` | … | Responses to FS / prompt queries. |
| `error` | `code`, `message`, `correlationId?` | Failures. Codes include `not_authorized`, `path_outside_allowlist`, `session_dead`, `agent_not_installed`, `image_too_large`, `message_too_large`, `history_truncated`, `unsupported_message`. |

Every event carries a per-session monotonic `seq`. On reconnect: client sends `get_history { sessionId, since: lastSeq }`. Server replays missing events from the in-memory buffer, then live stream resumes. If the gap exceeds the buffer cap (~1000), server returns `error: history_truncated`; client falls back to fetching the disk transcript via `GET /transcripts/<sessionId>?token=...`.

## 5. Data Flow

### Spawn

1. Browser sends `start { agent, projectPath }`.
2. Bridge `websocket.ts` calls `SessionManager.create()`.
3. Manager validates `realpath(projectPath)` is inside `BRIDGE_ALLOWED_DIRS` — otherwise `error: path_outside_allowlist`.
4. Manager generates a UUID `sessionId`, calls `claude-process.spawn(projectPath)` or `codex-process.spawn(projectPath)`.
5. Spawn uses `node-pty` so the agent sees a TTY: `pty.spawn("zsh", ["-li", "-c", "exec <agent> <flags>"], { cwd: projectPath, env: process.env })`.
6. Bridge emits `system { event: "session_created", sessionId }` to all WS clients, appends to ring buffer and to `transcripts/<sessionId>.jsonl`.

### Input

1. Browser sends `input { sessionId, text, images? }`.
2. If images present: bridge writes each base64 payload to `images/<sessionId>/<uuid>.<ext>`, builds a stream-json `user` message with `content: [{type:"text", text}, {type:"image", source:{...}}, ...]`.
3. Bridge writes one NDJSON line to the agent stdin.
4. Agent streams JSON output → `parser.ts` → unified events → fan out (all WS clients + ring buffer + transcript JSONL).
5. Text part of the prompt is written to `prompts.json` (deduped by hash, capped at last 500).

### Reconnect

1. Browser opens WS with token. Server replies `system { event: "init" }`.
2. Browser fetches `list_sessions` → renders sidebar.
3. On opening a prior session: browser sends `get_history { sessionId, since: lastSeqInLocalCache }` (or 0 cold).
4. Bridge replays events from the ring buffer; live stream resumes automatically.
5. If the session is no longer alive (bridge restarted, agent exited): bridge replies `error: session_dead`. UI offers a transcript-only view from disk.

### Stop / cleanup

- Explicit `stop_session`: SIGTERM the agent → 5 s grace → SIGKILL.
- WS disconnect alone does **not** kill the session. Sessions die only on explicit stop, agent self-exit, or bridge shutdown.
- Bridge SIGTERM: SIGTERM all agents, flush transcripts, exit 0.

### Concurrency

- Multiple sessions run in parallel as separate processes with independent event streams, isolated by `sessionId`.
- Multiple browser tabs share a single token. Each WS connection is a subscriber; all tabs see all sessions. Single-user assumption holds.

## 6. Security

### Network

- Bridge resolves the Tailscale IPv4 at startup via `tailscale ip --4` and binds the HTTP listener to that address only. Not `0.0.0.0`. LAN and internet cannot reach the port.
- If Tailscale is not running or returns no IP, bridge fails closed with a clear startup error.
- Dev override: `BRIDGE_BIND_HOST=127.0.0.1` to bypass Tailscale during local development.
- No HTTPS in MVP. Tailscale (WireGuard) provides transport encryption inside the tailnet.

### Auth

- `BRIDGE_TOKEN` env var, minimum 24 chars. Bridge refuses to start otherwise. Generation: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- Token check at WebSocket upgrade and on every static HTTP request. `?token=<>` query, or cookie set after first valid hit.
- Constant-time comparison via `crypto.timingSafeEqual`.
- No login UI; single-token model. Browser persists token in cookie / `localStorage`.

### Process

- Agent argv is hardcoded in bridge source. The browser cannot influence binary path, flags, or shell interpretation.
- `cwd` (= `projectPath`) is `realpath`-resolved and checked against `BRIDGE_ALLOWED_DIRS` (default `$HOME`, comma-separated env override).
- File-browser API reuses the same allowlist enforcement.
- File reads capped at 5 MB. Binary detection returns metadata only.
- Image uploads capped at 10 MB per image, 4 images per message. Per-session temp dir cleared on session stop.
- Dotfile listing: visible by default (the operator is a developer), but a hard denylist always blocks `.ssh`, `.aws`, `.gnupg`, `.config/keys`.

### Acknowledged risks

- `--dangerously-skip-permissions` and Codex YOLO grant the agent unrestricted shell access in the operator's account. If the browser auth is bypassed, the attacker effectively gets a shell. Tailscale-bind plus token is the entire defensive perimeter. The operator accepts this trade-off explicitly.
- No rate limiting on input — single-user assumption.
- No audit log beyond per-session transcript JSONL.

### HTTP response headers

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Cross-Origin-Opener-Policy: same-origin`
- CSP allows only `'self'` (xterm and other deps bundled at build time, no CDN).

## 7. Error Handling

| Failure | Behavior |
|---|---|
| Tailscale CLI missing or no IP | Bridge logs and exits non-zero at startup. |
| `BRIDGE_TOKEN` unset or shorter than 24 chars | Bridge logs and exits non-zero. |
| Agent CLI not on PATH | Bridge probes at startup and logs a warning per missing agent. Spawn attempt returns `error: agent_not_installed`. |
| Agent crashes mid-session | Capture exit code and last stderr. Send `system { event: "session_ended", reason, exitCode }`. Mark session dead. Transcript persists on disk. |
| Malformed JSON line from agent stdout | Skip line, log to bridge stderr, continue. Don't crash session. |
| stdin write fails (broken pipe) | Mark session dead and surface to client. |
| Path outside allowlist | `error: path_outside_allowlist`, no spawn. |
| WS message > 16 MB | Drop, send `error: message_too_large`. |
| Image > 10 MB | `error: image_too_large`. |
| Replay buffer overflow | `error: history_truncated`; client falls back to disk transcript via `GET /transcripts/<id>?token=...`. |
| Browser WS disconnect | Bridge keeps session alive, expects reconnect. No idle timeout in MVP. |
| Bridge SIGTERM | SIGTERM agents → 5 s → SIGKILL → flush transcripts → exit 0. |

## 8. Testing

### Bridge (Vitest)

- `parser.ts` — feed recorded Claude and Codex stream-json fixtures, assert unified event shape.
- `session.ts` — mock spawn; assert lifecycle, ring-buffer replay, fan-out to multiple subscribers.
- `fs-api.ts` — symlink-escape attempts, denylist hits, size cap, allowlist edge cases.
- `tailscale.ts` — mock `tailscale` CLI output: success, not running, error.
- `websocket.ts` — auth (good/bad/missing token, timing), message routing, malformed payloads.
- `history-store.ts` — write/read JSONL, prompt dedup, eviction at cap.

### Bridge integration

- Real `claude` spawn end-to-end (gated by `RUN_E2E=1` env, skipped in CI without it). Drive a turn, assert events.

### Web

- Component tests (Vitest + Testing Library) for chat bubbles, session list, project picker.
- `bridge-client.ts` against a mock WS, assert reconnect/replay behavior.
- Lightweight Playwright smoke test (load `/`, paste token, list sessions). Full E2E gated by env.

### Static checks

- `tsc --noEmit` for both packages, run in CI.

### Manual verification

Before claiming the work is complete, exercise the real path:
- Spawn real `claude` and real `codex` from a real browser over Tailscale.
- Golden path: send a prompt, observe streamed assistant + tool_use → tool_result.
- Resume mid-stream: reload the browser and confirm replay matches.
- Stop: click stop and confirm session ends cleanly.

## 9. Phased Implementation Plan (high-level)

Detailed plan goes to `docs/superpowers/plans/`. Rough phasing:

- **Phase 1 — vertical slice:** workspaces scaffolding, Tailscale + token boot, single Claude session, plain chat, no images / no file explorer / no prompt history.
- **Phase 2 — multi-session + Codex:** session manager, sidebar, parallel Claude + Codex, stop button.
- **Phase 3 — durability:** transcript JSONL, prompt history persistence, reconnect replay.
- **Phase 4 — assists:** project picker, file explorer, image paste, prompt-history dropdown.
- **Phase 5 — hardening:** HTTP headers, CSP, full FS denylist, Vitest coverage, Playwright smoke.

## 10. Environment

| Variable | Default | Description |
|---|---|---|
| `BRIDGE_PORT` | `8765` | Listen port. |
| `BRIDGE_BIND_HOST` | (Tailscale IPv4) | Override bind address. Use `127.0.0.1` for local dev. |
| `BRIDGE_TOKEN` | (none, required, ≥24 chars) | Auth token. |
| `BRIDGE_ALLOWED_DIRS` | `$HOME` | Comma-separated allowlist for project paths and FS browser. |
| `BRIDGE_DATA_DIR` | `~/.config/mac-remote-terminal` | Prompts, transcripts, images. |
| `BRIDGE_TRANSCRIPT_RETENTION_DAYS` | `30` | Optional transcript pruning. |

## 11. Open Items Deferred to Implementation

- Exact Codex YOLO flag — confirm against current Codex CLI docs at implementation time.
- Whether prompt history is per-project, per-agent, or global — default to global with metadata for filtering.
- Whether to expose a "clear transcript" action — likely yes, scope to Phase 4.
