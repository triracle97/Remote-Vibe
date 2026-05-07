# Phase 3 — File Explorer + Image Attach + Hardening — Design

**Date:** 2026-05-07
**Status:** Drafted (pre codex review)
**Builds on:** Phase 1 (`docs/superpowers/specs/2026-05-07-web-claude-codex-spawner-design.md`) and Phase 2 (`docs/superpowers/specs/2026-05-07-phase-2-codex-and-durability-design.md`).

## 1. Goals

Close out the original web Claude/Codex spawner spec by delivering the three remaining streams in a single phase:

- **File explorer** — right-side collapsible drawer in `Session.tsx`. Pure-lazy directory tree (one `list_dirs` round-trip per expand). Click-a-file preview rendered as plain `<pre>` (no syntax highlighting). 5 MB read cap. Binary files render metadata only.
- **Image attach** — Claude sessions only. Three entry points in `InputBox`: clipboard paste, drag-drop into the chat area, and an explicit 📎 button. Thumbnail strip above the textarea. Bridge embeds base64 in the Anthropic stream-json `content` blocks. Codex sessions reject with `images_not_supported_for_agent` and the UI hides the affordances.
- **Hardening** — FS denylist enforced inside the new `fs-api.ts` (so the file explorer cannot expose `.ssh`/`.aws`/`.gnupg`/key files) and a CSP / Permissions-Policy tightening pass on `http-server.ts`.

After Phase 3, every feature in the original spec is shipped.

## 2. Non-Goals

- Syntax highlighting in the file preview. (Cut for bundle size; can revisit later.)
- File write / delete / rename / create. Read-only explorer only.
- Codex image input. Codex CLI does not have a confirmed image-input format on `0.128.0`; deferred.
- Markdown rendering in chat (cut from spec entirely).
- Playwright E2E in CI. No CI is configured yet; revisit when one exists.
- Idle-session reaping. Single-operator + explicit Stop button covers it.
- A separate audit log. Transcript JSONL already records every agent event.

## 3. Architecture Diff vs. Phase 2

```
existing (Phases 1 & 2):                              new in Phase 3:

bridge ─ websocket.ts ─ session.ts                    ┌─ fs-api.ts (allowlist + denylist read API)
                       ├─ claude-process.ts           ├─ image-store.ts (validate + audit copy)
                       ├─ codex-process.ts            └─ http-server.ts CSP polish (in-place)
                       ├─ transcript-store.ts
                       ├─ prompt-store.ts
                       └─ accounts.ts

apps/web ─ pages/Session.tsx                          ├─ store/file-explorer.ts (Zustand)
          ├─ Chat.tsx                                 ├─ features/file-explorer/
          ├─ InputBox.tsx                             │   ├─ FileExplorer.tsx
          └─ ProjectPicker.tsx                        │   ├─ FilePreview.tsx
                                                      │   └─ FileExplorer.css
                                                      └─ features/image-attach/
                                                          ├─ ImageThumbnails.tsx
                                                          └─ useImagePaste.ts
```

Boundaries:
- `fs-api.ts` is the single source of FS truth. Every client-driven file/directory read funnels through it. The denylist lives there once — not duplicated in `image-store.ts` or `transcript-store.ts` (those write to `BRIDGE_DATA_DIR`, not project paths).
- `image-store.ts` is agent-aware: bridge rejects images on Codex sessions; web disables affordances when the active session is Codex.
- File explorer is read-only. Future write surfaces are explicit non-goals.

## 4. WebSocket Protocol Diff

### Client → Server (new)

| Type | Fields | Purpose |
|---|---|---|
| `list_dirs` | `path: string`, `correlationId?` | List immediate children of a directory. |
| `read_file` | `path: string`, `correlationId?` | Read a file's text content (size-capped). |

`read_tree` from the original Phase 1 spec is dropped — pure-lazy expansion makes a recursive read unnecessary.

### Client → Server (changed)

| Type | Diff |
|---|---|
| `input` | The optional `images?: [{mime: string, base64: string}]` field is now actually populated by the web client. Bridge enforces: at most 4 images, each ≤ 10 MB, MIME ∈ `{ image/png, image/jpeg, image/webp, image/gif }`, and session.agent must be `claude`. |

### Server → Client (new)

| Type | Fields | Purpose |
|---|---|---|
| `dirs_result` | `path: string`, `entries: Array<{name: string, kind: 'dir' \| 'file', size?: number}>`, `correlationId?` | Reply to `list_dirs`. Sorted: directories first, then files; both case-insensitive by name. |
| `file_result` | discriminated by `kind`: `'text'` carries `content: string`, `bytesRead: number`, `truncated: boolean`; `'binary'` carries `mime?: string`, `size: number`; `'too_large'` carries `size: number`. Plus `path: string`, `correlationId?`. | Reply to `read_file`. |

### Server → Client (changed)

| Type | Diff |
|---|---|
| `error.code` | Adds `path_denied`, `image_too_large`, `image_invalid_mime`, `too_many_images`. (`images_not_supported_for_agent` already exists in the Phase 2 protocol — Phase 3 actually emits it.) |

`ServerErrorMsg.sessionId` policy: image-validation errors (`images_not_supported_for_agent`, `image_too_large`, `image_invalid_mime`, `too_many_images`) carry both `correlationId` AND `sessionId` (they're tied to a specific session's `input`). FS errors (`path_outside_allowlist`, `path_denied`) carry only `correlationId` — they're tied to a specific list/read request, not a session.

`AgentKind`, lifecycle events, account schema, and prompt-history protocol are all unchanged.

## 5. Components

### Bridge — new files

| File | Responsibility |
|---|---|
| `fs-api.ts` | `class FsApi`. Constructor takes `{ allowedDirs: string[] }`. Exposes `async listDirs(path: string): Promise<Array<DirEntry>>` and `async readFile(path: string, sizeCap: number): Promise<FileResult>`. Both methods `realpath`-resolve the input, verify the resolved path is inside one of the allowed dirs, and verify the resolved path does not match the FS denylist. The denylist is a module-level constant (segments + basenames + glob basenames). Sort policy: dirs-first, name asc case-insensitive. Binary detection: read first 8 KB, scan for null bytes or > 5 % non-UTF8/non-printable bytes; if hit, return `{kind: 'binary', mime, size}` without reading the body. `mime` is best-guess from the file extension. Reads cap at `sizeCap` (5 MB by default); on overrun, returns `{kind: 'too_large', size}`. ENOENT and EACCES are mapped to `path_outside_allowlist` so the bridge does not leak existence. |
| `image-store.ts` | `class ImageStore`. Constructor takes `{ dataDir: string }`. Exposes `validate(images, agent): { ok: boolean; error?: ServerErrorCode }` (4-image cap, MIME allowlist, 10 MB per image, codex rejects), `async writeAuditCopy(sessionId, images): Promise<void>` (writes each image to `${dataDir}/images/<sessionId>/<uuid>.<ext>` mode 0700; best-effort — failure logs and continues), and `async cleanup(sessionId): Promise<void>` (removes the per-session dir on `session_ended`). |

### Bridge — modified files

| File | Change |
|---|---|
| `types.ts` | Add `ClientListDirsMsg`, `ClientReadFileMsg`. Add `ServerDirsResultMsg` and a discriminated `ServerFileResultMsg = ServerFileResultText \| ServerFileResultBinary \| ServerFileResultTooLarge`. Add `ServerErrorCode` members `path_denied`, `image_too_large`, `image_invalid_mime`, `too_many_images`. |
| `websocket.ts` | New routes: `list_dirs` → `fsApi.listDirs(path)` → `dirs_result`, errors mapped to typed `error` messages with `correlationId`. `read_file` → `fsApi.readFile(path, READ_FILE_BYTE_CAP)` → `file_result`. The existing `input` route invokes `imageStore.validate(images, session.agent)` before forwarding text + images to the agent driver; on failure, replies with a typed `error` carrying both `correlationId` and `sessionId`. `AttachWsOpts` gains `fsApi` and `imageStore`. The `MAX_MSG_BYTES` constant is bumped from 16 MB to 64 MB to leave headroom for the 4×10 MB image batch base64-encoded form (~52 MB after Base64 expansion). |
| `session.ts` | `SessionManagerOpts` gains `imageStore?: ImageStore`. `sendInput(sessionId, text, images?)` (signature gains optional `images`). When `images` is provided, the validated batch is forwarded to the driver via `proc.sendUserText(text, images)`. After the user-event broadcast (Phase 1 behavior), if `images` is present, calls `imageStore.writeAuditCopy(sessionId, images)`. `onProcExit` calls `imageStore.cleanup(sessionId)` alongside `transcriptStore.close`. |
| `claude-process.ts` | `sendUserText(text)` becomes `sendUserText(text, images?)`. When images are provided, the stream-json `user` message is built as `content: [{type:'text', text}, ...images.map(i => ({type:'image', source:{type:'base64', media_type: i.mime, data: i.base64}}))]`. `ClaudeProcessEvents`/`AgentDriver` interface signature updated accordingly; `CodexProcess.sendUserText` ignores images (codex sessions never receive them — gated at SessionManager). |
| `http-server.ts` | `SECURITY_HEADERS` updated. New CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'`. New `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`. The previous CSP that allowed `ws:` / `wss:` in `connect-src` is dropped — same-origin WebSocket does not need it. |
| `index.ts` | Constructs `FsApi(allowedDirs)` and `ImageStore({ dataDir })`. Passes `imageStore` into `SessionManager`. Passes `fsApi` and `imageStore` into `attachWebSocket`. |

### Web — new files

| File | Responsibility |
|---|---|
| `store/file-explorer.ts` | Zustand store. State: `dirs: Record<string, Entry[]>` (cache keyed by path), `expanded: Record<string, boolean>`, `loadingPaths: Record<string, boolean>`, `selectedFile: { path: string; state: 'loading' \| 'text' \| 'binary' \| 'too_large'; ... }`, `pendingDirRequests: Record<string, string>` (correlationId → path). Actions: `requestDirs(client, path)`, `applyDirsResult(msg)`, `requestFile(client, path)`, `applyFileResult(msg)`, `toggleExpand(path)`, `selectFile(path)`, `reset()` (when switching session). |
| `features/file-explorer/FileExplorer.tsx` | Right-side drawer. Header with project root path + "refresh" + close buttons. Body: tree rooted at session.projectPath. Each row a `<button>` with caret + name + (for files) human-readable size. Click dir = toggle expand (lazy fetch on first expand). Click file = `selectFile`. |
| `features/file-explorer/FilePreview.tsx` | Below tree (or right of tree on wide drawer). Renders: `<pre>` for `text`, "binary file ({size} bytes, {mime})" for `binary`, "file too large ({size} / 5 MB max)" for `too_large`, spinner for `loading`. |
| `features/file-explorer/FileExplorer.css` | Drawer + tree + preview styling. Dark theme matching existing chat. |
| `features/image-attach/ImageThumbnails.tsx` | Strip rendered above InputBox. Each thumbnail shows the image (`object-fit: cover`, fixed 64px square), filename caption, size, and an x-button (`onRemove(id)`). |
| `features/image-attach/useImagePaste.ts` | Hook attached to a target ref. Listens for `paste`, `dragover`, `drop` on the ref. Validates each File client-side (MIME allowlist + 10 MB + at most 4 total). Returns `{images, addImageFromFile(file), addImageFromClipboard(blob), removeImage(id), clear(), error: string | null}`. base64-encodes via `FileReader.readAsDataURL` (strip the `data:...,` prefix). |

### Web — modified files

| File | Change |
|---|---|
| `types/protocol.ts` | Mirror `packages/bridge/src/types.ts` byte-for-byte (new messages + error codes). |
| `pages/Session.tsx` | Mounts `FileExplorer` drawer in a flexbox layout (chat fills, drawer slides in from right). Adds drawer-toggle button (📁 icon) to the chat header. Local `useState` for `drawerOpen`. Resets file-explorer store on `id` change. |
| `features/chat/InputBox.tsx` | Mounts `ImageThumbnails` strip + 📎 button. Wires `useImagePaste` hook attached to the textarea ref. On Send, includes `images` in `client.send({type:'input', ...})`. The 📎 button opens a hidden file `<input type="file" multiple accept="image/*">`. Image affordances disabled when `agent === 'codex'` (button greyed, paste/drop ignored, tooltip explains). |
| `features/chat/Chat.tsx` | Passes `agent` from session into InputBox so it can disable image UI on codex. Already has `session` available. |
| `App.tsx` | Routes `dirs_result` and `file_result` into `useFileExplorerStore` via the existing message handler. Adds new error-code handling: image errors get a transient toast/banner (reuse `connection.lastError` for now); FS errors `path_denied` and `path_outside_allowlist` go to the same global banner. |

## 6. Data Flow

### File explorer click-to-expand

1. User opens a session at `/session/<id>`. Clicks the 📁 toggle in the chat header. `Session.tsx` flips `drawerOpen` and mounts `FileExplorer` rooted at `session.projectPath`.
2. `FileExplorer` calls `useFileExplorerStore.requestDirs(client, projectPath)`. Store sets `loadingPaths[projectPath] = true`, generates a `correlationId`, sends `{type:'list_dirs', path: projectPath, correlationId}`.
3. Bridge `websocket.ts` `list_dirs` route → `fsApi.listDirs(path)`:
   - `realpath(path)` (rejects if errors → `path_outside_allowlist`).
   - Resolved path must equal an allowed dir or start with `<allowedDir>/`. If not → `path_outside_allowlist`.
   - Resolved path must not match any denylist segment. If it does → `path_denied`.
   - `readdir(path, { withFileTypes: true })`. Per entry: build `{name, kind, size?}` (size from `stat` for files only). Drop entries whose own resolved path hits the denylist (so a directory containing `.ssh` shows everything except `.ssh`).
   - Sort: `kind === 'dir'` first, then by `name.toLowerCase()`.
4. Bridge replies `dirs_result { path, entries, correlationId }`.
5. Web `App.tsx` routes `dirs_result` → `useFileExplorerStore.applyDirsResult(msg)`. Store caches by path, clears `loadingPaths[path]`, sets `expanded[path] = true`.
6. UI re-renders. User clicks a sub-directory → repeat from step 2 with the sub-path. Already-expanded paths render from cache without a round-trip; clicking an expanded directory collapses it (`expanded[path] = false`) — no new request.
7. The drawer's "refresh" button clears the cache for the currently-rendered subtree and re-requests the open paths.

### File preview click

1. User clicks a file row.
2. Store's `requestFile(client, path)` sends `{type:'read_file', path, correlationId}` and sets `selectedFile = { path, state: 'loading' }`.
3. Bridge `read_file` route → `fsApi.readFile(path, 5_242_880)`:
   - Same allowlist + denylist gates as `listDirs`.
   - `stat(path)`. If `stat.size > 5 MB` → return `{kind: 'too_large', size: stat.size}`.
   - Read first 8 KB → binary detection. If binary → return `{kind: 'binary', mime, size: stat.size}` (no body).
   - Else read full file as utf-8 → return `{kind: 'text', content, bytesRead: content.length, truncated: false}`.
4. Bridge replies `file_result { path, kind, ..., correlationId }`.
5. Web `applyFileResult` updates `selectedFile`. `FilePreview.tsx` renders accordingly.

### Image attach — send

1. In a Claude session, user pastes an image (or drops one, or clicks 📎 and picks files).
2. `useImagePaste` reads each File via `FileReader.readAsDataURL`, strips the `data:<mime>;base64,` prefix, and calls `addImageFromFile`. Client-side validation: MIME allowlist + ≤ 10 MB + total ≤ 4. On fail, sets `error` and does not add. The user sees the error in a tooltip on the strip.
3. `ImageThumbnails` re-renders with the new image and an x-button.
4. User types text and presses Send (or Cmd/Ctrl-Enter). `InputBox` calls `client.send({type:'input', sessionId, text, images: [{mime, base64}, ...]})`.
5. Bridge `websocket.ts` `input` route now invokes `imageStore.validate(images, session.agent)`:
   - If `session.agent !== 'claude'` → `images_not_supported_for_agent` (sessionId + correlationId).
   - If `images.length > 4` → `too_many_images` (sessionId + correlationId).
   - Per image: MIME ∈ allowlist, decoded byte length (`(base64.length * 3) / 4 - padding`) ≤ 10 MB. Fail → `image_too_large` or `image_invalid_mime`.
6. On pass: `imageStore.writeAuditCopy(sessionId, images)` writes each image to `${BRIDGE_DATA_DIR}/images/<sessionId>/<uuid>.<ext>` mode 0700. Best-effort — failure logs and does not block.
7. `mgr.sendInput(sessionId, text, images)` → `claude-process.sendUserText(text, images)` → builds the Anthropic content-blocks array → writes one NDJSON line to claude stdin.
8. SessionManager's existing user-event broadcast (Phase 1) fires with `payload: {text}` only. Image binaries do NOT travel back over the wire on every message broadcast. The chat bubble for the user message renders with the image data the InputBox kept locally (until clear-on-send). Subsequent reload-replay reconstructs the user bubble with text only and a small "📎 N attachments" badge whose payload is loaded from the audit copy if needed (deferred — not in Phase 3 scope).

### CSP polish

Pure config change to `SECURITY_HEADERS` in `http-server.ts`:
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'`.
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`.

`'self'` for `connect-src` works because the WebSocket lives on the same origin as the bundle. `data:` and `blob:` for `img-src` so client-rendered image previews work without CORS. `frame-ancestors 'none'` is redundant with the existing `X-Frame-Options: DENY` but the CSP variant is the modern equivalent and useful for browsers that prefer CSP.

## 7. Errors

| Failure | Behavior |
|---|---|
| `list_dirs` / `read_file` outside allowlist | `error: path_outside_allowlist` (correlationId only). |
| `list_dirs` / `read_file` hits denylist | `error: path_denied` (correlationId only). |
| `read_file` size > 5 MB | `file_result { kind: 'too_large', size }` — NOT an error. UI renders an in-place "too large" preview. |
| `read_file` on binary | `file_result { kind: 'binary', mime?, size }`. UI renders metadata. |
| `list_dirs` on a regular file | `error: path_outside_allowlist` (treated as invalid path). |
| `read_file` ENOENT or EACCES | `error: path_outside_allowlist` (don't leak existence). |
| Image MIME not in allowlist | `error: image_invalid_mime` (correlationId + sessionId). |
| Image > 10 MB | `error: image_too_large` (correlationId + sessionId). |
| > 4 images attached | `error: too_many_images` (correlationId + sessionId). |
| Image attached to a codex session | `error: images_not_supported_for_agent` (correlationId + sessionId). |
| `imageStore.writeAuditCopy` fails | Log warning. Do NOT block the user's message — Claude still receives the embedded base64. |

## 8. Security

### FS allowlist + denylist

Order: allowlist first, then denylist. The allowlist anchors the safe roots (`BRIDGE_ALLOWED_DIRS`); the denylist removes specific dangerous segments and basenames inside those roots.

The denylist is a module-level constant in `fs-api.ts`:

```ts
const DENIED_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.gnupg-keys',
  '.kube',
  '.netrc',
  'Library/Keychains',     // macOS
  'Library/Cookies',        // macOS
]);

const DENIED_BASENAMES: ReadonlySet<string> = new Set([
  '.netrc',
  '.docker/config.json',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  '.config/op',             // 1Password CLI session dir
]);

const DENIED_BASENAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^.+\.pem$/,
  /^.+\.key$/,
  /^.+\.p12$/,
];
```

Match rules:
- **Segment match:** any path component (split on `/`) of the resolved path equals an entry in `DENIED_PATH_SEGMENTS`. (`.ssh` segment matches `~/.ssh` and `~/code/.ssh/known_hosts`.) Entries containing `/` (like `Library/Keychains`) are matched against consecutive segments.
- **Basename match:** the resolved path's last segment equals an entry in `DENIED_BASENAMES`.
- **Glob-basename match:** the resolved path's last segment matches one of the `DENIED_BASENAME_PATTERNS` regexes.

A directory's children are individually filtered: if a child's resolved path hits the denylist, the child is dropped from the `dirs_result`.

The allowlist check uses `resolved === d || resolved.startsWith(d + '/')` — exact match or proper subpath. Symlink escapes are blocked because `realpath` resolves symlinks before the allowlist check.

### Read-only

`fs-api.ts` exports only `listDirs` and `readFile`. There is no `writeFile`, `unlink`, `mkdir`, or `rename` route. Future write support would require an explicit Phase.

### Image audit copy

`${BRIDGE_DATA_DIR}/images/<sessionId>/` is `mkdir`-ed with mode `0o700` so only the operator's UID can read it. Each image written with `0o600`. Per-session directory removed on `session_ended`. `BRIDGE_DATA_DIR` defaults under `$HOME/.config/`, which is already operator-owned.

### CSP / Permissions-Policy

The new CSP drops `ws:` / `wss:` from `connect-src` because same-origin WebSocket does not need an explicit scheme — `'self'` covers it. `'self' 'unsafe-inline'` for `style-src` is required by Vite's CSS injection at dev time (production bundle is fully external). `img-src 'self' data: blob:` allows rendered image previews without breaking same-origin assertions for fetch calls.

The new `Permissions-Policy` denies the named features outright. Because the operator might want to use voice input from their phone in a later phase, `microphone` is currently denied — relax in that phase if/when the feature ships.

### WebSocket payload cap

`MAX_MSG_BYTES` bumps from 16 MB to 64 MB. The user-driven cap (4 images × 10 MB raw = 40 MB; base64 expands ~4/3 to ~52 MB) sits comfortably under 64 MB. Direct user input of pure text is gated by the same cap, which leaves 64 MB / 4 ≈ 16 MB of typed text — still more than reasonable.

### Acknowledged risks

- The denylist is a heuristic. New secret-storing tools (e.g. an unfamiliar CLI's config dir) will pass through. The operator owns the `BRIDGE_ALLOWED_DIRS` list and is expected to scope project paths so the explorer doesn't roam into `$HOME` blindly.
- Image audit copies on disk grow without explicit cleanup beyond `session_ended`. A future hardening phase can add age-based pruning analogous to transcripts.
- Single-operator threat model is unchanged from Phases 1 and 2: Tailscale-bind + token are the entire perimeter; `--dangerously-skip-permissions` / Codex YOLO grant full shell access in `BRIDGE_ALLOWED_DIRS` once authed.

## 9. Testing

### Bridge unit tests

- `fs-api.test.ts` — happy-path `listDirs` (sorted dirs-first, files with size), denylist hits (`.ssh` segment, `id_rsa` basename, `secret.pem` glob), allowlist escape attempts (symlink → resolved path outside the allowlist), `readFile` small-text round-trip, `readFile` binary detection on a 1×1 PNG fixture, `readFile` `too_large`, ENOENT and EACCES mapped to `path_outside_allowlist`.
- `image-store.test.ts` — `validate` 4-image cap, MIME allowlist, 10 MB cap, agent gating; `writeAuditCopy` writes correct files with mode 0o600 in a 0o700 dir; `cleanup` removes the dir.
- `websocket.test.ts` (additions) — `list_dirs` happy path replies `dirs_result`; allowlist + denylist errors propagate `correlationId`. `read_file` happy path replies `file_result` with the right `kind`. `input` with codex session + `images` → `images_not_supported_for_agent`. `input` with > 4 images → `too_many_images`.
- `claude-process.test.ts` (additions) — `sendUserText('hi', images)` writes a single NDJSON line whose `content` array contains `[{type:'text', text:'hi'}, {type:'image', source:{type:'base64', media_type:'image/png', data:'...'}}]`.
- `http-server.test.ts` (additions) — CSP header asserts `connect-src 'self'`, no `ws:` / `wss:` substring; `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()` exact match.

### Web unit tests

- `file-explorer.test.ts` — store reducer: `applyDirsResult` caches keyed by path; `toggleExpand` collapses/expands; `requestFile` sets `selectedFile.state = 'loading'`; `applyFileResult` transitions to `text` / `binary` / `too_large`.
- `useImagePaste.test.tsx` — synthesised `paste` event with `image/png` ClipboardData → `addImage`; `drop` event with multiple files → one `addImage` per file; adding a 5th image returns an error and does not push; adding > 10 MB returns an error.
- `FileExplorer.test.tsx` — clicking a directory row sends `list_dirs` (mocked client); clicking a file sends `read_file`; cached directories render without an additional round-trip.

### Bridge integration (gated)

- `RUN_E2E=1` test: real `claude` spawn with image input — feed a 1×1 PNG, assert claude streams a sane response. Verifies the stream-json content-block round-trip end-to-end. Skipped in headless CI by default.

### Manual smoke

Add a single end-of-Phase-3 manual check in the plan's last task:

1. Start bridge as in Phase 2 smoke. Open browser.
2. Click 📁 in the chat header. Drawer opens. Click `node_modules/` — it expands lazily after a brief loading indicator.
3. Click a `package.json` file — preview shows JSON in `<pre>`.
4. Try to navigate into `~/.ssh` (if the project root is `$HOME`) — denied with banner. The `.ssh` row must NOT appear in the listing.
5. Click a 10 MB binary (e.g. a screenshot in `~/Downloads` if allowed) — preview shows "binary file (~ MB, image/png)".
6. In the chat InputBox, paste an image from clipboard. Thumbnail appears. Send. Claude responds referencing the image.
7. Try to attach an image to a Codex session. The 📎 button is greyed out. Paste does nothing.
8. Inspect a `Set-Cookie` response with DevTools and confirm the new CSP / Permissions-Policy headers are present.

## 10. Environment

No new environment variables. All Phase 3 features key off existing config:
- File explorer respects `BRIDGE_ALLOWED_DIRS` and the hardcoded denylist.
- Image attach uses `BRIDGE_DATA_DIR` (already used by transcripts and prompts).

## 11. Open Items Deferred to Implementation

- Whether `useImagePaste` should also accept paste of a URL string referencing an image and auto-fetch it. Likely no — adds CORS complexity and the operator can just download then drop. Skip for Phase 3; revisit if asked.
- Whether the file explorer should respect `.gitignore` by default. Not in Phase 3 — pure-lazy means the operator is in charge of where they click. Could be a UX layer in a future phase that overlays a "hide .gitignore'd" toggle.
- Whether reload-replay should reconstruct image thumbnails by reading the audit copy. Phase 3 explicitly does not — text + "📎 N attachments" badge is sufficient. Future audit-viewer feature.

## 12. Implementation Phasing

Phase 3 plan (separate doc under `docs/superpowers/plans/`) breaks into ~12 tasks, each shipping testable software:

1. Protocol type surface (bridge + web byte-identical).
2. `fs-api.ts` with allowlist + denylist + binary detection + tests.
3. `image-store.ts` with validation + audit copy + cleanup + tests.
4. WebSocket routes for `list_dirs`, `read_file`, and image-validation in `input` + tests.
5. `claude-process.sendUserText(text, images?)` extension + tests.
6. CSP + Permissions-Policy polish in `http-server.ts` + tests.
7. Boot wiring in `index.ts` (FsApi + ImageStore).
8. Web `store/file-explorer.ts` + tests.
9. Web `FileExplorer` + `FilePreview` components + drawer integration in `Session.tsx`.
10. Web `useImagePaste` hook + `ImageThumbnails` + tests.
11. Web `InputBox` 📎 button + send-with-images + agent-gating.
12. Manual e2e smoke.

Same TDD / spec-review / code-quality-review cadence per task as Phases 1 and 2.
