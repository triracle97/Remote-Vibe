# Default Workspace Dirs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefill new sessions/profiles with three default workspace dirs and persist them when resuming native history.

**Architecture:** Add small constants in web and bridge code. Use the web constant in ProjectPicker/ProfileEditor defaults. Use the bridge constant during native-history resume and forward persisted `additionalDirs` during bridge-known resume.

**Tech Stack:** React, Zustand, Vitest, TypeScript bridge.

---

### Task 1: Web Defaults

**Files:**
- Create: `apps/web/src/features/project-picker/default-workspaces.ts`
- Modify: `apps/web/src/features/project-picker/ProjectPicker.tsx`
- Modify: `apps/web/src/features/profiles/ProfileEditor.tsx`
- Test: `apps/web/src/features/project-picker/ProjectPicker.test.tsx`
- Test: `apps/web/src/features/profiles/ProfileEditor.test.tsx`

- [ ] Write failing tests that expect the three default dirs in ProjectPicker and new ProfileEditor drafts.
- [ ] Run `npm run web:test -- ProjectPicker ProfileEditor` and verify the new tests fail.
- [ ] Add `DEFAULT_WORKSPACE_DIRS` and use it to initialize/reset picker dirs and new profile drafts.
- [ ] Run `npm run web:test -- ProjectPicker ProfileEditor` and verify tests pass.

### Task 2: Bridge Resume Persistence

**Files:**
- Create: `packages/bridge/src/default-workspaces.ts`
- Modify: `packages/bridge/src/session.ts`
- Test: `packages/bridge/src/__tests__/session.test.ts`

- [ ] Write failing tests for native-history resume storing default dirs as `additionalDirs`, de-duped against the resumed primary cwd.
- [ ] Write failing tests for bridge-known resume forwarding registry `additionalDirs` into the driver factory.
- [ ] Run `npm run bridge:test -- session` and verify new tests fail.
- [ ] Add bridge default workspace resolution and pass stored `additionalDirs` to resume driver creation.
- [ ] Run `npm run bridge:test -- session` and verify tests pass.

### Task 3: Verification

**Files:**
- All changed files.

- [ ] Run `npm run web:test -- ProjectPicker ProfileEditor`.
- [ ] Run `npm run bridge:test -- session`.
- [ ] Run `npm run web:build`.
- [ ] Run `npm run bridge:typecheck`.
- [ ] Run `git diff --check`.
- [ ] Commit the implementation.
