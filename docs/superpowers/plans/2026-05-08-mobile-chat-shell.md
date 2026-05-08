# Mobile Chat Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the session chat page behave like a mobile messaging app by putting sessions and history behind one mobile drawer while preserving the desktop layout.

**Architecture:** Keep existing stores and core components as the source of truth. Add small optional props to `SessionList`, `HistoryPanel`, and `Chat`, then have `Session.tsx` own the mobile drawer state and reuse those components inside a fixed overlay. CSS under the existing `720px` breakpoint makes chat fill the viewport and turns the file explorer into a mobile overlay.

**Tech Stack:** React 18, React Router, Zustand, Vitest, Testing Library, Vite, CSS media queries.

---

## File Structure

- Modify `apps/web/src/features/session-list/SessionList.tsx`: add optional `onAfterSelect` callback.
- Modify `apps/web/src/features/session-list/SessionList.test.tsx`: cover callback behavior.
- Modify `apps/web/src/features/history/HistoryPanel.tsx`: add optional `defaultOpen` and `onAfterResume` props.
- Modify `apps/web/src/features/history/HistoryPanel.test.tsx`: cover mobile-friendly props and desktop defaults.
- Modify `apps/web/src/features/chat/Chat.tsx`: add optional mobile nav trigger prop and button.
- Create `apps/web/src/features/chat/Chat.test.tsx`: cover the mobile nav trigger contract.
- Modify `apps/web/src/pages/Session.tsx`: add mobile drawer state, tab UI, reused panel instances, and close-on-navigation behavior.
- Create `apps/web/src/pages/Session.mobile-shell.test.tsx`: cover drawer open, tab switch, and close behavior with mocked child components.
- Modify `apps/web/src/App.css`: add mobile shell drawer/backdrop styles.
- Modify `apps/web/src/features/chat/Chat.css`: add mobile header trigger, viewport, scroll, input, and overflow rules.
- Modify `apps/web/src/features/file-explorer/FileExplorer.css`: make file explorer a mobile overlay.
- Modify `apps/web/src/responsive-css.test.ts`: extend CSS contract for mobile chat shell selectors.

## Task 1: SessionList Close Callback

**Files:**
- Modify: `apps/web/src/features/session-list/SessionList.tsx`
- Modify: `apps/web/src/features/session-list/SessionList.test.tsx`

- [ ] **Step 1: Write the failing test**

Add this test to the `SessionList` describe block in `apps/web/src/features/session-list/SessionList.test.tsx`:

```ts
  it('calls onAfterSelect after selecting a session', () => {
    const onSelect = vi.fn();
    const onAfterSelect = vi.fn();
    const session = makeSession({ sessionId: 's1' });

    const { container } = render(
      <SessionList
        sessions={[session]}
        activeId={null}
        onSelect={onSelect}
        onNewSession={() => {}}
        onAfterSelect={onAfterSelect}
      />,
    );
    const btn = container.querySelector('.session-row button')!;
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledWith('s1');
    expect(onAfterSelect).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run web:test -- SessionList.test.tsx`

Expected: FAIL with a TypeScript error because `onAfterSelect` is not in `SessionListProps`.

- [ ] **Step 3: Implement the callback**

Update `apps/web/src/features/session-list/SessionList.tsx`:

```ts
interface SessionListProps {
  sessions: SessionView[];
  activeId: string | null;
  onSelect(id: string): void;
  onNewSession(): void;
  onAfterSelect?(): void;
}
```

Update `SessionRow` props:

```ts
function SessionRow({
  session,
  activeId,
  onSelect,
  onAfterSelect,
}: {
  session: SessionView;
  activeId: string | null;
  onSelect: (id: string) => void;
  onAfterSelect?: () => void;
}): JSX.Element {
```

Update the row button:

```tsx
      <button
        type="button"
        onClick={() => {
          onSelect(session.sessionId);
          onAfterSelect?.();
        }}
      >
```

Update the exported component signature and row usage:

```tsx
export function SessionList({
  sessions,
  activeId,
  onSelect,
  onNewSession,
  onAfterSelect,
}: SessionListProps): JSX.Element {
  return (
    <aside className="session-list">
      <button className="session-new" type="button" onClick={onNewSession}>
        + New session
      </button>
      <ul>
        {sessions.length === 0 && <li className="session-empty">No active sessions</li>}
        {sessions.map((s) => (
          <SessionRow
            key={s.sessionId}
            session={s}
            activeId={activeId}
            onSelect={onSelect}
            onAfterSelect={onAfterSelect}
          />
        ))}
      </ul>
    </aside>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run web:test -- SessionList.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/session-list/SessionList.tsx apps/web/src/features/session-list/SessionList.test.tsx
git commit -m "feat(web): close mobile nav after session select"
```

## Task 2: HistoryPanel Mobile Props

**Files:**
- Modify: `apps/web/src/features/history/HistoryPanel.tsx`
- Modify: `apps/web/src/features/history/HistoryPanel.test.tsx`

- [ ] **Step 1: Write failing tests**

Add these tests to `apps/web/src/features/history/HistoryPanel.test.tsx`:

```ts
  it('can render open by default for mobile drawer use', () => {
    const { container } = render(<HistoryPanel defaultOpen />);
    expect(container.querySelector('.history-body')).toBeTruthy();
    expect(container.textContent).toMatch(/no past sessions/i);
  });

  it('calls onAfterResume after a successful history resume', async () => {
    const resumeFromHistory = vi.fn().mockResolvedValue('new-id');
    const onAfterResume = vi.fn();
    (useSessionsStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({ resumeFromHistory });
    const entry = {
      agent: 'claude' as const,
      sessionId: 'a',
      projectPath: '/x/proj',
      mtime: Date.now(),
      firstPrompt: 'hi',
    };
    useHistoryStore.setState({ claude: [entry], codex: [], loading: false, lastFetched: Date.now() });
    const { container } = render(<HistoryPanel defaultOpen onAfterResume={onAfterResume} />);
    const row = container.querySelector('button.history-row') as HTMLButtonElement;
    fireEvent.click(row);
    await vi.waitFor(() => expect(onAfterResume).toHaveBeenCalledTimes(1));
  });

  it('stays collapsed by default when defaultOpen is omitted', () => {
    const { container } = render(<HistoryPanel />);
    expect(container.querySelector('.history-body')).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run web:test -- HistoryPanel.test.tsx`

Expected: FAIL with TypeScript errors for unknown props.

- [ ] **Step 3: Implement props**

At the top of `apps/web/src/features/history/HistoryPanel.tsx`, add:

```ts
interface HistoryPanelProps {
  defaultOpen?: boolean;
  onAfterResume?(): void;
}
```

Update the component declaration and initial state:

```ts
export function HistoryPanel({
  defaultOpen = false,
  onAfterResume,
}: HistoryPanelProps = {}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
```

Inside `onRowClick`, after `navigate(`/session/${webSessionId}`);`, add:

```ts
      onAfterResume?.();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run web:test -- HistoryPanel.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/history/HistoryPanel.tsx apps/web/src/features/history/HistoryPanel.test.tsx
git commit -m "feat(web): support history panel in mobile drawer"
```

## Task 3: Chat Mobile Menu Trigger

**Files:**
- Modify: `apps/web/src/features/chat/Chat.tsx`
- Create: `apps/web/src/features/chat/Chat.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/features/chat/Chat.test.tsx`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Chat } from './Chat';
import type { SessionView } from '../../store/sessions';

vi.mock('./InputBox', () => ({
  InputBox: () => <div data-testid="input-box" />,
}));

vi.mock('./MessageBubble', () => ({
  MessageBubble: () => <div data-testid="message-bubble" />,
}));

vi.mock('./ResumePrompt', () => ({
  ResumePrompt: () => <div data-testid="resume-prompt" />,
}));

vi.mock('../image-attach/useImagePaste', () => ({
  useImagePaste: () => ({
    images: [],
    error: null,
    addImageFromFile: vi.fn(),
    removeImage: vi.fn(),
    clear: vi.fn(),
  }),
}));

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: 's1',
    agent: 'claude',
    projectPath: '/Users/me/project',
    createdAt: 1,
    events: [],
    lastSeq: 0,
    alive: true,
    name: 'Mobile Session',
    ...overrides,
  };
}

describe('Chat', () => {
  it('renders a mobile navigation trigger when provided', () => {
    const onOpenMobileNav = vi.fn();
    const { getByLabelText } = render(
      <MemoryRouter>
        <Chat
          session={makeSession()}
          onSend={() => {}}
          onStop={() => {}}
          onOpenMobileNav={onOpenMobileNav}
        />
      </MemoryRouter>,
    );

    fireEvent.click(getByLabelText(/open sessions and history/i));
    expect(onOpenMobileNav).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run web:test -- Chat.test.tsx`

Expected: FAIL with a TypeScript error because `onOpenMobileNav` is not in `ChatProps`.

- [ ] **Step 3: Implement the trigger**

In `apps/web/src/features/chat/Chat.tsx`, add the prop:

```ts
  onOpenMobileNav?(): void;
```

Destructure it:

```ts
  onOpenMobileNav,
```

Inside `.chat-header`, before the project path `<code>`, add:

```tsx
        {onOpenMobileNav && (
          <button
            type="button"
            className="chat-mobile-menu"
            onClick={onOpenMobileNav}
            aria-label="Open sessions and history"
          >
            ☰
          </button>
        )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run web:test -- Chat.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/chat/Chat.tsx apps/web/src/features/chat/Chat.test.tsx
git commit -m "feat(web): add mobile chat navigation trigger"
```

## Task 4: Session Mobile Drawer Shell

**Files:**
- Modify: `apps/web/src/pages/Session.tsx`
- Create: `apps/web/src/pages/Session.mobile-shell.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/pages/Session.mobile-shell.test.tsx`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Session } from './Session';
import { useSessionsStore } from '../store/sessions';
import type { SessionView } from '../store/sessions';
import type { BridgeClient } from '../services/bridge-client';

vi.mock('../features/project-picker/useNewSession', () => ({
  useNewSession: () => ({ open: vi.fn(), pickerNode: null }),
}));

vi.mock('../features/file-explorer/FileExplorer', () => ({
  FileExplorer: () => <aside data-testid="file-explorer" />,
}));

vi.mock('../features/chat/Chat', () => ({
  Chat: ({ onOpenMobileNav }: { onOpenMobileNav?: () => void }) => (
    <main data-testid="chat">
      {onOpenMobileNav && (
        <button type="button" aria-label="Open sessions and history" onClick={onOpenMobileNav}>
          menu
        </button>
      )}
    </main>
  ),
}));

vi.mock('../features/session-list/SessionList', () => ({
  SessionList: ({
    sessions,
    onSelect,
    onAfterSelect,
  }: {
    sessions: SessionView[];
    onSelect(id: string): void;
    onAfterSelect?: () => void;
  }) => (
    <nav data-testid="session-list">
      {sessions.map((session) => (
        <button
          key={session.sessionId}
          type="button"
          onClick={() => {
            onSelect(session.sessionId);
            onAfterSelect?.();
          }}
        >
          {session.name ?? session.sessionId}
        </button>
      ))}
    </nav>
  ),
}));

vi.mock('../features/history/HistoryPanel', () => ({
  HistoryPanel: ({
    defaultOpen,
    onAfterResume,
  }: {
    defaultOpen?: boolean;
    onAfterResume?: () => void;
  }) => (
    <section data-testid="history-panel">
      <span>{defaultOpen ? 'open history' : 'collapsed history'}</span>
      {onAfterResume && (
        <button type="button" onClick={onAfterResume}>
          resume row
        </button>
      )}
    </section>
  ),
}));

const client = {
  send: vi.fn(),
} as unknown as BridgeClient;

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: 's1',
    agent: 'claude',
    projectPath: '/Users/me/project',
    createdAt: 1,
    events: [],
    lastSeq: 0,
    alive: true,
    name: 'Session One',
    ...overrides,
  };
}

function renderSession(path = '/session/s1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/session/:id" element={<Session client={client} />} />
        <Route path="/" element={<div>home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Session mobile shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionsStore.setState({
      sessions: {
        s1: makeSession(),
        s2: makeSession({ sessionId: 's2', name: 'Session Two' }),
      },
      order: ['s1', 's2'],
      activeId: null,
      transcriptOnly: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the mobile drawer from the chat trigger', () => {
    const { getByLabelText, getByRole } = renderSession();
    fireEvent.click(getByLabelText(/open sessions and history/i));
    expect(getByRole('dialog', { name: /mobile navigation/i })).toBeTruthy();
  });

  it('switches between sessions and history tabs', () => {
    const { getByLabelText, getByRole, getByTestId } = renderSession();
    fireEvent.click(getByLabelText(/open sessions and history/i));
    expect(getByTestId('session-list')).toBeTruthy();
    fireEvent.click(getByRole('button', { name: /history/i }));
    expect(getByTestId('history-panel').textContent).toMatch(/open history/);
  });

  it('closes the drawer after selecting a session', () => {
    const { getByLabelText, getByRole, queryByRole } = renderSession();
    fireEvent.click(getByLabelText(/open sessions and history/i));
    fireEvent.click(getByRole('button', { name: /session two/i }));
    expect(queryByRole('dialog', { name: /mobile navigation/i })).toBeNull();
  });

  it('closes the drawer after history resume callback', () => {
    const { getByLabelText, getByRole, queryByRole } = renderSession();
    fireEvent.click(getByLabelText(/open sessions and history/i));
    fireEvent.click(getByRole('button', { name: /history/i }));
    fireEvent.click(getByRole('button', { name: /resume row/i }));
    expect(queryByRole('dialog', { name: /mobile navigation/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run web:test -- Session.mobile-shell.test.tsx`

Expected: FAIL because the drawer markup and `onOpenMobileNav` wiring do not exist in `Session.tsx`.

- [ ] **Step 3: Implement the drawer shell**

In `apps/web/src/pages/Session.tsx`, add a tab type near the props:

```ts
type MobileNavTab = 'sessions' | 'history';
```

Add state inside `Session`:

```ts
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileNavTab, setMobileNavTab] = useState<MobileNavTab>('sessions');
```

Add helpers after `sessions` is computed:

```ts
  const closeMobileNav = (): void => setMobileNavOpen(false);
  const openMobileNav = (): void => {
    setMobileNavTab('sessions');
    setMobileNavOpen(true);
  };
```

Pass the mobile trigger to `Chat`:

```tsx
          onOpenMobileNav={openMobileNav}
```

Update the existing desktop `SessionList` call so selecting also closes any open mobile drawer:

```tsx
      <SessionList
        sessions={sessions}
        activeId={id ?? null}
        onSelect={(nid) => navigate(`/session/${nid}`)}
        onNewSession={newSession.open}
        onAfterSelect={closeMobileNav}
      />
```

After the `Chat` block and before transcript-only loading fallback, render the mobile drawer:

```tsx
      {mobileNavOpen && (
        <div className="mobile-nav-shell">
          <button
            type="button"
            className="mobile-nav-backdrop"
            aria-label="Close mobile navigation"
            onClick={closeMobileNav}
          />
          <aside className="mobile-nav-drawer" role="dialog" aria-label="Mobile navigation">
            <div className="mobile-nav-header">
              <span>Navigation</span>
              <button type="button" onClick={closeMobileNav} aria-label="Close mobile navigation">
                ×
              </button>
            </div>
            <div className="mobile-nav-tabs" role="tablist" aria-label="Mobile navigation sections">
              <button
                type="button"
                className={mobileNavTab === 'sessions' ? 'active' : ''}
                onClick={() => setMobileNavTab('sessions')}
              >
                Sessions
              </button>
              <button
                type="button"
                className={mobileNavTab === 'history' ? 'active' : ''}
                onClick={() => setMobileNavTab('history')}
              >
                History
              </button>
            </div>
            <div className="mobile-nav-content">
              {mobileNavTab === 'sessions' ? (
                <SessionList
                  sessions={sessions}
                  activeId={id ?? null}
                  onSelect={(nid) => navigate(`/session/${nid}`)}
                  onNewSession={newSession.open}
                  onAfterSelect={closeMobileNav}
                />
              ) : (
                <HistoryPanel defaultOpen onAfterResume={closeMobileNav} />
              )}
            </div>
          </aside>
        </div>
      )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run web:test -- Session.mobile-shell.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Session.tsx apps/web/src/pages/Session.mobile-shell.test.tsx
git commit -m "feat(web): add mobile session navigation drawer"
```

## Task 5: Mobile Chat Shell CSS Contract

**Files:**
- Modify: `apps/web/src/responsive-css.test.ts`
- Modify: `apps/web/src/App.css`
- Modify: `apps/web/src/features/chat/Chat.css`
- Modify: `apps/web/src/features/file-explorer/FileExplorer.css`

- [ ] **Step 1: Write the failing CSS contract test**

Extend `apps/web/src/responsive-css.test.ts` with a second test:

```ts
  it('defines the mobile chat shell overlay contract', () => {
    const css = [
      readCss('src/App.css'),
      readCss('src/features/chat/Chat.css'),
      readCss('src/features/file-explorer/FileExplorer.css'),
    ].join('\n');

    expect(css).toMatch(/\.mobile-nav-shell\s*{[^}]*position:\s*fixed/s);
    expect(css).toMatch(/\.mobile-nav-backdrop\s*{[^}]*position:\s*absolute/s);
    expect(css).toMatch(/\.mobile-nav-drawer\s*{[^}]*position:\s*relative/s);
    expect(css).toMatch(/\.chat-mobile-menu\s*{[^}]*display:\s*none/s);
    expect(css).toMatch(/\.chat\s*{[^}]*height:\s*100dvh/s);
    expect(css).toMatch(/\.input-box\s*{[^}]*padding-bottom:\s*calc\(0\.65rem \+ env\(safe-area-inset-bottom\)\)/s);
    expect(css).toMatch(/\.file-explorer\s*{[^}]*position:\s*fixed/s);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run web:test -- responsive-css.test.ts`

Expected: FAIL because the new mobile shell CSS selectors are not complete.

- [ ] **Step 3: Add mobile shell CSS**

Add to `apps/web/src/App.css` before the session rename section:

```css
.mobile-nav-shell {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: none;
}
.mobile-nav-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  border: 0;
  padding: 0;
}
.mobile-nav-drawer {
  position: relative;
  width: min(88vw, 24rem);
  height: 100dvh;
  background: #181818;
  color: #ddd;
  border-right: 1px solid #2a2a2a;
  box-shadow: 0.5rem 0 1.5rem rgba(0, 0, 0, 0.45);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.mobile-nav-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 3rem;
  padding: 0 0.75rem;
  border-bottom: 1px solid #2a2a2a;
  font-weight: 600;
}
.mobile-nav-header button {
  min-width: 44px;
  min-height: 44px;
  background: transparent;
  color: #ddd;
  border: 0;
  cursor: pointer;
  font-size: 1.2rem;
}
.mobile-nav-tabs {
  display: flex;
  gap: 0.4rem;
  padding: 0.5rem;
  border-bottom: 1px solid #2a2a2a;
}
.mobile-nav-tabs button {
  flex: 1;
  min-height: 44px;
  background: #1f1f1f;
  color: #aaa;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  cursor: pointer;
}
.mobile-nav-tabs button.active {
  background: #1c2a44;
  color: #fff;
  border-color: #2d6cdf;
}
.mobile-nav-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
```

Extend the existing `@media (max-width: 720px)` block in `apps/web/src/App.css`:

```css
  .mobile-nav-shell {
    display: block;
  }
  body:has(.mobile-nav-shell) {
    overflow: hidden;
  }
  .mobile-nav-content .session-list,
  .mobile-nav-content .history-panel {
    display: block;
    width: 100%;
    max-height: none;
    border-bottom: 0;
  }
```

Add to `apps/web/src/features/chat/Chat.css` near the header rules:

```css
.chat-mobile-menu {
  display: none;
  background: #2a2a2a;
  color: #ddd;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}
```

Update the existing mobile block in `Chat.css`:

```css
  .chat {
    flex: 1;
    min-height: 100dvh;
    height: 100dvh;
    width: 100%;
    overflow: hidden;
  }
  .chat-mobile-menu {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.75rem;
    min-height: 2.75rem;
    flex: none;
  }
  .chat-header {
    min-height: 3rem;
    box-sizing: border-box;
  }
  .chat-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .input-box {
    padding: 0.65rem;
    padding-bottom: calc(0.65rem + env(safe-area-inset-bottom));
    flex: none;
  }
```

Update the mobile block in `apps/web/src/features/file-explorer/FileExplorer.css`:

```css
  .file-explorer {
    position: fixed;
    inset: 0;
    z-index: 70;
    width: 100%;
    height: 100dvh;
    max-height: none;
    border-left: 0;
    border-top: 0;
  }
```

- [ ] **Step 4: Run CSS contract test**

Run: `npm run web:test -- responsive-css.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/responsive-css.test.ts apps/web/src/App.css apps/web/src/features/chat/Chat.css apps/web/src/features/file-explorer/FileExplorer.css
git commit -m "feat(web): style mobile chat shell"
```

## Task 6: Web Verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm run web:test -- SessionList.test.tsx HistoryPanel.test.tsx Chat.test.tsx Session.mobile-shell.test.tsx responsive-css.test.ts
```

Expected: PASS for all listed test files.

- [ ] **Step 2: Run all web tests**

Run:

```bash
npm run web:test
```

Expected: PASS.

- [ ] **Step 3: Run production build**

Run:

```bash
npm run web:build
```

Expected: PASS with TypeScript and Vite build completing.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git status --short
git log --oneline -6
```

Expected: `git status --short` is clean. Recent commits include the design commit plus the five implementation commits from this plan.

## Self-Review

- Spec coverage: Task 1 covers session drawer close after select. Task 2 covers history open/resume behavior. Task 3 covers the chat menu trigger. Task 4 covers the mobile drawer shell and tab behavior. Task 5 covers mobile viewport, drawer, safe-area input, and file explorer overlay CSS. Task 6 covers web tests and build.
- Placeholder scan: no placeholder implementation steps remain.
- Type consistency: prop names are consistent across tasks: `onAfterSelect`, `defaultOpen`, `onAfterResume`, and `onOpenMobileNav`.
