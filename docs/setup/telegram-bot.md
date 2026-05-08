# Telegram bot setup for mac-remote-terminal notifications

When a Claude/Codex turn runs longer than `BRIDGE_NOTIFY_MIN_DURATION_MS` (default 3 min), the bridge sends a Telegram message to your account when the turn completes. Setup takes ~5 minutes.

## 1. Create the bot

1. Open Telegram, search for `@BotFather`.
2. Send `/newbot`. Pick a name (e.g. "My Mac Bridge"). Pick a username ending in `bot` (e.g. `mymacbridge_bot`).
3. BotFather replies with a token like `1234567890:ABCDEFGhijklMNOPqrstuvwxyz_0123456789`. Copy it. Treat as a secret.

## 2. Find your chat_id

1. Send any message to your new bot in Telegram (e.g. `hello`).
2. Run:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

3. Look for `"chat":{"id":12345678,...}` in the JSON response. Copy the number — that's your `chat_id`.

If `getUpdates` returns an empty `result` array, send another message to the bot first (the API only shows recent messages).

## 3. Configure the bridge

Add to your shell profile (`~/.zshrc` / `~/.bashrc`) or wherever you set bridge env vars:

```bash
export BRIDGE_TELEGRAM_BOT_TOKEN="<token from step 1>"
export BRIDGE_TELEGRAM_CHAT_ID="<chat_id from step 2>"
export BRIDGE_NOTIFY_MIN_DURATION_MS=180000   # default 3 min; set 0 to notify on every turn
export BRIDGE_PUBLIC_URL="http://100.x.x.x:7777"   # optional; included as link in message
```

Restart the bridge.

## 4. Verify

Run a Claude session and ask it something that takes > 3 minutes (e.g. `find every TypeScript error in this repo and explain the most surprising one`). When the turn completes, you should receive:

```
Session 'find every TypeScript error in this repo and ex…' completed
took 5m 23s
http://100.x.x.x:7777/session/<id>
```

Click the link on your phone (Tailscale on) → opens the session.

## Tuning

- **Less noise**: set `BRIDGE_NOTIFY_MIN_DURATION_MS=600000` (10 min) so only really-long turns ping you.
- **Every turn**: set `BRIDGE_NOTIFY_MIN_DURATION_MS=0` to notify on every `result` event.
- **Rename a session** before kicking off a long turn: click the pencil icon next to the session name in the sidebar; the new name appears in the Telegram message.

## Troubleshooting

- **No message arrives**: check the bridge stderr — it logs `[notifier] sendMessage failed:` if the API rejects. Verify token + chat_id.
- **5 consecutive failures**: bridge logs a one-time warning suggesting env var check. Counter resets on first success.
- **Link doesn't open**: verify `BRIDGE_PUBLIC_URL` is set and reachable from your phone (Tailscale on, correct port). Trailing slash is sanitized automatically.
- **Notifier silently disabled**: if either `BRIDGE_TELEGRAM_BOT_TOKEN` or `BRIDGE_TELEGRAM_CHAT_ID` is unset, the notifier is a no-op stub. No errors logged. Check both env vars are exported in the bridge's process.
