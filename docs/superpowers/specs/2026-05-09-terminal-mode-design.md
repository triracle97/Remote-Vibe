# Terminal Mode — Design

**Date:** 2026-05-09
**Status:** Draft (pre-implementation)

## Summary

Add a third "agent" kind alongside Claude and Codex: a raw shell terminal (PTY)
running in a user-selected, allowlisted directory. Full xterm.js front-end with
mobile-friendly helper bar. Sessions are ephemeral — they die when the
spawning WebSocket disconnects or the bridge restarts; no registry, no resume,
no transcript replay.

The terminal subsystem is implemented as a sibling of `SessionManager`
(`TerminalManager` + `TerminalProcess`), with its own wire messages and its own
web route. The AI session subsystem is left untouched.

## Goals

- Run an interactive shell (vim, htop, git interactive rebase, etc.) from the
  web UI in any directory inside `BRIDGE_ALLOWED_DIRS`.
- Work on a phone over Tailscale: ≥44px tap targets, on-screen helper bar for
  Esc/Tab/Ctrl/arrows, fit-to-viewport sizing, paste from clipboard.
- Surface terminal sessions in the existing Sessions/Home lists so the user
  sees Claude, Codex, and Terminal sessions in one place.
- Keep the AI subsystem (`SessionManager`, `transcript-store`, `parser`,
  `notifier`) free of terminal-specific concepts.

## Non-Goals

- No persistence of PTY processes across bridge restarts.
- No scrollback recovery on browser reconnect (ephemeral by decision).
- No multi-tab / multi-client attach to the same PTY (PTY is owned by the
  spawning WS connection).
- No `--add-dir`-style multi-dir; cwd is a single dir from the picker.
- No telegram notifier integration (terminals don't have "results").
- No Codex-style profiles (terminals reuse the project picker only).
- No jail / restricted shell — the user has full shell access inside their
  user account, identical to running `zsh` locally.

---

## Architecture

```
┌─ Web (apps/web) ─────────────────────────────────────────┐
│  /terminal/:id page  → xterm.js + TerminalHelperBar      │
│  features/terminal/                                       │
│    TerminalView.tsx, TerminalHelperBar.tsx,              │
│    useTerminalSession.ts, terminal-client.ts             │
│  store/terminals.ts (in-memory mirror, no persistence)   │
│  Picker: useNewSession adds "Terminal" agent option      │
└──────────────┬───────────────────────────────────────────┘
               │ WebSocket (existing /ws endpoint, cookie auth reused)
┌──────────────┴───────────────────────────────────────────┐
│  Bridge (packages/bridge)                                │
│   websocket.ts → routes term_* msgs to TerminalManager   │
│   TerminalManager                                        │
│     ├─ Map<termId, TerminalSession{wsId, proc, cwd...}>  │
│     ├─ spawn(wsId, cwd, cols, rows) → validatePath()     │
│     ├─ sendInput(wsId, termId, data)                     │
│     ├─ resize(wsId, termId, cols, rows)                  │
│     ├─ kill(wsId, termId)                                │
│     ├─ killByWs(wsId)  ← called on ws close              │
│     └─ shutdown()      ← called on bridge stop           │
│   TerminalProcess (thin node-pty wrapper)                │
│     ├─ pty.spawn('zsh', ['-l'], {cwd, env, cols, rows})  │
│     ├─ pty.onData → emit('output', utf8 string)          │
│     ├─ pty.onExit → emit('exit', code, signal)           │
│     └─ write / resize / kill / pause / resume            │
└──────────────────────────────────────────────────────────┘
```

### Shared utility refactor

Extract path validation from `SessionManager.validatePath` (currently at
`packages/bridge/src/session.ts:166-180`) into
`packages/bridge/src/path-allowlist.ts`:

```ts
export class PathOutsideAllowlistError extends Error { /* moved from session.ts */ }
export interface PathAllowlistOpts {
  allowedDirs: string[];
  realpath?: (p: string) => Promise<string>;
}
export function makePathValidator(opts: PathAllowlistOpts):
  (projectPath: string) => Promise<string>;
```

`SessionManager` and `TerminalManager` both consume this. The change is
mechanical; existing tests for path allowlist should keep passing unchanged.

---

## Wire Protocol

Added to `packages/bridge/src/types.ts`. All termIds are server-minted UUIDs.

### Client → server

```ts
interface ClientTermStartMsg {
  type: 'term_start';
  cwd: string;          // absolute, must pass allowlist
  cols: number;         // initial pty size (>0)
  rows: number;
  correlationId: string;
}
interface ClientTermInputMsg {
  type: 'term_input';
  termId: string;
  data: string;         // raw bytes (utf8)
}
interface ClientTermResizeMsg {
  type: 'term_resize';
  termId: string;
  cols: number;
  rows: number;
}
interface ClientTermKillMsg {
  type: 'term_kill';
  termId: string;
  correlationId: string;
}
```

### Server → client

```ts
interface ServerTermStartedMsg {
  type: 'term_started';
  termId: string;
  cwd: string;
  createdAt: number;
  correlationId: string;
}
interface ServerTermOutputMsg {
  type: 'term_output';
  termId: string;
  data: string;         // raw pty bytes (utf8 lossy on invalid)
}
interface ServerTermExitMsg {
  type: 'term_exit';
  termId: string;
  exitCode: number | null;
  signal: string | null;
}
```

### New error codes (added to `ServerErrorCode`)

- `terminal_not_found` — unknown termId, or termId belongs to a different ws.
- `terminal_spawn_failed` — node-pty threw on spawn.
- `pty_not_available` — `node-pty` failed to load at bridge boot. Bridge
  emits a capability flag in the existing `init` message
  (`{type:'system', event:'init', capabilities:{terminal:false}}`); the web
  hides the Terminal option in the picker when the flag is false.

### Notes

- No `seq` field on `term_*` messages — PTY stream is fire-and-forget; on
  reconnect the new client just gets future bytes (and reconnect for a given
  termId is impossible anyway, since disconnect kills the PTY).
- No `term_list` message — PTY is bound to spawning WS, so no other client
  can see/attach.
- `term_input` / `term_resize` from the **wrong** ws (termId belongs to a
  different ws) → `terminal_not_found` error event (no correlationId, since
  these client messages don't carry one). This blocks cross-client injection.
- `term_input` / `term_resize` for a **truly unknown** termId (already
  exited) → silent drop. The client likely hasn't yet processed the
  preceding `term_exit`; surfacing an error here would be noise.
- Only `term_start` and `term_kill` carry correlationIds and reply with
  typed errors on failure.

---

## Bridge Components

### `TerminalProcess` (`packages/bridge/src/terminal-process.ts`)

Thin EventEmitter wrapping a `node-pty` IPty. No knowledge of WebSocket or
protocol.

```ts
export type PtySpawnFn = (
  shell: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number; name?: string },
) => IPty;

export interface TerminalProcessOpts {
  spawn?: PtySpawnFn;        // injection seam for tests
  killGraceMs?: number;      // default 5000
}

export class TerminalProcess extends EventEmitter {
  constructor(cwd: string, cols: number, rows: number, opts?: TerminalProcessOpts);
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: 'SIGHUP' | 'SIGTERM' | 'SIGKILL'): void;
}
```

- Spawn: `pty.spawn('zsh', ['-l'], { cwd, env: process.env, cols, rows, name: 'xterm-256color' })`.
- `pty.onData(s => emit('output', s))`.
- `pty.onExit(({exitCode, signal}) => emit('exit', exitCode, signal ?? null))`.
- `kill()` sends SIGHUP, schedules SIGKILL after `killGraceMs`. Idempotent
  (no-op after first kill or after exit).

### `TerminalManager` (`packages/bridge/src/terminal-manager.ts`)

```ts
interface TerminalSession {
  termId: string;
  wsId: string;
  proc: TerminalProcess;
  cwd: string;
  createdAt: number;
}

export interface TerminalManagerOpts {
  allowedDirs: string[];
  realpath?: (p: string) => Promise<string>;
  procFactory?: (cwd: string, cols: number, rows: number) => TerminalProcess;
  /** Threshold for ws-level backpressure pause/resume. Default 1 MB. */
  bpHighWatermark?: number;
}

export class TerminalManager extends EventEmitter {
  spawn(wsId: string, cwd: string, cols: number, rows: number): Promise<TerminalSession>;
  sendInput(wsId: string, termId: string, data: string): void;
  resize(wsId: string, termId: string, cols: number, rows: number): void;
  kill(wsId: string, termId: string): void;
  killByWs(wsId: string): void;
  shutdown(): Promise<void>;
}
```

Emits:
- `output` `(termId, data)` — relayed to ws by `websocket.ts`.
- `exit` `(termId, exitCode, signal)` — relayed; manager deletes the entry.

### `websocket.ts` integration

- New `TerminalManager` instance created in `index.ts` next to `SessionManager`.
- Per-connection: track `wsId = randomUUID()`. On `close`, call
  `terminalManager.killByWs(wsId)`.
- Route `term_start | term_input | term_resize | term_kill` to manager.
- Subscribe to manager's `output`/`exit` events at boot; in the handler look
  up `wsId` from the session and forward only to that ws.
- Backpressure: in the output handler, if `ws.bufferedAmount > bpHighWatermark`
  call `proc.pause()`; poll every 50ms until `bufferedAmount < high/2` then
  `proc.resume()`. (ws-node has no reliable drain event.)

### Lifecycle summary

| Trigger | Action |
|---|---|
| `term_start` | validatePath, mint termId, spawn TerminalProcess, store, reply `term_started` |
| `term_input` | wsId+termId match → `proc.write(data)`; mismatch → `terminal_not_found` error |
| `term_resize` | wsId+termId match → `proc.resize(cols, rows)`; mismatch → `terminal_not_found` |
| `term_kill` | wsId+termId match → `proc.kill('SIGHUP')`; mismatch → error |
| pty `output` | forward `term_output` to owning ws (with backpressure) |
| pty `exit` | forward `term_exit`, delete from map |
| ws close | `killByWs(wsId)` — kill all PTYs spawned by this ws |
| bridge stop | `shutdown()` — kill all PTYs (SIGHUP, 2s grace, SIGKILL) |

---

## Web Components

### Files

```
apps/web/src/features/terminal/
  TerminalView.tsx           xterm.js mount, FitAddon, focus handling
  TerminalHelperBar.tsx      mobile keys (Esc Tab Ctrl ↑↓←→ Ctrl-C : / -)
  useTerminalSession.ts      hook: start/kill, write input, handle output, resize
  terminal-client.ts         thin wrapper over BridgeClient ws msgs
apps/web/src/store/
  terminals.ts               Map<termId, {cwd, createdAt, alive}> for /sessions list
apps/web/src/pages/
  Terminal.tsx               route /terminal/:id; reads store + mounts View
```

### Routing

`App.tsx`: add `<Route path="/terminal/:id" element={<Terminal />} />` inside
the existing `<AppShell />` route.

### New session entry point

`features/project-picker/useNewSession.ts` (existing) currently shows a
Claude/Codex agent picker after dir selection. Add a third "Terminal" option.
On selection:

1. Send `term_start{cwd, cols=initialCols, rows=initialRows, correlationId}`.
2. On `term_started`, push to `useTerminalsStore`, navigate
   `/terminal/${termId}`.

Initial cols/rows: default `(80, 24)` in the `term_start` payload. The
FitAddon resizes on first render and sends a `term_resize` for the real
viewport — keeps the picker UI synchronous (no probe step).

### Terminal page

```tsx
function Terminal() {
  const { id } = useParams();
  const term = useTerminalsStore(s => s.terminals[id]);
  if (!term) return <Navigate to="/sessions" replace />;
  return <TerminalView termId={id} cwd={term.cwd} />;
}
```

### TerminalView

- Mount xterm.js (`@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links`).
- Theme matches CSS vars (`--color-bg`, `--color-text`, accent for cursor).
- `term.onData(d => client.send({type:'term_input', termId, data:d}))`.
- WS subscriber: on `term_output{termId, data}` → `term.write(data)`.
- On `term_exit` → render an inline "Process exited (code N)" footer; keep
  the buffer visible until user navigates away.
- ResizeObserver on container → debounce 100ms → FitAddon → send `term_resize`.
- Mount `<TerminalHelperBar onSend={d => client.send(...)} />` inside a fixed
  bar above the on-screen keyboard (CSS `position: sticky; bottom: 0`).
- On unmount: send `term_kill{termId}`.

### TerminalHelperBar

Buttons (each ≥44×44px, mobile-friendly memory):

| Key | Sequence |
|---|---|
| `Esc` | `\x1b` |
| `Tab` | `\t` |
| `Ctrl` | (modifier toggle — next alpha key sent as ctrl-mask) |
| `↑ ↓ ← →` | `\x1b[A` / `\x1b[B` / `\x1b[D` / `\x1b[C` |
| `Ctrl-C` | `\x03` (dedicated, used a lot) |
| `:` `/` `-` | literals (vim, paths, flags) |

Ctrl modifier UX: tap Ctrl → button highlights → next alpha key (a-z) → send
`String.fromCharCode(charCode - 96)` (e.g. `c` → `\x03`); modifier resets.
Tap Ctrl again to clear without sending.

### Sessions list integration

`Sessions.tsx` and `Home.tsx` currently list AI sessions from
`useSessionsStore`. Add a parallel read of `useTerminalsStore` and merge:

- Each terminal row tagged `agent: 'terminal'`, label = `cwd.split('/').pop()`.
- Click navigates `/terminal/${termId}` instead of `/session/${id}`.
- Active indicator (green dot) only when `alive === true`.

### Capability flag

On WS `init` message, bridge includes `capabilities: { terminal: boolean }`.
Web stores in `useConnectionStore`. The "Terminal" picker option is hidden
when `capabilities.terminal === false` (graceful degrade when node-pty not
installed).

---

## Dependencies

### Bridge (`packages/bridge/package.json`)

- Add `node-pty` (^1.0.0). Native module; needs `npm rebuild` after install.
  - Failure to load is non-fatal: `index.ts` `try/catch` around the import,
    and sets `capabilities.terminal = false` if it throws (`pty_not_available`).

### Web (`apps/web/package.json`)

- Add `@xterm/xterm` (^5.5.0)
- Add `@xterm/addon-fit` (^0.10.0)
- Add `@xterm/addon-web-links` (^0.11.0)

(Use the `@xterm/*` scoped packages, the maintained successor to the
unscoped `xterm` package.)

---

## Security

The terminal mode gives the user a full interactive shell as the bridge's OS
user. This is identical privilege to the Claude/Codex agents (which already
have `--dangerously-skip-permissions` and run in the user's shell), so it
does not increase the threat model. Specifics:

- **Authn:** existing cookie/token auth. No new auth surface.
- **Authz:** `term_start.cwd` validated against `BRIDGE_ALLOWED_DIRS`; same
  function as session spawning. Once inside the shell the user can `cd`
  anywhere their OS user can read — same as Claude/Codex today.
- **Cross-ws isolation:** termId is tied to its spawning wsId; another
  authenticated ws cannot inject input or read output for someone else's
  terminal.
- **Shell injection at spawn:** node-pty takes argv directly; no shell
  interpolation of `cwd` (passed as the `options.cwd` field, not in argv).
- **Resource exhaustion:** PTY is killed on ws close; bridge shutdown kills
  all. No idle reaper for the case where an ws stays open forever with a
  PTY running an infinite-output process — backpressure prevents bridge OOM
  but the PTY keeps running. Acceptable for the single-user threat model.
- **Output containment:** raw bytes flow to xterm.js, which is responsible
  for ANSI-safe rendering. xterm.js sandboxes ANSI sequences; no eval.

---

## Testing

### Bridge unit tests (vitest, in `packages/bridge/src/__tests__/`)

`terminal-process.test.ts`
- spawn invoked with `'zsh', ['-l'], {cwd, env, cols, rows, name:'xterm-256color'}`
- `output` event fires with utf8 string when mock pty emits data
- `resize(c, r)` calls `pty.resize(c, r)`
- `kill()` sends SIGHUP; SIGKILL after `killGraceMs`
- `kill()` is idempotent
- `exit` event propagates `(exitCode, signal)`

`terminal-manager.test.ts`
- `spawn` rejects path outside allowlist with `path_outside_allowlist`
- `spawn` translates factory throw → `terminal_spawn_failed`
- `sendInput` from non-owning wsId → `terminal_not_found` error event
- `resize` from non-owning wsId → `terminal_not_found`
- `killByWs` kills only that ws's PTYs (others survive)
- `shutdown` kills all PTYs (SIGHUP first, SIGKILL after grace)
- backpressure: pty paused when simulated ws bufferedAmount > 1 MB; resumed
  when buffer drains below half-watermark
- pty exit removes the entry from the map

`websocket.test.ts` (extend)
- `term_start` round-trips to `term_started` with the same correlationId
- `term_output` is forwarded only to the spawning ws (not to a second
  authenticated ws)
- `term_input` from a second ws → `terminal_not_found` error
- ws close kills associated PTYs

### Web unit tests (vitest, in `apps/web/src/features/terminal/__tests__/`)

`useTerminalSession.test.ts`
- `term_start` sent with correct `cwd/cols/rows/correlationId`
- inbound `term_output{termId, data}` calls `term.write(data)` on the mock
  xterm instance (filtered by termId)
- unmount sends `term_kill`
- `term_exit` sets `alive=false` in the store

`TerminalHelperBar.test.tsx`
- tap Esc → `onSend('\x1b')`
- tap Tab → `onSend('\t')`
- Ctrl modifier: tap Ctrl, then tap "c" → `onSend('\x03')`; modifier resets
- tap Ctrl twice clears modifier without sending
- computed style: each button ≥44×44px

`Terminal.page.test.tsx`
- unknown `:id` → `<Navigate to="/sessions">`

### Manual integration (documented in this spec, not automated)

After implementation, verify on a Mac with the bridge running locally:

- [ ] Spawn terminal in `~/Code/example`, run `ls`, see colored output.
- [ ] Run `vim`; cursor + colors render, `:q` exits cleanly.
- [ ] Run `htop` for ~5s; refresh stays smooth, layout matches viewport.
- [ ] Resize browser window; `tput cols && tput lines` reflects new size.
- [ ] Open via Tailscale on phone: tap Esc / Tab / arrows / Ctrl-C work.
- [ ] Kill browser tab: `ps aux | grep -E 'zsh.*-l' | grep -v grep` shows
      no orphaned shell within 5s.
- [ ] `term_start` with cwd outside `BRIDGE_ALLOWED_DIRS` → error toast in UI.
- [ ] Stop bridge with active terminal: PTY exits within 2s.

---

## Out of Scope (Possible Follow-Ups)

- Persistence / scrollback recovery on reconnect (would need a
  `terminal-store` analog of `transcript-store`, plus a replay mechanism).
- Multi-tab attach to the same PTY.
- Recording / share-link of a terminal session.
- Per-terminal env overrides or shell choice picker.
- `cd` jail enforcement (would require a wrapper script + restricted
  shell — likely not worth the friction).
- Telegram notifier integration.

---

## Open Questions

None at design time. Implementation may surface node-pty quirks on the
darwin-arm64 target; if so, that's a build/platform issue, not a design
issue.
