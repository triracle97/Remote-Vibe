# mac-remote-terminal

Run Claude Code / Codex CLI on your Mac, control it from any device on your Tailscale network through a web UI. Built as a private bridge between a coding agent CLI and a phone-or-laptop browser, so you can drive long-running coding sessions away from your desk.

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
git clone <repo-url> mac-remote-terminal
cd mac-remote-terminal
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
| `BRIDGE_TRANSCRIPT_RETENTION_DAYS` | no | `30` | Days to keep JSONL transcripts. `0` disables pruning. |
| `BRIDGE_SESSIONS_FILE` | no | `.bridge/sessions.json` | Session registry path. |
| `BRIDGE_PROFILES_FILE` | no | `.bridge/profiles.json` | Profile registry path. |
| `BRIDGE_FILE_SEARCH_CAP` | no | `5000` | Max files walked per session for `@`-tag picker. |
| `BRIDGE_TELEGRAM_BOT_TOKEN` | no | — | Enables long-turn notifications. |
| `BRIDGE_TELEGRAM_CHAT_ID` | no | — | Chat that receives notifications. |
| `BRIDGE_NOTIFY_MIN_DURATION_MS` | no | `180000` | Notify only when a turn exceeds this many ms. `0` notifies every turn. |
| `BRIDGE_PUBLIC_URL` | no | — | URL embedded in Telegram messages. Use your Tailscale URL. |

A working template is in `.env.example`.

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

## License

Not yet chosen. Until a license is added, default copyright applies — no permission to use, modify, or redistribute is granted.
