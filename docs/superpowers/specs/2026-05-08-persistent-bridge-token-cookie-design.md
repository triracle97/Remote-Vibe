# Persistent Bridge Token Cookie Design

## Goal

Let a trusted browser reopen the bridge URL without re-entering `?token=<TOKEN>` every time, while keeping the bridge token out of frontend JavaScript.

## Scope

This is a server-side auth cookie persistence change. The existing bootstrap flow stays the same:

1. User opens `/?token=<TOKEN>`.
2. Server validates the token.
3. Server sets `bridge_session`.
4. Server redirects to `/`.
5. Later HTTP and WebSocket requests authenticate through the cookie.

The change is to make `bridge_session` persist for 30 days instead of behaving as a browser-session cookie.

## Design

Update `packages/bridge/src/auth.ts` so `buildSessionCookie(token)` includes `Max-Age=2592000`, which is 30 days.

The cookie remains:

- `HttpOnly`, so frontend JavaScript cannot read it.
- `SameSite=Strict`, so cross-site requests do not send it.
- `Path=/`, so the app, transcript endpoint, and WebSocket upgrade can use the same cookie.

The cookie still stores the existing single bridge token. This preserves the current single-user auth model and avoids adding a separate session database or token store.

## Security Notes

Do not move the token into `localStorage`, `sessionStorage`, React state, or any JS-readable URL cache. A persistent HttpOnly cookie solves the repeated-token prompt without increasing frontend token exposure.

The cookie intentionally still omits `Secure` because the bridge is designed for Tailscale-internal HTTP. Tailscale supplies transport encryption, and adding `Secure` would prevent the cookie from being stored on `http://` bridge URLs.

## Testing

Update bridge auth tests to assert that `buildSessionCookie` includes:

- `bridge_session=<token>`
- `HttpOnly`
- `SameSite=Strict`
- `Path=/`
- `Max-Age=2592000`

Run the focused bridge auth tests, then the bridge test suite if local baseline allows it.

## Review

Self-review notes:

- No placeholders remain.
- The design keeps token storage server-auth-cookie based, not frontend JS based.
- Scope is limited to persistence duration for the existing cookie.
- The 30-day duration matches the approved user choice.
