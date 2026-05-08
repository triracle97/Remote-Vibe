# Mobile Chat Shell Design

## Goal

Make the session chat page feel like a mobile messaging app on phone-width screens while preserving the current desktop layout and existing session, history, file explorer, and chat behavior.

## Scope

This is a focused mobile session-page improvement. Desktop keeps the current multi-panel layout: session list, history panel, chat, and optional file explorer in the page flow.

At mobile widths, chat becomes the primary full-screen surface. Session switching and history access move behind one menu drawer with `Sessions` and `History` tabs. The existing components and stores remain the source of truth; the work adds mobile shell state, mobile-only controls, and responsive CSS rather than creating a separate route.

## Architecture

`apps/web/src/pages/Session.tsx` owns the mobile shell state:

- Whether the mobile navigation drawer is open.
- Which drawer tab is active: `sessions` or `history`.
- Existing file explorer open state.

`Session.tsx` continues to render `SessionList`, `HistoryPanel`, `Chat`, `FileExplorer`, and the new-session picker. The difference is layout: desktop keeps the existing direct children, while mobile CSS treats chat as the main viewport and presents navigation panels in an overlay drawer.

The implementation should reuse current data flow. Selecting a session still calls `navigate('/session/:id')`. Resuming from history still uses the history store and sessions store. Sending messages, stopping sessions, image paste/drop, slash commands, and `@` completion stay inside the existing chat/input components.

## Components

### Session Page

`Session.tsx` adds mobile drawer markup around reused `SessionList` and `HistoryPanel` instances. The drawer includes:

- A fixed backdrop.
- A drawer panel sized for phone screens.
- Two tab buttons: `Sessions` and `History`.
- A close button.
- Drawer close behavior after selecting a session or resuming a history entry.

The drawer should be mounted only when open so hidden panels do not create extra tab stops.

### Chat

`Chat.tsx` gets an optional `onOpenMobileNav` prop. When present, the chat header renders a mobile-only menu button. The button is hidden on desktop through CSS and visible under the mobile breakpoint.

The chat header should remain compact on phone screens: menu button, truncated session/project identity, rename affordance, spacer, and file explorer toggle. Long project paths and session names must ellipsize instead of forcing horizontal scroll.

### Session List

`SessionList.tsx` gets an optional `onAfterSelect` callback. It calls the callback after selecting a session so the mobile drawer closes. Desktop callers can omit it.

### History Panel

`HistoryPanel.tsx` gets optional props for mobile drawer use:

- `defaultOpen`, so the panel can render its history body immediately inside the drawer.
- `onAfterResume`, called after a history row successfully resumes and navigates.

The existing collapsible desktop behavior stays unchanged when these props are not provided.

### File Explorer

The existing file explorer stays controlled by `drawerOpen`. On mobile, CSS should present it as a fixed overlay or near-full-screen panel above the chat, with its own close button already available in the component header. It should not stack below the chat because that would make the conversation and input hard to recover.

## Mobile Layout

The breakpoint remains `720px`, matching the existing mobile CSS pass.

Under `720px`:

- The session page becomes a single-screen chat experience.
- `.chat` uses dynamic viewport height (`100dvh`) and a column layout.
- `.chat-scroll` is the main scroll region.
- `.input-box` stays reachable at the bottom and respects safe-area inset padding.
- Desktop inline `.session-list` and `.history-panel` are not shown in the page flow.
- `.mobile-nav-drawer` is fixed, scrollable, and above the chat.
- `.mobile-nav-backdrop` dims the rest of the screen and closes the drawer when tapped.
- `.file-explorer` is fixed over the chat, with bounded tree and preview scroll regions.

The CSS must prevent horizontal overflow on common phone widths. Buttons and touch targets in mobile-only controls should be at least 44px high.

## Error Handling

The drawer should close only after successful navigation or resume. If history resume fails, the existing history error stays visible in the drawer. The backdrop and close button must always close the drawer without affecting the active session.

Existing chat error banners, transcript-only banners, dead-session resume prompts, and input-disabled behavior remain unchanged.

## Accessibility

Mobile drawer controls use real buttons with descriptive `aria-label` text where the visible label is icon-like. The drawer panel should have a clear accessible label, such as `aria-label="Mobile navigation"`.

When mounted, drawer content should be ordered predictably: close/header controls, tabs, then active panel content. The implementation does not need a full focus trap, but it must avoid rendering hidden inactive panels as focusable content.

## Testing

Add focused tests for the mobile shell contract:

- `Session` renders a mobile navigation trigger through `Chat`.
- Opening the drawer shows `Sessions` and `History` tabs.
- Switching tabs changes the drawer content.
- Selecting a session closes the drawer after navigation is requested.
- History panel mobile props preserve default desktop behavior when omitted.
- CSS contains the mobile overlay contract for drawer, backdrop, chat viewport, sticky/reachable input, and mobile file explorer.

Run:

- `npm run web:test`
- `npm run web:build`

If the broader repository still has unrelated bridge test issues, they remain out of scope for this mobile chat shell task. The completion gate for this work is the web test and build commands.

## Review

Self-review notes:

- No placeholders remain.
- The design is scoped to the chat session page and mobile behavior.
- Desktop behavior is explicitly preserved.
- Existing component ownership and stores remain the source of truth.
- Error handling and accessibility requirements are defined closely enough for implementation.
