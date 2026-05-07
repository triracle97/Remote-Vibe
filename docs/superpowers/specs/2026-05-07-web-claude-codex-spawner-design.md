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
                                       claude -p                      codex (yolo)
                                       --dangerously-skip-            --json
                                       permissions                    (see §3)
                                       --output-format stream-json
                                       --input-format stream-json
                                       --include-partial-messages
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
| `index.ts` | Load env vars, resolve Tailscale IP, start HTTP+WS, serve `apps/web/dist` static bundle, expose `GET /transcripts/<sessionId>` for disk transcript fallback (auth: `bridge_session` cookie only — frontend has no JS-readable token to put in a query, and the cookie is automatically attached to same-origin XHRs). |
| `tailscale.ts` | Run `tailscale ip --4`. Return IPv4 string. Fail-closed if Tailscale not running or returns no address. `BRIDGE_BIND_HOST` env var overrides for local dev (e.g. `127.0.0.1`). |
| `websocket.ts` | Validate auth on HTTP upgrade — accept either `?token=` query OR `bridge_session` cookie, constant-time compare. Reject if `Origin` header is present and does not match `Host` (`error: origin_mismatch`, HTTP 403). Per-connection routing of message types. |
| `session.ts` | `SessionManager`: `Map<sessionId, AgentSession>`. Lifecycle (start/stop/list). Per-session in-memory event ring buffer (~1000 events) for reconnect-replay. Fan-out to all subscribed WS clients. |
| `claude-process.ts` | Spawn Claude via `child_process.spawn` with separate stdio pipes (no PTY — Claude headless print mode does not require a TTY, and a PTY would merge stdout and stderr, which we want kept apart). Argv: `zsh -li -c 'exec claude -p --dangerously-skip-permissions --output-format stream-json --input-format stream-json --include-partial-messages --verbose'` (per Claude Code SDK headless docs at `https://docs.claude.com/en/docs/claude-code/sdk/sdk-headless`). cwd = validated `projectPath`. Write NDJSON to stdin, parse NDJSON line-by-line from stdout, retain a rolling tail (~4 KB) of stderr for crash diagnostics. |
| `codex-process.ts` | Spawn Codex via `child_process.spawn` with separate stdio pipes, same strategy as Claude. Argv: `zsh -li -c 'exec codex exec --json --dangerously-bypass-approvals-and-sandbox <prompt-stdin-flag>'`; the exact YOLO flag set is verified against the locally installed `codex --help` at implementation time and pinned with a comment referencing the Codex version. |
| `parser.ts` | Parse Claude and Codex stream JSON into a unified internal event shape (`assistant`, `stream_delta`, `tool_result`, `result`, etc.). |
| `fs-api.ts` | `list_dirs(path)`, `read_tree(path, depth)`, `read_file(path)`. Every input path is `realpath`-resolved and checked against `BRIDGE_ALLOWED_DIRS`. Symlink escapes rejected. Hard denylist for `.ssh`, `.aws`, `.gnupg`, `.config/keys`. File reads capped at 5 MB. |
| `history-store.ts` | JSON files under `~/.config/mac-remote-terminal/`: `prompts.json` (rolling, deduped by hash, capped at last 500), `transcripts/<sessionId>.jsonl` (append-only event log). |
| `image-store.ts` | Receive base64 images from WS. Cap: 10 MB per image, 4 images per message. MIME allowlist: `image/png`, `image/jpeg`, `image/webp`, `image/gif` (anything else → `error: image_too_large` with reason). Write to `~/.config/mac-remote-terminal/images/<sessionId>/` for audit / debug. **Claude sessions:** base64 is embedded directly in the agent stream-json `content` block (no on-disk handle passed to the agent). **Codex sessions:** images are not supported in MVP — bridge replies `error: images_not_supported_for_agent` and drops the input. Per-session temp dir cleared on session stop. |

### Web

| Area | Responsibility |
|---|---|
| `services/bridge-client.ts` | WebSocket wrapper. Reconnect with exponential backoff. On reconnect, send `get_history { sessionId, since: lastSeq }` per session. Request/response correlation by `correlationId`. |
| `store/sessions.ts` | Zustand store: session list, active sessionId, per-session event log, status (`idle` / `running`). |
| `store/connection.ts` | Bridge URL (relative — `new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)`), connection state, last-error. **No token in JS state** — auth is the same-origin `bridge_session` cookie that the browser attaches to the WS upgrade automatically (cookie was set during HTTP bootstrap; see §6). |
| `features/session-list/` | Sidebar grouped by agent + project. "+ New session" button. |
| `features/chat/` | Message list with bubbles (assistant text, user, tool-use rendered collapsed). Input box with image-paste, prompt-history dropdown, stop button. Plain-text rendering only — no Markdown. |
| `features/project-picker/` | Modal: pinned recent projects (last 10) plus tree browser rooted at allowlist directories. |
| `features/file-explorer/` | Right-side drawer. Tree of current session's project. Click to preview text; binaries show metadata only. |
| `features/prompt-history/` | Searchable dropdown above input. Recall and edit before send. |
| `features/image-attach/` | Paste/drag-drop handler. Thumbnail strip in input row. Sends as base64 in `input` message. |
| `pages/Home.tsx`, `pages/Session.tsx` | Routing scaffold. |

## 4. WebSocket Protocol

Forked and trimmed from ccpocket. Token check happens once at WebSocket upgrade (token sourced from either a `?token=` query parameter OR the `bridge_session` cookie set during the HTTP bootstrap — see §6 for the bootstrap flow). All message types are accepted on an authed connection. Every WebSocket upgrade also rejects the request with HTTP 403 (`error: origin_mismatch`) when the `Origin` header is present and does not match the server's expected `Host`, defeating cross-site WebSocket hijacking from a malicious page that the operator might visit while logged in.

### Client → Server

| Type | Fields | Purpose |
|---|---|---|
| `start` | `agent: "claude" \| "codex"`, `projectPath`, `sessionId?`, `resume?: boolean` | Spawn new session, or resume an alive session by id. |
| `input` | `sessionId`, `text`, `images?: [{mime, base64}]` (Claude only — see §5) | Send user message to agent stdin. |
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
| `system` | `event: "init" \| "session_created" \| "session_ended"`, `sessionId?`, `seq?`, `reason?`, `exitCode?` | Lifecycle. Session-scoped lifecycle events (`session_created`, `session_ended`) carry a `sessionId` AND a `seq`, and are written to that session's ring buffer and disk transcript so reconnect replay reproduces them. The connection-level `init` event has no `sessionId` and no `seq`. |
| `assistant` | `sessionId`, `seq`, `content` (text + tool_use blocks) | Agent response chunk. |
| `stream_delta` | `sessionId`, `seq`, `delta` | Streaming text fragment. |
| `tool_result` | `sessionId`, `seq`, `toolName`, `output` | Tool execution result (display only). |
| `result` | `sessionId`, `seq`, `cost?`, `durationMs?` | Final turn result. |
| `status` | `sessionId`, `seq`, `status: "idle" \| "running"` | Session run state. (No `waiting_approval` — YOLO.) |
| `session_list` | `sessions: [...]` | Response to `list_sessions`. |
| `history` | `sessionId`, `events: [...]`, `hasMore` | Response to `get_history`. |
| `dirs_result` / `tree_result` / `file_result` / `prompts_result` | … | Responses to FS / prompt queries. |
| `error` | `code`, `message`, `correlationId?` | Failures. Codes include `not_authorized`, `origin_mismatch`, `path_outside_allowlist`, `session_dead`, `agent_not_installed`, `image_too_large`, `images_not_supported_for_agent`, `message_too_large`, `history_truncated`, `unsupported_message`. |

Every per-session event — assistant chunks, stream deltas, tool results, results, status changes, AND session-scoped `system` lifecycle events (`session_created`, `session_ended`) — carries a monotonic `seq`. The connection-level `init` event is not session-scoped and has no `seq`. On reconnect: client sends `get_history { sessionId, since: lastSeq }`. Server replays missing events from the in-memory buffer, then live stream resumes. If the gap exceeds the buffer cap (~1000), server returns `error: history_truncated`; client falls back to fetching the disk transcript via `GET /transcripts/<sessionId>` (authed by the same `bridge_session` cookie as the bundle — no JS-readable token needed). The response is the raw append-only JSONL transcript file as `application/x-ndjson`.

## 5. Data Flow

### Spawn

1. Browser sends `start { agent, projectPath }`.
2. Bridge `websocket.ts` calls `SessionManager.create()`.
3. Manager validates `realpath(projectPath)` is inside `BRIDGE_ALLOWED_DIRS` — otherwise `error: path_outside_allowlist`.
4. Manager generates a UUID `sessionId`, calls `claude-process.spawn(projectPath)` or `codex-process.spawn(projectPath)`.
5. Spawn uses `child_process.spawn` with `stdio: ["pipe", "pipe", "pipe"]`: `spawn("zsh", ["-li", "-c", "exec <agent> <flags>"], { cwd: projectPath, env: process.env })`. No PTY — Claude in `-p` print mode and Codex `exec --json` are non-interactive and produce structured NDJSON suitable for piped stdout. Bridge reads stdout line-by-line as NDJSON and keeps stderr separate for crash diagnostics (rolling 4 KB tail).
6. Bridge emits `system { event: "session_created", sessionId, seq: <next-seq-for-session> }` to all WS clients (the `seq` is allocated from the new session's monotonic counter), appends the same event to the ring buffer and to `transcripts/<sessionId>.jsonl`. Likewise, on agent self-exit or `stop_session`, bridge emits `system { event: "session_ended", sessionId, seq, reason, exitCode }` and appends.

### Input

1. Browser sends `input { sessionId, text, images? }`.
2. If images present:
   - **Claude session:** bridge validates each image against the MIME allowlist and size cap, writes the base64 payload to `images/<sessionId>/<uuid>.<ext>` (audit copy), and builds a stream-json `user` message with `content: [{type:"text", text}, {type:"image", source:{type:"base64", media_type:"image/<png|jpeg|webp|gif>", data:"<base64>"}}, ...]` per the Anthropic Messages API content-block schema.
   - **Codex session:** image input is not implemented in MVP. Bridge replies `error: images_not_supported_for_agent` and drops the message; the frontend disables the image-paste affordance for Codex sessions. Future phase: investigate Codex CLI image support and add a Codex-specific encoder.
3. Bridge writes one NDJSON line to the agent stdin.
4. Agent streams JSON output → `parser.ts` → unified events → fan out (all WS clients + ring buffer + transcript JSONL).
5. Text part of the prompt is written to `prompts.json` (deduped by hash, capped at last 500).

### Reconnect

1. Browser opens WS to a relative path (`/ws`); the same-origin `bridge_session` cookie is auto-attached. Server validates cookie + Origin, accepts upgrade, replies `system { event: "init" }`.
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
- Token check at WebSocket upgrade and on every static HTTP request.
- Constant-time comparison via `crypto.timingSafeEqual`.

#### Token bootstrap (resolves the chicken-and-egg of an authed React bundle)

The React bundle itself is gated, so the first browser hit cannot be a plain `/` load. The bootstrap is explicit:

1. **First visit:** user opens `http://<tailscale-ip>:8765/?token=<TOKEN>`. Server validates the token, sets the cookie below, then HTTP 302 redirects to `/` so the token does not linger in browser history beyond the first hit.
2. **Cookie:** `bridge_session=<token>; HttpOnly; SameSite=Strict; Path=/`. Cookie value equals the token (single-token model — no separate session id needed). The `Secure` flag is intentionally omitted because Tailscale-internal HTTP has no TLS; this is acceptable since `SameSite=Strict` blocks cross-origin sends and Tailscale (WireGuard) provides transport encryption.
3. **Subsequent loads:** browser sends the cookie automatically; server validates and serves the bundle. No JS-readable token; XSS in the bundle cannot exfiltrate it via `document.cookie`.
4. **No-cookie + no-token request:** server replies HTTP 401 with a static one-line HTML body: `Token required. Append ?token=<TOKEN> to the URL.` No login form, no JS, no auto-redirect (avoids open-redirect / token-replay surface).
5. **WebSocket upgrade:** auth accepts EITHER the `?token=` query OR the `bridge_session` cookie. Same constant-time compare.

#### Cross-site request defenses

- **Origin / Host validation:** every WebSocket upgrade is rejected with HTTP 403 (`error: origin_mismatch`) when an `Origin` header is present and does not match the server `Host`. Cookie-bearing HTTP requests apply the same check. Pure `?token=` query requests without cookies skip the Origin check (they are explicitly user-initiated and the URL itself is the credential).
- **CSRF on cookie-only WS:** `SameSite=Strict` blocks cross-site cookie attachment, so a malicious page the operator visits cannot establish an authed WebSocket against the bridge by cookie alone. To construct a valid `?token=` URL the attacker would need to already know the token, which already implies full compromise.
- **No `localStorage` / no JS-readable token:** token lives only in the HttpOnly cookie. Frontend code holds no token reference, reducing XSS exfiltration risk.

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
| Agent crashes mid-session | Capture exit code and the rolling stderr tail. Send `system { event: "session_ended", sessionId, seq, reason, exitCode }` (allocated from the session's monotonic counter, persisted to ring buffer + transcript). Mark session dead. Transcript persists on disk. |
| Malformed JSON line from agent stdout | Skip line, log to bridge stderr, continue. Don't crash session. |
| stdin write fails (broken pipe) | Mark session dead and surface to client. |
| Path outside allowlist | `error: path_outside_allowlist`, no spawn. |
| WS message > 16 MB | Drop, send `error: message_too_large`. |
| Image > 10 MB | `error: image_too_large`. |
| Replay buffer overflow | `error: history_truncated`; client falls back to disk transcript via `GET /transcripts/<sessionId>` (cookie-authed, returns `application/x-ndjson`). |
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
- Lightweight Playwright smoke test: load `/?token=<TOKEN>`, expect HTTP 302 to `/` with `bridge_session` cookie set, then assert the bundle loads and `list_sessions` succeeds over WS using the cookie. Full E2E gated by env.

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
