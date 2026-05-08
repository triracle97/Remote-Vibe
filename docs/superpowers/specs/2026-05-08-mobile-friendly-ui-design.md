# Mobile Friendly UI Design

## Goal

Make the existing React web UI usable on phone-width screens without changing the desktop interaction model.

## Scope

Use a CSS-first responsive stacking pass. Keep the current components and flows: session list, history panel, chat, project picker, and file explorer remain the same features with the same state ownership. On narrow screens, panels should stack vertically and use full-width layouts instead of fixed-width sidebars.

This does not introduce mobile drawers, a new shell, or a redesigned navigation flow.

## Layout

Desktop keeps the current flex row structure: session list on the left, history beside it, chat as the main area, and file explorer as an optional right panel.

At mobile widths, `#root` becomes a column. The session list and history panel use full width with bounded vertical height and internal scrolling. Chat uses dynamic viewport sizing so the input remains reachable on mobile browser chrome changes. The file explorer becomes a full-width stacked panel with bounded tree and preview regions.

## Component Responsibilities

- `apps/web/src/App.css` owns the root layout, home page spacing, banners, and mobile root stacking.
- `apps/web/src/features/session-list/SessionList.css` owns responsive sizing and touch-friendly rows for the session list.
- `apps/web/src/features/history/history.css` owns responsive history panel spacing and scroll bounds.
- `apps/web/src/features/chat/Chat.css` owns mobile chat viewport height, message spacing, input layout, and button wrapping.
- `apps/web/src/features/file-explorer/FileExplorer.css` owns mobile full-width explorer layout.
- `apps/web/src/features/project-picker/ProjectPicker.css` owns mobile modal sizing and action wrapping.

## Testing

Add a focused frontend test that reads the CSS files and asserts the mobile media-query contract exists for the key responsive selectors. Run that test red before changing CSS, then run it green after the CSS changes. Finish with `npm run web:test` and `npm run web:build`.

The full repository baseline currently has a pre-existing bridge timeout in `packages/bridge/src/__tests__/http-server.test.ts`, so completion for this frontend task is based on the web test/build commands.

## Review

Self-review notes:

- No placeholders remain.
- Scope is limited to the approved CSS-first approach.
- Requirements map directly to the files listed above.
- The bridge baseline issue is recorded as out of scope for this mobile UI task.
