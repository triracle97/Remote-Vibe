# Remote Vibe

Drive Claude Code and Codex on your Mac from any phone or laptop over Tailscale. Vibe-code from anywhere.

A private bridge between a coding-agent CLI and a phone-or-laptop browser, so you can run long sessions away from your desk.

A small Node bridge spawns the agent process, streams transcripts over WebSocket, and serves a React app that mirrors the terminal experience. Supports prompt history, multi-directory profiles, image paste, mermaid + KaTeX rendering, slash-command autocomplete, `@`-file autocomplete, and an optional Telegram notifier for long turns.

## Status

Personal project, version `0.1.0`. APIs and storage layout will shift. Not packaged for npm. Tested only on macOS with Apple Silicon.

## Security model — read first

This bridge **spawns shell processes inside an allow-listed directory tree on your behalf**. If you expose it to the public internet, you have built a remote code execution service for whoever can guess a token.

Intended deployment:

- Bind to a Tailscale IPv4 address only (the bridge auto-detects one by default).
- Authenticate every request with `BRIDGE_TOKEN`.
- Constrain spawnable directories with `BRIDGE_ALLOWED_DIRS`.

Do **not**:

- Bind to `0.0.0.0` and port-forward.
- Share `BRIDGE_TOKEN` over insecure channels.
- Add directories you do not want an agent to read/write to `BRIDGE_ALLOWED_DIRS`.

There is no rate limiting, no audit log beyond stdout, and no multi-user separation. Treat the token like an SSH key.

### The file drawer can write, not just read

The file drawer opens files in a Monaco editor and can **save them back to disk**. This widens what the token buys: previously an attacker holding it could tell an agent to change files, and the agent was in the loop; now they can write file contents directly.

What still constrains a write:

- It goes through the same `resolveAndGate()` as reads — the same `BRIDGE_ALLOWED_DIRS` check, the same denylist (`.ssh`, `.aws`, `*.pem`, `id_rsa`, …), the same symlink-escape resolution.
- It can only **overwrite an existing regular file**. There is no create, no delete, no rename, no mkdir.
- It is capped by `BRIDGE_FS_WRITE_MAX_BYTES` (default 5 MB).
- It is refused if the file changed on disk since the browser loaded it, unless the user explicitly confirms the overwrite.
- Saving takes a deliberate second press in the UI; the first press only asks.

If you would rather the drawer stayed read-only, there is no flag for that yet — set `BRIDGE_FS_WRITE_MAX_BYTES` to `1` and every realistic save will be refused.

### Agents can start other agents

A Claude session can spawn a second agent through the `spawn_session` MCP tool, which means one prompt can end up running more than one CLI in your allow-listed tree. The bounds — depth 1, five children per parent, caller's directory by default, and the same `BRIDGE_ALLOWED_DIRS` check — are described under [Agent-to-agent spawning](#agent-to-agent-spawning). There is no way to disable the tool short of not running Claude sessions; if that matters to you, say so and it should become an env flag.

## Requirements

- macOS 13+ (developed on Darwin 25). Linux likely works but is untested.
- Node.js 20 (`.nvmrc` pinned).
- npm 10+ (workspace support).
- A working install of at least one supported agent CLI on `PATH`:
  - [`claude`](https://docs.claude.com/claude-code) — Anthropic Claude Code
  - [`codex`](https://github.com/openai/codex) — OpenAI Codex CLI
- [Tailscale](https://tailscale.com/) installed on the host **and** on every device you plan to connect from. Without Tailscale you have no safe network boundary; see security note above.
- Optional: a Telegram bot if you want push notifications for long turns. See `docs/setup/telegram-bot.md`.

## Quick start

```bash
# 1. Clone and install
git clone git@github.com:triracle97/Remote-Vibe.git remote-vibe
cd remote-vibe
npm install

# 2. Configure
cp .env.example .env
# Generate a token and paste it into .env as BRIDGE_TOKEN
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Edit BRIDGE_ALLOWED_DIRS to point at the directories you want to expose

# 3. Build the web bundle (the bridge serves it as static assets)
npm run web:build

# 4. Run the bridge
npm run bridge:dev
```

On boot the bridge prints something like:

```
[bridge] binding to 100.x.y.z:8765
[bridge] open: http://100.x.y.z:8765/?token=<TOKEN>
```

Open that URL from any Tailscale-connected device. The token is set as an HttpOnly cookie after the first successful load, so you only need it in the URL once per device.

## Configuration

All settings come from environment variables. The bridge auto-loads `.env` from the working directory at boot; shell exports win over `.env`. Point at a different file with `BRIDGE_ENV_FILE=/abs/path/some.env`.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `BRIDGE_TOKEN` | yes | — | Auth token. Minimum 24 chars. |
| `BRIDGE_ALLOWED_DIRS` | recommended | `$HOME` | Comma-separated directories the bridge will spawn inside and read from. |
| `BRIDGE_PORT` | no | `8765` | TCP port. |
| `BRIDGE_BIND_HOST` | no | first non-loopback Tailscale IPv4 | Override the bind address. |
| `BRIDGE_DATA_DIR` | no | `$HOME/.config/mac-remote-terminal` | Where transcripts, prompts, images, and session registry live. |
| `BRIDGE_TRANSCRIPT_RETENTION_DAYS` | no | `0` (keep forever) | Days to keep JSONL transcripts. `0` disables pruning. |
| `BRIDGE_SESSIONS_FILE` | no | `.bridge/sessions.json` | Session registry path. |
| `BRIDGE_PROFILES_FILE` | no | `.bridge/profiles.json` | Profile registry path. |
| `BRIDGE_FILE_SEARCH_CAP` | no | `5000` | Max files walked per session for `@`-tag picker. |
| `BRIDGE_TELEGRAM_BOT_TOKEN` | no | — | Enables long-turn notifications. |
| `BRIDGE_TELEGRAM_CHAT_ID` | no | — | Chat that receives notifications. |
| `BRIDGE_NOTIFY_MIN_DURATION_MS` | no | `180000` | Notify only when a turn exceeds this many ms. `0` notifies every turn. |
| `BRIDGE_PUBLIC_URL` | no | — | URL embedded in Telegram messages. Use your Tailscale URL. |
| `BRIDGE_CLAUDE_CONFIG_DIR` | no | CLI default (`~/.claude`) | Absolute `CLAUDE_CONFIG_DIR` for every Claude session. `~` is expanded; relative paths are rejected. |
| `BRIDGE_HEADROOM_ENABLED` | no | `true` | Route Claude *and* Codex API traffic through a local Headroom proxy. |
| `BRIDGE_HEADROOM_BIN` | no | `headroom` | Headroom binary. Set an absolute path if it is not on the bridge's `PATH`. |
| `BRIDGE_HEADROOM_PORT` | no | `8787` | Port for the shared Headroom proxy. |
| `BRIDGE_TITLER_ENABLED` | no | `true` | Name sessions by asking an agent to title them after the first turn. |
| `BRIDGE_TITLER_MODEL` | no | `claude-haiku-4-5` | Model used for the titler call. |

A working template is in `.env.example`.

### Claude config profiles

`BRIDGE_CLAUDE_CONFIG_DIR` swaps the entire Claude profile — settings, hooks,
enabled plugins, slash commands, and native session history. Pointing it at a
second config dir is how you give bridge sessions a different plugin set from
your desktop Claude Code:

```bash
BRIDGE_CLAUDE_CONFIG_DIR=~/.claude1
```

Additional named profiles go in `<BRIDGE_DATA_DIR>/accounts.json` alongside the
Codex accounts, and appear in the session picker:

```json
{
  "claude_config_dirs": [
    { "name": "work", "configDir": "/Users/me/.claude-work" }
  ]
}
```

Both `list_accounts` and the session picker distinguish them by `agent`, so
Codex accounts (`CODEX_HOME`) and Claude profiles (`CLAUDE_CONFIG_DIR`) are
selected independently.

### Agent-to-agent spawning

A running Claude session can start a second agent — typically Codex — to work in
parallel, via an MCP tool the bridge serves at `POST /mcp`:

```
spawn_session({ agent: "codex", prompt: "port the parser tests" })
```

The spawned session appears on the same board, wrapped in Headroom like any
other, using the Codex `default` account. Its card shows `↳ spawned by <name>`,
and the parent's header shows a count linking to its children.

A tool rather than an `mrt:` directive on purpose. The directive channel acts on
a text pattern, and the worst a stray pattern can do today is move a card;
spawning a process is a different magnitude, and a marker the agent might echo
from a file it read is too weak a trigger for it. A tool call has to be chosen
by the model and is visible in the transcript.

Guard rails, all enforced in `mcp-server.ts`:

- **Depth 1.** A spawned session cannot spawn — otherwise it is a fork bomb with
  a model choosing the branching factor.
- **Five children per parent.**
- The working directory defaults to the caller's own and still passes through
  `BRIDGE_ALLOWED_DIRS`.
- Codex is pinned to the `default` account; choosing between named accounts stays
  a human decision.

Each Claude session is launched with `--mcp-config <dataDir>/mcp/<id>.json`,
written at spawn time and containing the bridge token plus that session's id.
The id is how `spawn_session` knows who is calling — the agent never sees it and
cannot forge it. The file is `0600`, and nothing is ever written to the user's
`~/.claude.json`. `--strict-mcp-config` is deliberately not passed, so your own
MCP servers keep working.

Codex sessions get no bridge tools: `--no-mcp` on the headroom wrapper suppresses
Codex's MCP registration, which is also why spawned work cannot spawn again.

### Headroom

When enabled, the bridge owns exactly **one** Headroom proxy, shared by **both**
agents:

```
headroom wrap claude --port 8787 --no-proxy --no-mcp --no-serena --no-rtk -- <claude flags>
headroom wrap codex  --port 8787 --no-proxy --no-mcp --no-serena --no-rtk -- <codex args>
```

`wrap claude` sets `ANTHROPIC_BASE_URL`, `wrap codex` sets `OPENAI_BASE_URL`; one
proxy serves both. Terminal sessions are **not** wrapped — a raw shell has no API
traffic to route.

- `--no-proxy` because concurrent sessions would otherwise race to bind the port.
  If a proxy is already listening the bridge reuses it and never kills it.
- `--no-mcp --no-serena --no-rtk` because those steps rewrite the agent's active
  config (`.claude.json` / the Codex config file), and concurrent sessions would
  race on the same file. The bridge has no business editing your profile.
- The `--` separator is mandatory: headroom's own `-p/--port` and `-v/--verbose`
  are real options and would be consumed before the agent saw them.

Both drivers spawn `detached`, into their own process group. Under the wrapper the
agent is a *grandchild* of a Python process that exits on SIGTERM without
forwarding it, so stopping a session signals the group (`kill(-pid)`) rather than
the direct child — otherwise the agent would be orphaned and keep burning tokens.

Headroom prints a banner to stdout before exec'ing the CLI; the stream parser
ignores non-JSON lines, so it does not corrupt the transcript. If the proxy
cannot start, sessions spawn unwrapped rather than failing.

## Session names

Names come from the agent, not from slicing your prompt. When the first turn
finishes, the bridge makes a **separate** one-shot `claude -p` call with the
opening request and the agent's reply, and asks for a 3–6 word title. It runs
outside the session, so it never touches the conversation or transcript, and a
failure costs you the title rather than the session.

Until that lands, the card shows a provisional name derived from your first
prompt (with any leading `/command` and `@tags` stripped), so it is never blank.

**Renaming a session by hand pins it** — automatic naming leaves pinned names
alone, permanently. Rename from the session list, the session header, or the
board's card detail sheet.

Turn it off with `BRIDGE_TITLER_ENABLED=false`; sessions then keep the
prompt-derived name.

## Board

`/board` is a Kanban view of every session the bridge knows about — live and
historical — grouped into `Backlog / Planning / Implementing / Verifying / Done`.

### How a card moves

A new session starts in **Planning**. Three things can move it after that, in
increasing order of authority:

1. **Inference** — the bridge watches the transcript: `ExitPlanMode` or a file
   edit → Implementing, a test/build/lint command or a fully-completed TodoWrite
   → Verifying, session end → Done. Inference only ever moves **forward**.
2. **The agent itself** — it can emit an HTML comment in any reply:

   ```
   <!--mrt:phase=verifying-->
   <!--mrt:tags=api,bug-->
   ```

   The marker is stripped before the text reaches any client or the transcript
   on disk, so you never see it. Unlike inference this may move the phase
   *backwards* — the agent knows when it has gone back to planning. Claude
   learns about the channel through `--append-system-prompt`; Codex sessions
   fall back to inference.
3. **You** — dragging a card, or using the phase picker in the card detail
   sheet, sets the phase and **pins** it. A pin turns off both inference and the
   agent's directives for that session: the column is yours from then on. Tags
   are never pinned, so the agent can keep tagging a card whose phase you own.

## Durability

The bridge keeps its own record of every session, independent of the agent
CLI's history (which rotates):

- `.bridge/sessions.json` — the registry: name, phase, tags, project, agent,
  config dir, timestamps. This is what the board reads.
- `.bridge/jobs.json` — Backlog jobs.
- `<BRIDGE_DATA_DIR>/transcripts/<session>.jsonl` — the full event stream.

**Transcripts are kept forever by default** (`BRIDGE_TRANSCRIPT_RETENTION_DAYS=0`).
Set a positive number only if disk pressure demands it — these are the only copy
that outlives the CLI's own history.

One caveat: *viewing* an old session only needs our transcript, but *resuming*
one asks the agent CLI to reopen its own conversation by id. If the CLI has
rotated that conversation away, resume fails and the card falls back to
read-only transcript view.

## Scripts

Run from the repo root:

| Command | What it does |
| --- | --- |
| `npm run bridge:dev` | Start bridge with `tsx watch` (auto-reload on source change). |
| `npm run bridge:build` | Compile bridge to `packages/bridge/dist`. |
| `npm run web:dev` | Vite dev server for the web UI (proxy/CORS not configured — use the production flow above for end-to-end testing). |
| `npm run web:build` | Build the React bundle into `apps/web/dist`. The bridge serves this. |
| `npm run test` | Run bridge + web test suites (vitest). |
| `npm run typecheck` | TypeScript check across both workspaces. |
| `npm run build` | Build web then bridge. |

## Repository layout

```
packages/bridge/  Node WebSocket + HTTP server. Spawns agent CLIs via node-pty.
apps/web/         React + Vite + Tailwind UI. Served as static assets by the bridge.
docs/setup/       Operator-facing setup notes (e.g. Telegram bot).
docs/superpowers/ Internal design specs and plan docs.
.bridge/          Runtime state: sessions.json, profiles.json, transcripts. Created on first run.
```

## Known issues / rough edges

- **macOS only in practice.** `node-pty` builds elsewhere, but Tailscale-IP detection and CLI auto-discovery have only been exercised on macOS.
- **No multi-user model.** Anyone holding `BRIDGE_TOKEN` can spawn processes in any allow-listed directory. There is no per-user scoping.
- **Terminal mode requires `node-pty`.** If the prebuilt binary is missing for your Node version the bridge logs `node-pty failed to load — terminal mode disabled` and continues without the `/terminal/:id` route. Reinstall against your Node version or rebuild with `npm rebuild node-pty`.
- **CORS / Origin.** The bridge enforces an origin allowlist tied to the bind address. If you proxy through a different hostname, requests will be rejected until you wire that hostname in.
- **`.env` is not encrypted at rest.** Real Telegram bot tokens live on disk; treat the file like an SSH key. Rotate via @BotFather if it leaks.
- **`.bridge/` is local state.** It is not gitignored by default if you fork — add it to `.gitignore` before committing or you will leak project paths.
- **Hard-coded workspace examples.** `apps/web/src/features/project-picker/default-workspaces.ts` ships a sample list. Replace with your own or empty it before sharing screenshots.
- **No production-grade Vite dev experience.** The bridge expects `apps/web/dist`. Running `npm run web:dev` alone will not talk to the bridge; rebuild after each UI change or stand up your own proxy.
- **Transcript pruning is best-effort.** Retention runs once at startup, not on a schedule.
- **No Windows support.** PTY handling and shell defaults assume POSIX.
- **Codex images are written to disk before each turn.** `codex exec` takes images as `-i <FILE>`, not inline, so pasted images land in `<BRIDGE_DATA_DIR>/images/<sessionId>/` (mode `0600`) and are passed by path. That directory is the audit trail and the input at once; it is cleared when the session is deleted.
- **The Monaco chunk is big.** The editor is lazy-loaded, so the initial page is unaffected, but opening the first file pulls ~3.8 MB (990 KB gzipped) and opening a `.ts`/`.js` file pulls the TypeScript worker on top of that. The bridge gzips static assets, and the browser caches them after the first open, but the first file you open on a cold phone is slow. Monaco's touch handling is also unproven here — nimbalyst, where this editor came from, only ever shipped it on desktop Electron.
- **The editor cannot create or delete files.** It edits files that already exist. Use the agent for anything else.
- **Pasting a file's path reads the bridge host's clipboard.** The browser strips every path component off a pasted `File`, so when a paste carries no `file://` URI the composer asks the bridge to read the Mac's own pasteboard (`osascript`, no entitlement needed). The reply is restricted to paths whose basename the browser also saw, so a browser on a different machine — a phone over Tailscale — gets nothing rather than an unrelated path, and falls back to the session's file index as before.
- **The plan-usage ring shows `OK` more often than a number.** The CLI only reports a `utilization` figure once a quota window passes its own warning threshold. Below that it names the window and its reset time and nothing else, which renders as `OK` — a percentage would be invented.

## License

Not yet chosen. Until a license is added, default copyright applies — no permission to use, modify, or redistribute is granted.
