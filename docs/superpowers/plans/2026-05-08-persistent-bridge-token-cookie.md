# Persistent Bridge Token Cookie Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the existing bridge auth cookie for 30 days so trusted browsers do not need `?token=<TOKEN>` on every visit.

**Architecture:** Keep the current token bootstrap flow and single-token auth model. Change only the cookie builder in `packages/bridge/src/auth.ts` and its focused tests so the cookie remains HttpOnly/SameSite/Path scoped while adding `Max-Age=2592000`.

**Tech Stack:** Node 20, TypeScript, Vitest.

---

## File Structure

- Modify `packages/bridge/src/auth.ts`: add a named 30-day max-age constant and include it in `buildSessionCookie`.
- Modify `packages/bridge/src/__tests__/auth.test.ts`: assert the persistent max-age attribute.

## Task 1: Persistent Cookie Attribute

**Files:**
- Modify: `packages/bridge/src/auth.ts`
- Modify: `packages/bridge/src/__tests__/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Update the existing `buildSessionCookie` test in `packages/bridge/src/__tests__/auth.test.ts`:

```ts
describe('buildSessionCookie', () => {
  it('returns persistent cookie with HttpOnly, SameSite=Strict, Path=/', () => {
    const c = buildSessionCookie(T);
    expect(c).toContain(`bridge_session=${T}`);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Path=/');
    expect(c).toContain('Max-Age=2592000');
    expect(c).not.toContain('Secure');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run bridge:test -- auth`

Expected: FAIL because `Max-Age=2592000` is not present.

- [ ] **Step 3: Implement cookie persistence**

Update `packages/bridge/src/auth.ts`:

```ts
const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
```

Update `buildSessionCookie`:

```ts
export function buildSessionCookie(token: string): string {
  return `bridge_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`;
}
```

- [ ] **Step 4: Run focused tests**

Run: `npm run bridge:test -- auth`

Expected: PASS.

- [ ] **Step 5: Run bridge typecheck**

Run: `npm run bridge:typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/bridge/src/auth.ts packages/bridge/src/__tests__/auth.test.ts
git commit -m "feat(bridge): persist auth cookie for 30 days"
```

## Self-Review

- Spec coverage: the plan updates the cookie builder and test for the approved 30-day duration.
- Placeholder scan: no placeholder implementation steps remain.
- Type consistency: the constant and cookie string are both in seconds, matching `Max-Age`.
