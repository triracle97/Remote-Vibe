# Phase 6 — Slash Commands + Multi-Dir Profiles + Custom @-tag + Telegram Notify

**Status:** Draft — codex review pending
**Date:** 2026-05-08
**Phases shipped:** 1, 2, 3, 4, 5

## 1. Goal

Bundle four cohesive UX improvements into one phase:

1. **Slash command autocomplete.** When the user types `/` at the start of an input line (or after a newline), a popup lists Claude/Codex slash commands and inserts the chosen one. Commands are sourced from `~/.claude/commands/*.md` (user-level), `<projectPath>/.claude/commands/*.md` (project-level), and a hardcoded list of CLI built-ins. The text passes through to the CLI verbatim — the bridge does NOT interpret slash commands itself.
2. **Multi-dir sessions + profiles.** Sessions can spawn against multiple working dirs (Claude `--add-dir` flag). Named profiles persist sets of dirs to `.bridge/profiles.json`; one per agent can be marked `default: true` and pre-fills the picker on `+ New session`. Env override `BRIDGE_PROFILES_FILE`.
3. **Custom @-tag picker.** Typing `@` (after whitespace, anywhere in the input) opens a popup that fuzzy-searches files across the session's working dirs (primary + additional). Inserts `@<rel-path>` for primary-cwd files or `@<dir-basename>/<rel-path>` for additional-dir files.
4. **Telegram notify on long turns.** Per-turn timing: when a turn completes (`result` event arrives) and its duration ≥ `BRIDGE_NOTIFY_MIN_DURATION_MS` (default 3 min), a Telegram message fires via a user-configured bot. Sessions auto-name from the first user prompt (truncated 60 chars) and can be renamed via a pencil-icon inline editor.

## 2. Scope

### In scope

- Bridge: new `profile-store.ts`, `slash-commands.ts`, `file-search.ts`, `notifier.ts`. SessionManager extensions: multi-dir spawn, per-session name, rename action, per-turn duration tracking. Registry shape extended (`name`, `additionalDirs`). Seven new WS message types (list/save/delete/set-default profile, list slash commands, search files, rename session). Backward-compatible `start_session` extension.
- Web: `DirPicker`, `ProfilePicker`, `ProfileEditor`, `SlashAutocomplete`, `AtTagAutocomplete`, `SessionRenameInline`. New stores: `profileStore`, `slashCommandStore`, `fileSearchStore`. InputBox + project picker + SessionList integration.
- All UI mobile-friendly: full-screen modals on viewports < 640 px, tap targets ≥ 44 px, no drag-only / hover-only patterns. Bottom-sheet popups for autocompletes.
- Documentation: this spec + a Phase 6 implementation plan + `docs/setup/telegram-bot.md`.

### Out of scope (deferred)

- File-content (grep-style) search inside @-tag picker — filename/path only.
- Codex `--add-dir` equivalent — Codex CLI lacks the flag; additional dirs are stored on the registry but not forwarded at spawn (logged as a warning once per session).
- Auto-naming via LLM call — first-prompt truncation only.
- Telegram bot 2-way (inbound `/commands` from Telegram → web). Outbound notifications only.
- Per-session telegram toggle UI — env-wide only in P6; a per-session switch can land in a later phase.
- Filesystem watcher for @-tag freshness — 30 s lazy walk + cache only.
- Auto-loading slash commands from additional dirs — primary cwd only, to keep behavior predictable.

## 3. Architecture

```
┌─ Web (Vite + React 18) ───────────────────────────────────────────────┐
│ pages/Home.tsx + Session.tsx                                          │
│   ├─ <ProjectPicker> uses <DirPicker> + <ProfilePicker>               │
│   ├─ <ProfileEditor> modal (full-screen on mobile)                    │
│   ├─ <Chat>                                                            │
│   │   └─ <InputBox> wires <SlashAutocomplete> + <AtTagAutocomplete>   │
│   └─ <SessionList> renders <SessionRenameInline> on pencil click      │
│                                                                         │
│ store/sessions.ts gains renameSession(sessionId, name) action         │
│ features/profiles/profileStore.ts                                     │
│ features/chat/slashCommandStore.ts                                    │
│ features/chat/fileSearchStore.ts                                      │
└────────────────────────────────────────────────────────────────────────┘
                              ↕ WebSocket
┌─ Bridge (Node 20 ESM) ─────────────────────────────────────────────────┐
│ profile-store.ts                                                        │
│   ├─ load()/save() atomic writes (same pattern as session-registry)    │
│   ├─ env override BRIDGE_PROFILES_FILE → fallback .bridge/profiles.json│
│   └─ map<{name,agent}, Profile>; setDefault unsets prior atomically    │
│                                                                          │
│ slash-commands.ts                                                       │
│   ├─ scan ~/.claude/commands/*.md (user)                                │
│   ├─ scan <primaryCwd>/.claude/commands/*.md (project)                  │
│   ├─ merge with hardcoded built-ins                                     │
│   └─ 60s per-session cache                                              │
│                                                                          │
│ file-search.ts                                                          │
│   ├─ bounded walk (5000-file cap) of session.dirs                       │
│   ├─ Phase 3 denylist + .gitignore                                      │
│   ├─ fuzzy score + recency boost; top-50 hits                           │
│   └─ 30s per-session walk cache                                         │
│                                                                          │
│ notifier.ts                                                             │
│   ├─ env: BOT_TOKEN + CHAT_ID + MIN_DURATION_MS + PUBLIC_URL            │
│   ├─ subscribe SessionManager.broadcast('input' / 'result')             │
│   ├─ per-session turnStartMs; on result: if duration ≥ threshold → POST │
│   └─ 5s timeout, 5-failure warning counter, fire-and-forget             │
│                                                                          │
│ session.ts (SessionManager modifications)                               │
│   ├─ spawnSession({ dirs[], … }) — primary = dirs[0], rest = --add-dir │
│   ├─ name lazy-set on first 'input' event (60-char trunc)               │
│   ├─ renameSession(webSessionId, name) → registry.update + broadcast    │
│   └─ subscribe to broadcast for notifier wiring                         │
└────────────────────────────────────────────────────────────────────────┘
```

### Slash command pass-through invariant

The bridge does NOT interpret slash commands. `client.send({ type: 'input', sessionId, text: '/clear' })` flows verbatim to the CLI's stdin. The autocomplete is purely a discoverability/typing aid.

This preserves the Phase 1 "thin spawner" principle: no input mutation, no shell-out from bridge logic.

### Multi-dir spawn flow

`SessionManager.spawnSession({ agent, dirs, account, name? })`:

1. Validate every `dirs[i]` is inside `BRIDGE_ALLOWED_DIRS` + passes Phase 3 denylist + realpath.
2. Reject duplicates (exact-match dedup; do not try to dedupe by inclusion).
3. `primary = dirs[0]`, `additionalDirs = dirs.slice(1)`.
4. **Claude**: spawn args become `[..., '-p', '--dangerously-skip-permissions', '--add-dir', additionalDirs[0], '--add-dir', additionalDirs[1], …, ...other-flags]`. The `cwd:` option = primary. Each `--add-dir` validated again before string interpolation (defense-in-depth — already realpath'd).
5. **Codex**: spawn args unchanged. `additionalDirs` stored in `RegistryEntry.additionalDirs` for diagnostics + future use. Log once per session: `[codex] ignoring additional dirs (CLI does not support --add-dir)`.
6. Registry entry: `name: null`, `additionalDirs: dirs.slice(1)`. Lazy-name set on first `input` event.

Backward compat: existing `start_session { projectPath }` still works (treated as `dirs: [projectPath]`). Single-cwd spawn paths in tests don't break.

## 4. Data models

### Profile

```ts
interface Profile {
  /** Unique within (agent, name); regex `[A-Za-z0-9 _-]{1,40}` */
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
```

`.bridge/profiles.json`:

```json
{
  "profiles": [
    {
      "name": "frontend",
      "agent": "claude",
      "dirs": ["/Volumes/WDSSD/Code/foo-web", "/Volumes/WDSSD/Code/foo-shared"],
      "account": null,
      "default": true
    }
  ]
}
```

### RegistryEntry (extended)

Phase 5 entry plus two new fields. Existing entries on disk are migrated on load with default values.

```ts
interface RegistryEntry {
  // Phase 5 (unchanged)
  webSessionId: string;
  agent: 'claude' | 'codex';
  projectPath: string;            // == dirs[0] of the spawn
  transcriptPath: string;
  claudeSessionId: string | null;
  codexSessionId: string | null;
  createdAt: number;
  account: string | null;

  // Phase 6 additions
  name: string | null;            // auto-set on first input; user-editable
  additionalDirs: string[];       // dirs[1..] from spawn
}
```

### SlashCommand

```ts
interface SlashCommand {
  /** Includes leading `/`. */
  name: string;
  /** Empty string when none. From frontmatter `description:` or first non-frontmatter line. */
  description: string;
  source: 'builtin' | 'user' | 'project';
  /** `'both'` for shared commands; otherwise scoped. */
  agent: 'claude' | 'codex' | 'both';
}
```

### SearchHit

```ts
interface SearchHit {
  /** Already formatted for textarea insertion (with @ prefix). */
  insertText: string;
  /** Absolute path for tooltip display. */
  fullPath: string;
  /** 0 = primary, 1..N = index into session.additionalDirs. */
  dirIndex: number;
  mtime: number;
}
```

## 5. Slash command scan

`slash-commands.ts`:

```ts
class SlashCommandsScanner {
  async listForSession(session: { agent: string; primaryCwd: string }): Promise<SlashCommand[]>;
}
```

Three sources merged with project > user > builtin precedence (project wins on name collision):

1. **Hardcoded built-ins** (versioned with the bridge):
   - **Claude**: `/help`, `/clear`, `/compact`, `/cost`, `/status`, `/agents`, `/memory`, `/exit`, `/init`, `/install-github-app`, `/login`, `/logout`, `/model`, `/permissions`, `/review`. Adjust the list against actual Claude CLI behavior at impl time — these are the well-known commands per current docs.
   - **Codex**: `/help`, `/clear`, `/exit`. (Verify against `codex --help`; Codex slash command surface is smaller.)
2. **User-level** (Claude only): scan `~/.claude/commands/*.md`. Filename `foo.md` → `/foo`. Frontmatter optional; description from `description:` line, falls back to first non-frontmatter line.
3. **Project-level** (Claude only): scan `<primaryCwd>/.claude/commands/*.md`. Same filename/description rules.

**Bounded scan**: max 200 files per location, alphabetical order. Beyond 200 dropped silently.

**Filesystem hardening**: read errors (permission denied, missing dir) skipped silently with stderr log. Symlink to outside allowlist excluded via realpath check. Files only (skip dir entries).

**Caching**: per-session 60 s TTL. Key = `(sessionId)`. Invalidated on session end.

## 6. File search (@-tag)

`file-search.ts`:

```ts
class FileSearch {
  async search(sessionId: string, query: string): Promise<{ hits: SearchHit[]; truncated: boolean }>;
}
```

Algorithm:

1. Resolve session's working dirs from registry: `dirs = [primary, ...additionalDirs]`.
2. Walk recursively (async fs.readdir) per dir; respect Phase 3 denylist + `.gitignore` (use `ignore` npm package or vendor a minimal impl).
3. Cap total walked-files at 5000 (configurable via `BRIDGE_FILE_SEARCH_CAP`); flag `truncated: true` if hit.
4. For each file: compute path-relative-to-its-dir, dirIndex, mtime.
5. Score against query; take top 50 per Section 7.
6. Format `insertText`:
   - `dirIndex === 0` → `@<rel-path>` (path relative to primary cwd)
   - `dirIndex > 0` → `@<additionalDir-basename>/<rel-path>`
7. Cache walked file list per session for 30 s; subsequent searches filter in-memory.

Symlinks: NOT followed; realpath of each file checked against allowlist before inclusion.

## 7. Search ranking

```ts
function score(path: string, basename: string, query: string, mtime: number): number {
  if (query === '') return mtime; // empty query → recency-only
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const b = basename.toLowerCase();
  let s: number;
  if (b === q) s = 1000;
  else if (b.startsWith(q)) s = 500;
  else if (b.includes(q)) s = 200;
  else if (p.includes(q)) s = 50;
  else return -1;                                   // no match → drop
  // Recency boost: 0..100 over last 30 days
  const ageDays = Math.max(0, (Date.now() - mtime) / 86_400_000);
  s += Math.max(0, 100 - ageDays * (100 / 30));
  return s;
}
```

Sort desc by score, take top 50.

## 8. Telegram notifier

`notifier.ts`:

```ts
class Notifier {
  constructor(env: { token?: string; chatId?: string; minDurationMs: number; publicUrl?: string });
  noteInput(sessionId: string): void;             // turnStartMs[sessionId] = Date.now()
  noteResult(session: RegistryEntry): Promise<void>; // duration check + send
  noteSessionEnd(sessionId: string): void;        // reset turnStartMs[sessionId]
}
```

**Trigger flow** (called from SessionManager subscriber):

- On `input` lifecycle event for a session → `notifier.noteInput(sessionId)`. Stores `turnStartMs[sessionId] = Date.now()`.
- On `result` event for a session → `notifier.noteResult(session)`. Computes `duration = Date.now() - turnStartMs[sessionId]`; if duration ≥ threshold, fire `sendMessage`. Resets `turnStartMs[sessionId] = null`.
- On `session_ended` lifecycle event → `notifier.noteSessionEnd(sessionId)`. Defensive reset.

**No-op stub** when env unset:

```ts
if (!env.token || !env.chatId) {
  return new NoOpNotifier(); // all methods return immediately
}
```

This keeps boot quiet and removes hot-path overhead when feature is disabled.

**Telegram POST**:

```ts
const url = `https://api.telegram.org/bot${token}/sendMessage`;
const body = JSON.stringify({ chat_id: chatId, text });
await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
```

**Failure handling**:
- Catch all errors. Increment per-session failure counter. After 5 consecutive failures, log a one-time stderr warning suggesting env var check; counter resets on first success.
- No retries, no queueing — drop the missed notification.

**Message text**:

```
Session 'fix login bug' completed
took 5m 23s
http://100.x.x.x:7777/session/abc-123
```

- Name source: `session.name` from registry (auto-set on first input, user-renamed via pencil icon).
- Duration formatter: `5m 23s` if ≥ 1 min, else `45s`. ≥ 1 hr formats as `1h 12m 3s`.
- Link line included only if `BRIDGE_PUBLIC_URL` is set; sanitize trailing slash.
- Plain text (no markdown / HTML).

## 9. WS protocol

### Client → Bridge (new)

```ts
interface ClientListProfilesMsg {
  type: 'list_profiles';
  correlationId: string;
}

interface ClientSaveProfileMsg {
  type: 'save_profile';
  profile: Profile;        // server validates name, dirs, agent
  correlationId: string;
}

interface ClientDeleteProfileMsg {
  type: 'delete_profile';
  name: string;
  agent: 'claude' | 'codex';
  correlationId: string;
}

interface ClientSetDefaultProfileMsg {
  type: 'set_default_profile';
  name: string;
  agent: 'claude' | 'codex';
  correlationId: string;
}

interface ClientListSlashCommandsMsg {
  type: 'list_slash_commands';
  sessionId: string;
  correlationId: string;
}

interface ClientSearchFilesMsg {
  type: 'search_files';
  sessionId: string;
  query: string;
  correlationId: string;
}

interface ClientRenameSessionMsg {
  type: 'rename_session';
  sessionId: string;
  name: string;
  correlationId: string;
}
```

### Existing `start_session` extended

Backward-compatible: accepts EITHER `projectPath: string` OR `dirs: string[]`. If both are set, `dirs[]` wins (primary = `dirs[0]`).

```ts
// Was (P1-P5):
{ type: 'start_session', agent, projectPath, account?, correlationId }
// Phase 6 also accepts:
{ type: 'start_session', agent, dirs: string[], account?, correlationId }
```

Server-side: if `dirs` present, ignore `projectPath`. If only `projectPath` present, treat as `dirs: [projectPath]`.

### Server → Client (new)

```ts
interface ServerProfileListMsg {
  type: 'profile_list';
  profiles: Profile[];     // valid: false flagged for any failing validation
  correlationId: string;
}

interface ServerProfileSavedMsg {
  type: 'profile_saved';
  profile: Profile;
  correlationId: string;
}

interface ServerSlashCommandsListMsg {
  type: 'slash_commands_list';
  commands: SlashCommand[];
  correlationId: string;
}

interface ServerFileSearchResultsMsg {
  type: 'file_search_results';
  hits: SearchHit[];
  truncated: boolean;
  correlationId: string;
}

interface ServerSessionRenamedMsg {
  type: 'session_renamed';
  sessionId: string;
  name: string;
  correlationId: string;
}
```

### New error codes (extend `ServerErrorMsg.code`)

```ts
| 'profile_invalid_name'      // empty / regex mismatch / collision
| 'profile_dirs_disallowed'   // any dir outside allowlist or denylist match
| 'profile_not_found'         // delete/setDefault on missing profile
| 'session_name_invalid'      // empty / control chars / >200 chars
| 'file_search_failed'        // unexpected scan error
| 'slash_commands_failed'     // unexpected scan error
```

## 10. Validation

| Field | Rule |
|---|---|
| `Profile.name` | regex `^[A-Za-z0-9 _-]{1,40}$`; case-insensitive uniqueness within (agent); reject `default` reserved word |
| `Profile.dirs` | non-empty; each item realpath'd + allowlist + denylist; deduped exact-match |
| `Profile.agent` | `'claude'` or `'codex'` |
| `Profile.account` | null OR string matching existing CodexAccount name (validated on save) |
| `start_session.dirs[]` | same as `Profile.dirs` |
| `rename_session.name` | trim → reject empty → ≤ 200 chars → strip control characters (only printable Unicode allowed) |
| `search_files.query` | string ≤ 200 chars; longer rejected as `file_search_failed` |
| `list_slash_commands.sessionId` | must exist in SessionManager `sessions` map; otherwise reject |

## 11. Security

- **Allowlist + denylist on every dir**: `Profile.dirs` validated at save AND at every `start_session` (allowlist may have tightened between save and use).
- **Symlink safety**: `file-search.ts` realpaths every file; rejects targets outside allowlist. `slash-commands.ts` similarly realpaths command files.
- **Spawn args**: `--add-dir <path>` paths are realpath'd + allowlist-checked + passed via `child_process.spawn(cmd, args, { cwd })` (no shell). No metacharacter risk.
- **Telegram**: bot token never logged in plain text. Failure messages omit the token.
- **Profile file mode**: `.bridge/profiles.json` written 0o600 (matches registry file).
- **No new exfiltration surface**: WS protocol additions are well-typed; server validates every payload before acting.
- **Notifier respects per-session `additionalDirs`**: when fetching session metadata for the message, no path is leaked into the Telegram message body unless the operator explicitly named the session that way.

## 12. Errors + edge cases

| Failure | Behavior |
|---|---|
| Profile JSON file missing | `[]`; bridge boots normally |
| Profile JSON corrupt | `[]` + stderr log (matches Phase 5 registry pattern) |
| Profile dirs disallowed (allowlist tightened post-save) | UI shows entry with `valid: false` greyed out + tooltip explaining why; spawn from invalid profile rejected with `project_path_disallowed` |
| Profile dirs[0] missing on disk | Existing `project_path_missing` from P5 |
| Profile name collision (case-insensitive) | Reject save with `profile_invalid_name` |
| Two requests setDefault same agent simultaneously | Serialized through write queue; un-set previous atomically before new write |
| Slash autocomplete in middle of word (e.g. `abc/def`) | Doesn't trigger; only triggers when `/` is at line start OR preceded by whitespace/newline |
| Custom command frontmatter parse error | Skip silently + stderr log; other commands still appear |
| Project `.claude/commands/` is symlink to outside allowlist | Skip silently |
| @-tag walk hits 5000-cap | `truncated: true`; UI shows "(showing first 5000 files)" hint |
| @-tag selected, then user backspaces past inserted text | Behaves as plain text deletion; no special handling |
| File search returns 0 hits | Popup shows "No matches in working dirs" |
| Notifier env vars unset | No-op stub; bridge boots without warnings |
| Telegram API returns 401 / 403 | Per-session counter increments; subsequent turns still attempt (in case env was fixed live) |
| Telegram network unreachable | 5 s timeout; counter increments; drop silently |
| Session ends mid-turn (kill button) | `turnStartMs` reset; no notif fires |
| Resume from history adds to long-running turn | New `turnStartMs` set on next `input`; existing turn ends in `result` from resumed CLI |
| Multiple concurrent sessions hit threshold simultaneously | Each fires its own message; well below Telegram's ~30/sec rate limit |
| `BRIDGE_PUBLIC_URL` has trailing slash | Sanitize before joining `/session/<id>` |
| Session renamed to control-char-only string | Reject with `session_name_invalid` |
| dirs[0] inside dirs[1] (e.g. dirs = ["/a/b", "/a"]) | Allowed; Claude handles overlapping `--add-dir` paths. Dedup only exact-match |
| Path with spaces in dirs | Quoted via `child_process.spawn` (no shell) — works without escaping |
| Concurrent save_profile + delete_profile on same name | Serialized through write queue; last-write-wins |
| Slash command name `/help.md` (filename with extension) | Filename parsed as command name without extension; `/help` |
| Codex session uses additionalDirs | Stored in registry; NOT passed to spawn args; one-shot startup log warning |
| Web reconnect mid-rename | Existing per-session error pattern; rename retried by user |

## 13. UI / Mobile

All new components must reflow on viewports < 640 px.

- **DirPicker**: multi-select with primary marker (★). Per-row controls visible at all times: ▲ move up, ▼ move down, ✕ remove, drag-handle (desktop). Tap targets ≥ 44 px.
- **ProfilePicker**: native `<select>` element on mobile (best UX); custom dropdown fine on desktop.
- **ProfileEditor modal**: full-screen at `<640px`, centered max-width on desktop.
- **Project picker modal**: same full-screen-on-mobile rule. Bottom-fixed Cancel/Spawn buttons on mobile.
- **SlashAutocomplete + AtTagAutocomplete popups**: bottom-half-screen sheet on mobile (preserves visibility of textarea + send button); absolute-positioned anchor on desktop.
- **SessionRenameInline**: pencil icon ≥ 44 px tap target; tap → inline input with Save button (Esc cancels via tap-outside on mobile).
- **No drag-only / hover-only patterns** anywhere.

Document title: `<sessionName> — mac-remote-terminal` reflects current session.

## 14. Environment

New env vars:

```bash
BRIDGE_PROFILES_FILE=/abs/path/to/profiles.json   # default: .bridge/profiles.json
BRIDGE_TELEGRAM_BOT_TOKEN=<from BotFather>         # absent disables notifier
BRIDGE_TELEGRAM_CHAT_ID=<your chat id>             # absent disables notifier
BRIDGE_NOTIFY_MIN_DURATION_MS=180000               # default 3 min
BRIDGE_PUBLIC_URL=http://100.x.x.x:7777            # optional; included in telegram message
BRIDGE_FILE_SEARCH_CAP=5000                        # optional; @-tag walk cap
```

Existing P1-P5 env vars unchanged.

## 15. Testing

### Bridge unit tests

`packages/bridge/src/__tests__/`:

- **`profile-store.test.ts`** — empty load, corrupt fallback, add/update/delete/setDefault round-trip, single-default-per-agent invariant, name regex rejection, atomic write under 50 concurrent ops, 0o600 mode.
- **`slash-commands.test.ts`** — builtins-only, user-level scan with frontmatter, project-level wins on collision, codex session returns codex builtins only, permission-denied silent, 60s cache.
- **`file-search.test.ts`** — empty query (recency-only), substring match (basename > path), recency boost ordering, 5000-cap truncation flag, denylist + .gitignore exclusions, multi-dir insertText format, symlink-out-of-allowlist excluded, 30s cache.
- **`notifier.test.ts`** — env unset → no-op stub, env set + mock fetch → POST shape, threshold filter, threshold=0 every-turn, network failure counter, 5-failure warning, PUBLIC_URL with/without, duration formatter (s / m+s / h+m+s).
- **`session.test.ts`** (modified) — `spawnSession({ dirs: [a,b,c] })` → claude args contain `--add-dir b --add-dir c`; codex with multi-dir → only dirs[0] used + warning; first input auto-sets name; renameSession action; per-turn timing for notifier subscription.
- **`websocket.test.ts`** (modified) — 7 new handlers: list/save/delete/setDefault profile, list slash commands, search files, rename session. Each: happy path + one error case.

### Web unit tests

- **`profileStore.test.ts`** — fetch / save / delete / setDefault; loading + error states.
- **`slashCommandStore.test.ts`** — per-session keyed cache; 60s TTL.
- **`fileSearchStore.test.ts`** — per-session cache; query-prefix in-memory filter; debounced fetch.
- **`ProfilePicker.test.tsx`** — dropdown render + select pre-fills DirPicker.
- **`ProfileEditor.test.tsx`** — list + edit modal + delete + set-default actions; mobile-viewport snapshot.
- **`DirPicker.test.tsx`** — multi-select; ★ primary toggle; arrow reorder works without drag; ✕ remove; drag-handle present (desktop path mocked).
- **`SlashAutocomplete.test.tsx`** — popup at line-start `/`; filters by typed prefix; ↑↓ + Enter inserts; Esc dismisses; mobile bottom-sheet variant.
- **`AtTagAutocomplete.test.tsx`** — popup on `@` after whitespace; searches via WS (mocked); inserts `@<path>` correctly for primary + additional dirs; mobile sheet variant.
- **`InputBox.test.tsx`** (modified) — both autocompletes wired; existing send + image-paste + auto-prompt-on-send still work.
- **`SessionList.test.tsx`** (modified) — rows show `session.name`; pencil-icon rename inline.
- **`Home.test.tsx`** + **`Session.test.tsx`** (modified) — project-picker uses DirPicker; profile-load behavior; multi-dir reflected in spawn payload.

### Manual e2e smoke

Operator:

1. **Profiles** — boot with `BRIDGE_PROFILES_FILE=$HOME/.config/bridge-profiles.json`. Create profile "frontend" with 2 dirs; mark default. Restart bridge → reload web → click `+ New session` → DirPicker pre-filled. Override (remove + add), spawn → session uses overridden dirs. Edit/Save/Delete profile via Manage modal. Mobile viewport: full-screen modal, tap-reorder works.
2. **Multi-dir spawn** — pick 2 dirs (primary + 1 additional). Spawn Claude. Ask "read /the/additional/dir/foo.ts" — Claude reads it. Codex same picker → spawn only uses dirs[0]; bridge stderr shows "ignoring additional dirs".
3. **Slash autocomplete** — type `/` → popup shows builtins + custom commands. Type `/co` → filters. Add `~/.claude/commands/test.md` → reload web → `/te` shows `/test`. Insert via Enter → `/test ` typed; submit → CLI executes.
4. **@-tag picker** — type `@` mid-prompt → top-50 by recency. Type `@auth` → filters live. Select primary-cwd file → text inserts as `@src/auth.ts`. Select additional-dir file → inserts as `@<basename>/path`. Submit prompt with `@auth.ts` → Claude reads file (proves @ syntax round-trips).
5. **Telegram notify** — set up bot per `docs/setup/telegram-bot.md`. Set env. Restart bridge. Quick prompt (< 3 min) → no notif. Long-running prompt (> 3 min) → notif arrives with name + duration + link. Click link on phone (Tailscale on) → opens session. Rename session via pencil → next long turn's notif uses renamed name.
6. **Mobile** (Safari devtools or real phone, 375×667): DirPicker arrow-reorder via tap. Slash + @-tag bottom-sheets don't cover textarea. Profile manager full-screen. Pencil-rename has Save button.
7. **DevTools** — zero CSP violations, zero React errors, zero unhandled rejections. Notifier failures only log to bridge stderr (not browser console).

## 16. Implementation phasing

The Phase 6 plan (separate doc under `docs/superpowers/plans/`) breaks into ~14-16 tasks following Phase 1-5's TDD cadence:

1. Protocol type additions (bridge + web byte-identical)
2. profile-store.ts + tests
3. slash-commands.ts + tests
4. file-search.ts + tests
5. notifier.ts + tests
6. RegistryEntry shape extension (name + additionalDirs) — migration on load
7. SessionManager multi-dir spawn + auto-name + renameSession + notifier subscription
8. WS handlers (7 new) + tests
9. Bridge boot wiring (profile-store, slash-commands, file-search, notifier instantiation)
10. Web protocol type mirror + new stores (profileStore, slashCommandStore, fileSearchStore)
11. DirPicker + ProfilePicker + ProfileEditor (with mobile)
12. SlashAutocomplete + AtTagAutocomplete (with mobile)
13. SessionRenameInline + sessions-store rename action
14. App.tsx routing + InputBox wiring + Session.tsx pencil + document.title
15. docs/setup/telegram-bot.md
16. Manual e2e smoke
