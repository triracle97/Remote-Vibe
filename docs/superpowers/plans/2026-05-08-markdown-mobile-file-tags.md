# Markdown Mobile File Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve markdown presentation and mobile `@` file autocomplete ergonomics.

**Architecture:** Keep parsing and search logic unchanged. Add only renderer structure needed for scrollable tables, row spans for file suggestions, and CSS polish.

**Tech Stack:** React, ReactMarkdown, Vitest, CSS.

---

### Task 1: Markdown Presentation

**Files:**
- Modify: `apps/web/src/features/markdown/MarkdownRenderer.tsx`
- Modify: `apps/web/src/features/markdown/markdown.css`
- Test: `apps/web/src/features/markdown/MarkdownRenderer.test.tsx`
- Test: `apps/web/src/responsive-css.test.ts`

- [ ] Add failing tests for `.md-table-wrap` and markdown CSS contract.
- [ ] Run `npm run web:test -- MarkdownRenderer responsive-css` and verify the new tests fail.
- [ ] Add the table wrapper component and CSS presentation rules.
- [ ] Rerun the same tests and verify they pass.

### Task 2: Mobile File Tags

**Files:**
- Modify: `apps/web/src/features/chat/AtTagAutocomplete.tsx`
- Modify: `apps/web/src/App.css`
- Test: `apps/web/src/features/chat/AtTagAutocomplete.test.tsx`
- Test: `apps/web/src/responsive-css.test.ts`

- [ ] Add failing tests for filename/path row spans and mobile CSS contract.
- [ ] Run `npm run web:test -- AtTagAutocomplete responsive-css` and verify the new tests fail.
- [ ] Add the row spans and mobile bottom-sheet CSS.
- [ ] Rerun the same tests and verify they pass.

### Task 3: Verification

**Files:**
- All changed files.

- [ ] Run `npm run web:test -- MarkdownRenderer AtTagAutocomplete responsive-css`.
- [ ] Run `npm run web:build`.
- [ ] Run `git diff --check`.
- [ ] Commit the implementation.
