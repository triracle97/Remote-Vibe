# Mobile Friendly UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing web UI usable on phone-width screens with a CSS-first responsive stacking pass.

**Architecture:** Keep the current React component structure and state flow. Add a focused CSS contract test, then update the existing CSS modules with mobile media queries that stack panels, bound scroll regions, and improve touch spacing while preserving desktop layout.

**Tech Stack:** React 18, Vite, Vitest, CSS media queries.

---

### Task 1: Responsive CSS Contract Test

**Files:**
- Create: `apps/web/src/responsive-css.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

function readCss(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('mobile responsive CSS contract', () => {
  it('stacks the root layout and major panels at phone widths', () => {
    const css = [
      readCss('src/App.css'),
      readCss('src/features/session-list/SessionList.css'),
      readCss('src/features/history/history.css'),
      readCss('src/features/chat/Chat.css'),
      readCss('src/features/file-explorer/FileExplorer.css'),
      readCss('src/features/project-picker/ProjectPicker.css'),
    ].join('\n');

    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toMatch(/#root\s*{[^}]*flex-direction:\s*column/s);
    expect(css).toMatch(/\.session-list\s*{[^}]*width:\s*100%/s);
    expect(css).toMatch(/\.history-panel\s*{[^}]*width:\s*100%/s);
    expect(css).toMatch(/\.chat\s*{[^}]*min-height:\s*100dvh/s);
    expect(css).toMatch(/\.file-explorer\s*{[^}]*width:\s*100%/s);
    expect(css).toMatch(/\.picker\s*{[^}]*max-height:\s*calc\(100dvh - 1rem\)/s);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run web:test -- responsive-css.test.ts`

Expected: FAIL because the CSS does not yet contain the mobile media-query contract.

### Task 2: Mobile CSS Implementation

**Files:**
- Modify: `apps/web/src/App.css`
- Modify: `apps/web/src/features/session-list/SessionList.css`
- Modify: `apps/web/src/features/history/history.css`
- Modify: `apps/web/src/features/chat/Chat.css`
- Modify: `apps/web/src/features/file-explorer/FileExplorer.css`
- Modify: `apps/web/src/features/project-picker/ProjectPicker.css`

- [ ] **Step 1: Add mobile media queries**

Add `@media (max-width: 720px)` blocks that:

```css
#root {
  min-height: 100dvh;
  flex-direction: column;
}

.session-list,
.history-panel,
.file-explorer {
  width: 100%;
}

.chat {
  min-height: 100dvh;
}

.picker {
  max-height: calc(100dvh - 1rem);
}
```

Extend those blocks with file-specific overflow bounds, touch spacing, wrapped buttons, and reduced padding.

- [ ] **Step 2: Run the contract test**

Run: `npm run web:test -- responsive-css.test.ts`

Expected: PASS.

### Task 3: Frontend Verification

**Files:**
- No code changes.

- [ ] **Step 1: Run all frontend tests**

Run: `npm run web:test`

Expected: PASS with all frontend test files passing.

- [ ] **Step 2: Run production build**

Run: `npm run web:build`

Expected: PASS with TypeScript build and Vite build completing.

- [ ] **Step 3: Inspect final diff**

Run: `git diff -- apps/web/src docs/superpowers/plans/2026-05-08-mobile-friendly-ui.md`

Expected: Diff contains only the responsive CSS test, scoped CSS changes, and this plan.

## Self-Review

- Spec coverage: all design files are represented in Task 2; verification requirement is represented in Task 3.
- Placeholder scan: no TBD or unspecified implementation steps remain.
- Type consistency: the test file path and CSS selectors match existing project paths and class names.
