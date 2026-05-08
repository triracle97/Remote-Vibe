# UI Revamp (Codex-Terminal Style) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle and restructure `apps/web/` to match the `codex-terminal/` mockup — mobile-first single-pane with adaptive desktop side-rail, Tailwind v4 theming (dark+light), lucide icons, motion transitions — without changing stores, services, or bridge protocol.

**Architecture:** New `shell/` directory provides a route-wrapping `AppShell` with adaptive `NavRail`, `ThemeProvider`, `ViewTransition`, and reusable `BottomSheet` / `Modal` primitives. Five top-level pages (`Home`, `Sessions`, `Projects`, `Settings`, `Session`) are wired through `react-router`. Existing feature components are restyled in place; per-feature `.css` files are deleted in favor of utility classes. WebSocket bootstrap moves wholesale from `App.tsx` into `AppShell`.

**Tech Stack:** React 18, Vite, react-router-dom v6, zustand, react-markdown + shiki + mermaid + katex (existing); **add** `tailwindcss@^4`, `@tailwindcss/vite`, `lucide-react`, `motion`. Tests: Vitest + happy-dom + Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-08-ui-revamp-codex-style-design.md`

---

## File Structure

### New files

```
apps/web/src/
├── shell/
│   ├── AppShell.tsx
│   ├── AppShell.test.tsx
│   ├── NavRail.tsx
│   ├── NavRail.test.tsx
│   ├── ThemeProvider.tsx
│   ├── ViewTransition.tsx
│   ├── BottomSheet.tsx
│   ├── BottomSheet.test.tsx
│   ├── Modal.tsx
│   ├── Modal.test.tsx
│   ├── themeStore.ts
│   └── themeStore.test.ts
├── pages/
│   ├── Sessions.tsx
│   ├── Sessions.test.tsx
│   ├── Projects.tsx
│   ├── Projects.test.tsx
│   ├── Settings.tsx
│   └── Settings.test.tsx
└── features/
    └── projects/
        ├── projectsStore.ts
        └── projectsStore.test.ts
```

### Modified files

```
apps/web/
├── package.json                              ← add deps
├── vite.config.ts                            ← add @tailwindcss/vite plugin
├── index.html                                ← add theme-flicker <script>
└── src/
    ├── index.css                             ← (NEW content) Tailwind v4 import + @theme tokens
    ├── App.tsx                               ← bridge bootstrap removed; routes use AppShell
    ├── App.css                               ← DELETED
    ├── main.tsx                              ← ensure index.css imported
    ├── pages/
    │   ├── Home.tsx                          ← restructured per spec
    │   ├── Session.tsx                       ← restructured (drop mobile-nav-drawer markup)
    │   └── Session.mobile-shell.test.tsx     ← rewritten for BottomSheet
    ├── responsive-css.test.ts                ← rewritten or deleted
    └── features/
        ├── chat/Chat.tsx                     ← restyled; Chat.css DELETED
        ├── chat/Chat.css                     ← DELETED
        ├── chat/MessageBubble.tsx            ← restyled
        ├── chat/InputBox.tsx                 ← restyled (lucide icons)
        ├── chat/ResumePrompt.tsx             ← restyled
        ├── chat/SlashAutocomplete.tsx        ← restyled (BottomSheet on mobile)
        ├── chat/AtTagAutocomplete.tsx        ← restyled (BottomSheet on mobile)
        ├── session-list/SessionList.tsx      ← restyled; SessionList.css DELETED
        ├── session-list/SessionList.css      ← DELETED
        ├── session-list/SessionRenameInline.tsx ← restyled
        ├── history/HistoryPanel.tsx          ← restyled; history.css DELETED
        ├── history/HistoryRow.tsx            ← restyled
        ├── history/history.css               ← DELETED
        ├── file-explorer/FileExplorer.tsx    ← restyled; FileExplorer.css DELETED
        ├── file-explorer/FileExplorer.css    ← DELETED
        ├── file-explorer/FilePreview.tsx     ← restyled
        ├── project-picker/ProjectPicker.tsx  ← restyled (uses Modal); ProjectPicker.css DELETED
        ├── project-picker/ProjectPicker.css  ← DELETED
        ├── profiles/                          ← restyled; profiles.css DELETED
        ├── prompt-history/PromptHistoryDropdown.tsx ← restyled; PromptHistoryDropdown.css DELETED
        ├── image-attach/                      ← restyled; ImageAttach.css DELETED
        └── markdown/markdown.css             ← migrated to Tailwind base layer (slim)
```

---

## Tasks

### Task 1: Install dependencies + verify Vite build

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/vite.config.ts`

- [ ] **Step 1: Install new dependencies**

Run from repo root:
```bash
npm install --workspace=apps/web tailwindcss@^4 @tailwindcss/vite lucide-react motion
```

Expected: dependencies added under `apps/web/node_modules`; `apps/web/package.json` gains:
- `dependencies`: `lucide-react`, `motion`
- `devDependencies`: `tailwindcss@^4`, `@tailwindcss/vite`

- [ ] **Step 2: Wire Tailwind v4 plugin into Vite config**

Edit `apps/web/vite.config.ts`:
```ts
/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'happy-dom',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

- [ ] **Step 3: Verify Vite build still works**

Run from repo root:
```bash
npm run web:build
```

Expected: build completes; `apps/web/dist/` populated. If `@tailwindcss/vite` requires a Vite ≥6 bump, run `npm install --workspace=apps/web vite@^6` and re-run.

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json apps/web/vite.config.ts package-lock.json
git commit -m "feat(web): add tailwind v4, lucide, motion deps"
```

---

### Task 2: Tailwind theme tokens + theme-flicker prevention

**Files:**
- Modify: `apps/web/src/index.css`
- Modify: `apps/web/index.html`
- Modify: `apps/web/src/main.tsx` (ensure `index.css` imported)

- [ ] **Step 1: Replace `apps/web/src/index.css` with Tailwind import + `@theme`**

Full new content:
```css
@import "tailwindcss";

@layer base {
  html, body, #root { height: 100%; }
  body {
    margin: 0;
    font-family: var(--font-sans);
    background: var(--color-bg);
    color: var(--color-text);
    -webkit-font-smoothing: antialiased;
  }
}

@theme {
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;

  /* Brand accents (shared across themes) */
  --color-accent:  #339af0;
  --color-success: #40c057;
  --color-warn:    #fcc419;
  --color-danger:  #fa5252;
}

[data-theme="dark"] {
  --color-bg:          #111214;
  --color-surface:     #1a1b1e;
  --color-surface-2:   #25262b;
  --color-border:      #373a40;
  --color-text:        #e5e7eb;
  --color-text-mute:   #9ca3af;
  --color-text-dim:    #6b7280;
  --color-bubble-user: #4b4461;
  --color-bubble-ai:   #2c3340;
  --color-tool-shell:  rgba(64, 192, 87, 0.18);
  --color-tool-result: rgba(252, 196, 25, 0.18);
}

[data-theme="light"] {
  --color-bg:          #fafafa;
  --color-surface:     #ffffff;
  --color-surface-2:   #f1f3f5;
  --color-border:      #dee2e6;
  --color-text:        #1a1b1e;
  --color-text-mute:   #495057;
  --color-text-dim:    #868e96;
  --color-bubble-user: #dbe4ff;
  --color-bubble-ai:   #f1f3f5;
  --color-tool-shell:  rgba(64, 192, 87, 0.14);
  --color-tool-result: rgba(252, 196, 25, 0.18);
}

@layer utilities {
  .scrollbar-hide { scrollbar-width: none; }
  .scrollbar-hide::-webkit-scrollbar { display: none; }
}
```

- [ ] **Step 2: Add inline theme-flicker script to `index.html`**

Edit `apps/web/index.html` to insert a `<script>` BEFORE the React mount script:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>mac-remote-terminal</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" />
    <script>
      (function () {
        try {
          var stored = localStorage.getItem('mrt.theme'); // 'system' | 'light' | 'dark' | null
          var mode = stored === 'light' || stored === 'dark' ? stored : 'system';
          var resolved = mode;
          if (mode === 'system') {
            resolved = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
          }
          document.documentElement.setAttribute('data-theme', resolved);
        } catch (e) {
          document.documentElement.setAttribute('data-theme', 'dark');
        }
      })();
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Confirm `main.tsx` imports `index.css`**

Open `apps/web/src/main.tsx` and confirm it has `import './index.css';` near the top. If not, add it.

- [ ] **Step 4: Run dev server and visually verify theme tokens load**

```bash
npm run web:dev
```

Expected: server starts, page background is `#111214` (dark), Inter font visible. Toggle DevTools to set `data-theme="light"` on `<html>` and confirm bg becomes `#fafafa`. Stop server.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/index.css apps/web/index.html apps/web/src/main.tsx
git commit -m "feat(web): tailwind v4 theme tokens + flicker prevention"
```

---

### Task 3: themeStore + tests

**Files:**
- Create: `apps/web/src/shell/themeStore.ts`
- Test: `apps/web/src/shell/themeStore.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/web/src/shell/themeStore.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useThemeStore, resolveTheme } from './themeStore';

describe('themeStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useThemeStore.setState({ mode: 'system' });
  });

  it('defaults to system', () => {
    expect(useThemeStore.getState().mode).toBe('system');
  });

  it('setMode updates state and persists', () => {
    useThemeStore.getState().setMode('dark');
    expect(useThemeStore.getState().mode).toBe('dark');
    expect(localStorage.getItem('mrt.theme')).toBe('dark');
  });

  it('resolveTheme returns explicit modes unchanged', () => {
    expect(resolveTheme('dark', () => true)).toBe('dark');
    expect(resolveTheme('light', () => true)).toBe('light');
  });

  it('resolveTheme follows system pref when mode=system', () => {
    expect(resolveTheme('system', () => true)).toBe('light');
    expect(resolveTheme('system', () => false)).toBe('dark');
  });

  it('survives localStorage failure on write', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota');
    };
    try {
      useThemeStore.getState().setMode('light');
      expect(useThemeStore.getState().mode).toBe('light');
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm run test --workspace=apps/web -- shell/themeStore
```

Expected: FAIL — `Cannot find module './themeStore'`.

- [ ] **Step 3: Implement themeStore**

Create `apps/web/src/shell/themeStore.ts`:
```ts
import { create } from 'zustand';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'mrt.theme';

function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // ignore — fall through
  }
  return 'system';
}

function writeStoredMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore — store still updates in-memory
  }
}

interface ThemeState {
  mode: ThemeMode;
  setMode(mode: ThemeMode): void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: readStoredMode(),
  setMode(mode) {
    writeStoredMode(mode);
    set({ mode });
  },
}));

export function resolveTheme(
  mode: ThemeMode,
  prefersLight: () => boolean,
): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode;
  return prefersLight() ? 'light' : 'dark';
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npm run test --workspace=apps/web -- shell/themeStore
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shell/themeStore.ts apps/web/src/shell/themeStore.test.ts
git commit -m "feat(web): themeStore with system/light/dark mode"
```

---

### Task 4: ThemeProvider

**Files:**
- Create: `apps/web/src/shell/ThemeProvider.tsx`

- [ ] **Step 1: Implement ThemeProvider**

Create `apps/web/src/shell/ThemeProvider.tsx`:
```tsx
import { useEffect, type ReactNode } from 'react';
import { useThemeStore, resolveTheme } from './themeStore';

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps): JSX.Element {
  const mode = useThemeStore((s) => s.mode);

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const apply = (): void => {
      const resolved = resolveTheme(mode, () => mql.matches);
      document.documentElement.setAttribute('data-theme', resolved);
    };
    apply();
    if (mode !== 'system') return;
    const handler = (): void => apply();
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [mode]);

  return <>{children}</>;
}
```

- [ ] **Step 2: Smoke-check via dev server**

(No unit test for this — it's a thin DOM-effect wrapper; covered by AppShell integration test in Task 7.)

```bash
npm run web:typecheck
```

Expected: typecheck passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/shell/ThemeProvider.tsx
git commit -m "feat(web): ThemeProvider applies data-theme to <html>"
```

---

### Task 5: BottomSheet primitive + tests

**Files:**
- Create: `apps/web/src/shell/BottomSheet.tsx`
- Test: `apps/web/src/shell/BottomSheet.test.tsx`

- [ ] **Step 1: Write failing test**

Create `apps/web/src/shell/BottomSheet.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BottomSheet } from './BottomSheet';

describe('BottomSheet', () => {
  it('renders nothing when closed', () => {
    render(
      <BottomSheet open={false} onClose={() => {}} ariaLabel="Test">
        <div>content</div>
      </BottomSheet>
    );
    expect(screen.queryByText('content')).toBeNull();
  });

  it('renders children when open', () => {
    render(
      <BottomSheet open={true} onClose={() => {}} ariaLabel="Test">
        <div>content</div>
      </BottomSheet>
    );
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open={true} onClose={onClose} ariaLabel="Test">
        <div>content</div>
      </BottomSheet>
    );
    fireEvent.click(screen.getByTestId('bottom-sheet-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open={true} onClose={onClose} ariaLabel="Test">
        <button>focusable</button>
      </BottomSheet>
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('exposes role="dialog" with aria-modal and aria-label', () => {
    render(
      <BottomSheet open={true} onClose={() => {}} ariaLabel="My Sheet">
        <div>x</div>
      </BottomSheet>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'My Sheet');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm run test --workspace=apps/web -- shell/BottomSheet
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement BottomSheet**

Create `apps/web/src/shell/BottomSheet.tsx`:
```tsx
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

interface BottomSheetProps {
  open: boolean;
  onClose(): void;
  ariaLabel: string;
  children: ReactNode;
  /** Optional max height as CSS value, defaults to 80vh */
  maxHeight?: string;
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function BottomSheet({
  open,
  onClose,
  ariaLabel,
  children,
  maxHeight = '80vh',
}: BottomSheetProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(focusableSelector));
    if (focusable.length === 0) {
      event.preventDefault();
      root.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end">
          <motion.button
            type="button"
            data-testid="bottom-sheet-backdrop"
            aria-label="Close"
            className="absolute inset-0 bg-black/55 border-0 p-0 cursor-pointer"
            onClick={onClose}
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduce ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className="relative bg-[var(--color-surface)] text-[var(--color-text)] border-t border-[var(--color-border)] rounded-t-2xl shadow-2xl overflow-hidden"
            style={{ maxHeight, paddingBottom: 'env(safe-area-inset-bottom)' }}
            initial={reduce ? false : { y: '100%' }}
            animate={{ y: 0 }}
            exit={reduce ? { y: 0 } : { y: '100%' }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            <div className="h-6 w-full flex items-center justify-center">
              <div className="h-1.5 w-12 bg-[var(--color-text-dim)] rounded-full opacity-50" />
            </div>
            <div className="overflow-y-auto" style={{ maxHeight: `calc(${maxHeight} - 1.5rem)` }}>
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npm run test --workspace=apps/web -- shell/BottomSheet
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shell/BottomSheet.tsx apps/web/src/shell/BottomSheet.test.tsx
git commit -m "feat(web): BottomSheet primitive with focus trap"
```

---

### Task 6: Modal primitive + tests

**Files:**
- Create: `apps/web/src/shell/Modal.tsx`
- Test: `apps/web/src/shell/Modal.test.tsx`

- [ ] **Step 1: Write failing test**

Create `apps/web/src/shell/Modal.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    render(
      <Modal open={false} onClose={() => {}} ariaLabel="Test">
        <p>body</p>
      </Modal>
    );
    expect(screen.queryByText('body')).toBeNull();
  });

  it('renders children when open and exposes role=dialog', () => {
    render(
      <Modal open={true} onClose={() => {}} ariaLabel="My Modal">
        <p>body</p>
      </Modal>
    );
    expect(screen.getByText('body')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-label', 'My Modal');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('closes on backdrop click', () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose} ariaLabel="Test">
        <p>body</p>
      </Modal>
    );
    fireEvent.click(screen.getByTestId('modal-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose} ariaLabel="Test">
        <button>x</button>
      </Modal>
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm run test --workspace=apps/web -- shell/Modal
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement Modal**

Create `apps/web/src/shell/Modal.tsx`:
```tsx
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

interface ModalProps {
  open: boolean;
  onClose(): void;
  ariaLabel: string;
  children: ReactNode;
  /** Tailwind max-width class, defaults to max-w-md */
  maxWidthClass?: string;
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Modal({
  open,
  onClose,
  ariaLabel,
  children,
  maxWidthClass = 'max-w-md',
}: ModalProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(focusableSelector));
    if (focusable.length === 0) {
      event.preventDefault();
      root.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.button
            type="button"
            data-testid="modal-backdrop"
            aria-label="Close"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm border-0 p-0 cursor-pointer"
            onClick={onClose}
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduce ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 0.18 }}
          />
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className={`relative w-full ${maxWidthClass} bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] rounded-2xl shadow-2xl overflow-hidden`}
            initial={reduce ? false : { scale: 0.92, opacity: 0, y: 16 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={reduce ? { scale: 1, opacity: 1, y: 0 } : { scale: 0.92, opacity: 0, y: 16 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npm run test --workspace=apps/web -- shell/Modal
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shell/Modal.tsx apps/web/src/shell/Modal.test.tsx
git commit -m "feat(web): Modal primitive with focus trap"
```

---

### Task 7: AppShell + NavRail + ViewTransition + routing skeleton

**Files:**
- Create: `apps/web/src/shell/AppShell.tsx`
- Create: `apps/web/src/shell/AppShell.test.tsx`
- Create: `apps/web/src/shell/NavRail.tsx`
- Create: `apps/web/src/shell/NavRail.test.tsx`
- Create: `apps/web/src/shell/ViewTransition.tsx`
- Create: `apps/web/src/pages/Sessions.tsx` (placeholder)
- Create: `apps/web/src/pages/Projects.tsx` (placeholder)
- Create: `apps/web/src/pages/Settings.tsx` (placeholder)
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Write NavRail failing test**

Create `apps/web/src/shell/NavRail.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NavRail } from './NavRail';

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <NavRail />
    </MemoryRouter>
  );
}

describe('NavRail', () => {
  it('renders four nav links', () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sessions/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /projects/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
  });

  it('marks the current route as aria-current=page', () => {
    renderAt('/projects');
    const projects = screen.getByRole('link', { name: /projects/i });
    expect(projects).toHaveAttribute('aria-current', 'page');
    const home = screen.getByRole('link', { name: /home/i });
    expect(home).not.toHaveAttribute('aria-current');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm run test --workspace=apps/web -- shell/NavRail
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement NavRail**

Create `apps/web/src/shell/NavRail.tsx`:
```tsx
import { NavLink } from 'react-router-dom';
import { Home as HomeIcon, Code, FolderIcon, Settings as SettingsIcon } from 'lucide-react';

const tabs = [
  { to: '/', label: 'Home', icon: HomeIcon },
  { to: '/sessions', label: 'Sessions', icon: Code },
  { to: '/projects', label: 'Projects', icon: FolderIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

export function NavRail(): JSX.Element {
  return (
    <nav
      aria-label="Primary"
      className="
        flex items-center justify-around
        bg-[var(--color-surface)] border-t border-[var(--color-border)]
        py-2 px-4 shrink-0 pb-[max(env(safe-area-inset-bottom),0.5rem)]
        md:flex-col md:justify-start md:items-stretch md:py-3 md:px-0
        md:border-t-0 md:border-r md:gap-1 md:w-16 md:h-screen
      "
    >
      {tabs.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) =>
            [
              'flex flex-col items-center gap-1 transition-colors min-h-[56px] md:min-h-[60px] justify-center md:py-1',
              isActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]',
            ].join(' ')
          }
          aria-label={label}
        >
          {({ isActive }) => (
            <>
              <Icon size={22} aria-hidden="true" />
              <span className="text-[10px] font-medium">{label}</span>
              {/* aria-current applied via hidden span — ensures accessible name + current marker */}
              {isActive && <span className="sr-only" aria-hidden="true" data-current="true" />}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
```

NOTE: `react-router-dom`'s `NavLink` automatically applies `aria-current="page"` to active links — that's what the test asserts.

- [ ] **Step 4: Run NavRail test, verify it passes**

```bash
npm run test --workspace=apps/web -- shell/NavRail
```

Expected: PASS.

- [ ] **Step 5: Implement ViewTransition**

Create `apps/web/src/shell/ViewTransition.tsx`:
```tsx
import { type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

interface ViewTransitionProps {
  children: ReactNode;
}

export function ViewTransition({ children }: ViewTransitionProps): JSX.Element {
  const location = useLocation();
  const reduce = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        className="flex-1 min-h-0 flex flex-col"
        initial={reduce ? false : { opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={reduce ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
```

- [ ] **Step 6: Implement AppShell**

Create `apps/web/src/shell/AppShell.tsx`:
```tsx
import { useEffect, useMemo } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { BridgeClient } from '../services/bridge-client';
import { setBridgeClient } from '../services/bridge-client-singleton';
import { useConnectionStore } from '../store/connection';
import { useSessionsStore } from '../store/sessions';
import { useAccountsStore } from '../store/accounts';
import { usePromptHistoryStore } from '../store/prompt-history';
import { useFileExplorerStore } from '../store/file-explorer';
import { useHistoryStore } from '../features/history/historyStore';
import { useProfileStore } from '../features/profiles/profileStore';
import { useSlashCommandStore } from '../features/chat/slashCommandStore';
import { useFileSearchStore } from '../features/chat/fileSearchStore';
import { ThemeProvider } from './ThemeProvider';
import { NavRail } from './NavRail';
import { ViewTransition } from './ViewTransition';

export function AppShell(): JSX.Element {
  const setStatus = useConnectionStore((s) => s.setStatus);
  const setError = useConnectionStore((s) => s.setError);
  const apply = useSessionsStore((s) => s.applyServerMsg);
  const markTranscriptOnly = useSessionsStore((s) => s.markTranscriptOnly);
  const applyAccountList = useAccountsStore((s) => s.applyAccountList);
  const location = useLocation();

  const client = useMemo(() => new BridgeClient(), []);

  useEffect(() => {
    setBridgeClient(client);
  }, [client]);

  useEffect(() => {
    const offOpen = client.on('open', () => {
      setStatus('open');
      client.send({ type: 'list_sessions' });
      client.send({ type: 'list_accounts' });
      client.send({ type: 'list_prompts', limit: 200 });
      const { sessions } = useSessionsStore.getState();
      for (const id of Object.keys(sessions)) {
        const s = sessions[id];
        if (s && s.alive) {
          client.send({ type: 'get_history', sessionId: id, since: s.lastSeq });
        }
      }
    });
    const offClose = client.on('close', () => setStatus('closed'));
    const offError = client.on('error', (e) => {
      setStatus('error');
      setError(e.message);
    });
    const offMessage = client.on('message', (m) => {
      if (m.type === 'account_list') {
        applyAccountList(m.accounts);
        return;
      }
      if (m.type === 'prompts_result') {
        usePromptHistoryStore.getState().applyPromptsResult(m.prompts);
        return;
      }
      if (m.type === 'dirs_result') {
        useFileExplorerStore.getState().applyDirsResult(m);
        return;
      }
      if (m.type === 'file_result') {
        useFileExplorerStore.getState().applyFileResult(m);
        return;
      }
      if (m.type === 'history_list') {
        useHistoryStore.getState().applyServerMsg(m);
        return;
      }
      if (
        m.type === 'profile_list' ||
        m.type === 'profile_saved' ||
        m.type === 'profile_deleted' ||
        m.type === 'profile_default_set'
      ) {
        useProfileStore.getState().applyServerMsg(m);
        return;
      }
      if (m.type === 'slash_commands_list') {
        useSlashCommandStore.getState().applyServerMsg(m);
        return;
      }
      if (m.type === 'file_search_results') {
        useFileSearchStore.getState().applyServerMsg(m);
        return;
      }
      if (m.type === 'error') {
        if (m.code === 'session_dead' && m.sessionId) {
          markTranscriptOnly(m.sessionId);
        } else {
          setError(`${m.code}: ${m.message}`);
        }
      } else {
        setError(null);
      }
      if (m.type === 'user') {
        client.send({ type: 'list_prompts', limit: 200 });
      }
      if (m.type === 'error') {
        useProfileStore.getState().applyServerMsg(m);
      }
      apply(m);
    });

    client.connect();

    return () => {
      offOpen();
      offClose();
      offError();
      offMessage();
      client.close();
    };
  }, [client, setStatus, setError, apply, markTranscriptOnly, applyAccountList]);

  // Hide NavRail on mobile when viewing a session — chat goes full-screen.
  const onSessionPage = location.pathname.startsWith('/session/');

  return (
    <ThemeProvider>
      <div className="flex flex-col md:flex-row h-[100dvh] bg-[var(--color-bg)] text-[var(--color-text)]">
        <div className={onSessionPage ? 'hidden md:flex' : 'order-last md:order-first flex'}>
          <NavRail />
        </div>
        <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <ViewTransition>
            <Outlet context={{ client }} />
          </ViewTransition>
        </main>
      </div>
    </ThemeProvider>
  );
}

export type AppShellOutletContext = { client: BridgeClient };
```

- [ ] **Step 7: Write AppShell smoke test**

Create `apps/web/src/shell/AppShell.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AppShell } from './AppShell';

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>HOME</div>} />
          <Route path="/sessions" element={<div>SESSIONS</div>} />
          <Route path="/projects" element={<div>PROJECTS</div>} />
          <Route path="/settings" element={<div>SETTINGS</div>} />
          <Route path="/session/:id" element={<div>CHAT</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('AppShell', () => {
  it('renders nav and outlet content for /', () => {
    renderAt('/');
    expect(screen.getByRole('navigation', { name: /primary/i })).toBeInTheDocument();
    expect(screen.getByText('HOME')).toBeInTheDocument();
  });

  it('renders nav and outlet content for /settings', () => {
    renderAt('/settings');
    expect(screen.getByText('SETTINGS')).toBeInTheDocument();
  });
});
```

- [ ] **Step 8: Create placeholder pages**

Create `apps/web/src/pages/Sessions.tsx`:
```tsx
export function Sessions(): JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center text-[var(--color-text-dim)] font-mono">
      SESSIONS — coming soon
    </div>
  );
}
```

Create `apps/web/src/pages/Projects.tsx`:
```tsx
export function Projects(): JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center text-[var(--color-text-dim)] font-mono">
      PROJECTS — coming soon
    </div>
  );
}
```

Create `apps/web/src/pages/Settings.tsx`:
```tsx
export function Settings(): JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center text-[var(--color-text-dim)] font-mono">
      SETTINGS — coming soon
    </div>
  );
}
```

- [ ] **Step 9: Rewrite `App.tsx` to use AppShell**

Replace `apps/web/src/App.tsx` with:
```tsx
import { Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './shell/AppShell';
import { Home } from './pages/Home';
import { Session } from './pages/Session';
import { Sessions } from './pages/Sessions';
import { Projects } from './pages/Projects';
import { Settings } from './pages/Settings';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Home />} />
        <Route path="/sessions" element={<Sessions />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/session/:id" element={<Session />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
```

NOTE: `Home` and `Session` will need to be updated to read `client` from `useOutletContext<AppShellOutletContext>()` instead of receiving it as a prop. That migration happens in **Tasks 10 and 19** — for now, also update both files to compile against the new prop-less signature using outlet context.

- [ ] **Step 10: Update `Home.tsx` and `Session.tsx` to read client from outlet context (compilation-only fix)**

Edit `apps/web/src/pages/Home.tsx` — change signature and add outlet hook:
```tsx
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useSessionsStore } from '../store/sessions';
import { useConnectionStore } from '../store/connection';
import type { AppShellOutletContext } from '../shell/AppShell';
import { SessionList } from '../features/session-list/SessionList';
import { useNewSession } from '../features/project-picker/useNewSession';
import { HistoryPanel } from '../features/history/HistoryPanel';

export function Home(): JSX.Element {
  const { client } = useOutletContext<AppShellOutletContext>();
  const order = useSessionsStore((s) => s.order);
  const sessionsMap = useSessionsStore((s) => s.sessions);
  const status = useConnectionStore((s) => s.status);
  const lastError = useConnectionStore((s) => s.lastError);
  const navigate = useNavigate();
  const newSession = useNewSession(client);

  const sessions = order.map((id) => sessionsMap[id]!).filter((s) => s !== undefined);

  return (
    <>
      <SessionList
        sessions={sessions}
        activeId={null}
        onSelect={(id) => navigate(`/session/${id}`)}
        onNewSession={newSession.open}
      />
      <HistoryPanel />
      <main className="home-main">
        <h1>mac-remote-terminal</h1>
        <p>connection: {status}</p>
        {lastError && <p className="error-banner">error: {lastError}</p>}
        <p>{sessions.length === 0 ? 'No sessions yet. Click + New Claude session.' : 'Pick a session from the sidebar.'}</p>
      </main>
      {newSession.pickerNode}
    </>
  );
}
```

Edit `apps/web/src/pages/Session.tsx` — replace the `SessionProps` parameter with outlet context. At the top of the file change:
```tsx
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import type { AppShellOutletContext } from '../shell/AppShell';
// ...rest of imports unchanged
```
And replace:
```tsx
interface SessionProps {
  client: BridgeClient;
}
// ...
export function Session({ client }: SessionProps): JSX.Element {
```
with:
```tsx
export function Session(): JSX.Element {
  const { client } = useOutletContext<AppShellOutletContext>();
```
Leave the rest of the function body untouched. The `SessionProps` interface can be deleted.

- [ ] **Step 11: Run all tests, then typecheck**

```bash
npm run test --workspace=apps/web
npm run web:typecheck
```

Expected: all pass. (`Session.mobile-shell.test.tsx` may need a wrapper update to render with `MemoryRouter` + Outlet context — if it fails, wrap the Session render in:
```tsx
<MemoryRouter initialEntries={['/session/abc']}>
  <Routes>
    <Route element={<OutletWrapper client={client} />}>
      <Route path="/session/:id" element={<Session />} />
    </Route>
  </Routes>
</MemoryRouter>
```
where `OutletWrapper` injects the `client` via `<Outlet context={{ client }} />`. Apply the same fix to any other test that previously passed `client` as a prop.)

- [ ] **Step 12: Commit**

```bash
git add apps/web/src/shell apps/web/src/pages apps/web/src/App.tsx
git commit -m "feat(web): AppShell with NavRail, ViewTransition, routing skeleton"
```

---

### Task 8: Restyle SessionList + SessionRenameInline

**Files:**
- Modify: `apps/web/src/features/session-list/SessionList.tsx`
- Modify: `apps/web/src/features/session-list/SessionRenameInline.tsx`
- Test: `apps/web/src/features/session-list/SessionList.test.tsx` (existing — must continue to pass)

- [ ] **Step 1: Run existing tests, confirm baseline pass**

```bash
npm run test --workspace=apps/web -- session-list
```

Expected: PASS.

- [ ] **Step 2: Replace `SessionList.tsx` with utility-class version**

Full new content for `apps/web/src/features/session-list/SessionList.tsx`:
```tsx
import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { SessionView } from '../../store/sessions';
import { SessionRenameInline } from './SessionRenameInline';

interface SessionListProps {
  sessions: SessionView[];
  activeId: string | null;
  onSelect(id: string): void;
  onNewSession(): void;
  onAfterSelect?(): void;
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen)}…`;
}

function SessionRow({
  session,
  activeId,
  onSelect,
  onAfterSelect,
}: {
  session: SessionView;
  activeId: string | null;
  onSelect: (id: string) => void;
  onAfterSelect?: (() => void) | undefined;
}): JSX.Element {
  const [renaming, setRenaming] = useState(false);
  const isActive = session.sessionId === activeId;
  const label = session.projectPath.split('/').filter(Boolean).pop() ?? session.projectPath;
  const badgeText =
    session.agent === 'codex'
      ? `codex${session.account ? `:${session.account}` : ''}`
      : 'claude';
  const badgeClasses =
    session.agent === 'codex'
      ? 'bg-[#2a1c44] text-[#fae]'
      : 'bg-[#1c2a44] text-[#aef]';

  return (
    <li
      className={[
        'session-row',
        'rounded-lg border transition-colors',
        isActive
          ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_18%,var(--color-surface))]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]',
        !session.alive ? 'opacity-60' : '',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={() => {
          onSelect(session.sessionId);
          onAfterSelect?.();
        }}
        className="w-full text-left p-3 min-h-[56px] flex flex-col gap-1"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-[var(--color-text)] truncate">{label}</span>
          <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-mono ${badgeClasses}`}>
            {badgeText}
          </span>
        </div>
        <div className="text-xs text-[var(--color-text-dim)] font-mono truncate">
          {session.projectPath}
        </div>
        {!session.alive && (
          <div className="text-[10px] text-[var(--color-warn)]">ended</div>
        )}
      </button>
      <div className="session-name-row flex items-center gap-1 px-3 pb-2">
        {renaming ? (
          <SessionRenameInline
            sessionId={session.sessionId}
            initialName={session.name ?? ''}
            onClose={() => setRenaming(false)}
          />
        ) : (
          <>
            <span
              className="session-name flex-1 text-xs text-[var(--color-text-dim)] truncate"
              title={session.name ?? session.sessionId}
            >
              {session.name
                ? truncate(session.name, 30)
                : session.sessionId.slice(0, 8)}
            </span>
            <button
              type="button"
              className="session-rename-pencil min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] rounded"
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(true);
              }}
              aria-label="Rename session"
            >
              ✏️
            </button>
          </>
        )}
      </div>
    </li>
  );
}

export function SessionList({
  sessions,
  activeId,
  onSelect,
  onNewSession,
  onAfterSelect,
}: SessionListProps): JSX.Element {
  return (
    <aside className="session-list w-full md:w-60 p-2 box-border flex flex-col gap-2">
      <button
        type="button"
        onClick={onNewSession}
        className="session-new w-full min-h-[44px] py-2.5 px-4 bg-[var(--color-accent)] text-white rounded-xl font-semibold flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.99] transition"
      >
        <Plus size={18} aria-hidden="true" />
        New session
      </button>
      <ul className="list-none p-0 m-0 flex flex-col gap-1.5">
        {sessions.length === 0 && (
          <li className="session-empty text-sm text-[var(--color-text-dim)] p-3 text-center">
            No active sessions
          </li>
        )}
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

(NOTE: kept legacy class names `session-row`, `session-new`, `session-empty`, `session-name-row`, `session-name`, `session-rename-pencil` so existing tests that select on these continue to work.)

- [ ] **Step 3: Replace `SessionRenameInline.tsx` markup with utility classes**

Read the current `apps/web/src/features/session-list/SessionRenameInline.tsx`. Find the JSX that uses the classes `session-rename-inline`, `session-rename-input`, `session-rename-save`, `session-rename-cancel`, `session-rename-error` and replace them with utility-class equivalents while keeping the legacy class names too:
- Wrapper div: `className="session-rename-inline flex gap-1.5 items-center p-1 flex-1"`
- Input: `className="session-rename-input flex-1 min-w-0 min-h-[40px] px-2 py-1.5 bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] rounded text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"`
- Save button: `className="session-rename-save min-w-[44px] min-h-[44px] bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] rounded px-2 py-1.5 hover:bg-[var(--color-surface)]"`
- Cancel button: same classes as save with text or icon left intact.
- Error: `className="session-rename-error text-xs text-[var(--color-danger)]"`

Functional behavior unchanged.

- [ ] **Step 4: Delete `SessionList.css`**

```bash
git rm apps/web/src/features/session-list/SessionList.css
```

(Keep deletion in same commit; nothing imports it from `SessionList.tsx` anymore.)

- [ ] **Step 5: Run tests, confirm pass**

```bash
npm run test --workspace=apps/web -- session-list
npm run web:typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/session-list
git commit -m "refactor(web): restyle SessionList + SessionRenameInline with tailwind"
```

---

### Task 9: Restyle HistoryPanel + HistoryRow

**Files:**
- Modify: `apps/web/src/features/history/HistoryPanel.tsx`
- Modify: `apps/web/src/features/history/HistoryRow.tsx`
- Delete: `apps/web/src/features/history/history.css`

- [ ] **Step 1: Run existing history tests, confirm baseline pass**

```bash
npm run test --workspace=apps/web -- features/history
```

Expected: PASS.

- [ ] **Step 2: Replace markup classes in `HistoryRow.tsx`**

Read the file. Wrap each row as:
```tsx
<div className="history-row p-3 min-h-[56px] flex items-center justify-between hover:bg-[var(--color-surface-2)] cursor-pointer transition-colors border-b border-[var(--color-border)] last:border-b-0">
  <div className="flex flex-col gap-0.5 min-w-0">
    <span className="text-[var(--color-text)] font-semibold text-sm truncate">{name}</span>
    <span className="text-[var(--color-text-dim)] text-xs font-mono truncate">{path}</span>
  </div>
  <div className="flex items-center gap-2 shrink-0">
    {alive && (
      <div className="w-2 h-2 bg-[var(--color-success)] rounded-full shadow-[0_0_8px_color-mix(in_srgb,var(--color-success)_60%,transparent)]" aria-label="alive" />
    )}
    <span className="text-[var(--color-text-dim)] text-xs">{lastSeen}</span>
  </div>
</div>
```
(Adapt to the existing component's actual props — keep the same prop names and event handlers as today; only change className strings and DOM structure where required.)

- [ ] **Step 3: Replace markup classes in `HistoryPanel.tsx`**

Wrap the list:
```tsx
<aside className="history-panel w-full md:w-72 p-2 box-border">
  <h3 className="text-[var(--color-text-dim)] text-xs font-bold uppercase tracking-wider mb-2 px-1">History</h3>
  <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
    {/* existing list of HistoryRow */}
  </div>
</aside>
```

Empty state row inside the rounded card:
```tsx
<div className="p-3 text-sm text-[var(--color-text-dim)] text-center">No history</div>
```

- [ ] **Step 4: Delete `history.css` and remove its `import`**

```bash
git rm apps/web/src/features/history/history.css
```
Remove `import './history.css';` from `HistoryPanel.tsx` and `HistoryRow.tsx` if present.

- [ ] **Step 5: Run tests, typecheck**

```bash
npm run test --workspace=apps/web -- features/history
npm run web:typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/history
git commit -m "refactor(web): restyle HistoryPanel and HistoryRow with tailwind"
```

---

### Task 10: Home page (launcher)

**Files:**
- Modify: `apps/web/src/pages/Home.tsx`

- [ ] **Step 1: Replace `Home.tsx` with launcher layout**

Full new content for `apps/web/src/pages/Home.tsx`:
```tsx
import { useNavigate, useOutletContext, Link } from 'react-router-dom';
import { Plus, ChevronRight } from 'lucide-react';
import { useSessionsStore } from '../store/sessions';
import { useConnectionStore } from '../store/connection';
import type { AppShellOutletContext } from '../shell/AppShell';
import { useNewSession } from '../features/project-picker/useNewSession';
import { HistoryPanel } from '../features/history/HistoryPanel';

export function Home(): JSX.Element {
  const { client } = useOutletContext<AppShellOutletContext>();
  const order = useSessionsStore((s) => s.order);
  const sessionsMap = useSessionsStore((s) => s.sessions);
  const status = useConnectionStore((s) => s.status);
  const lastError = useConnectionStore((s) => s.lastError);
  const navigate = useNavigate();
  const newSession = useNewSession(client);

  const sessions = order
    .map((id) => sessionsMap[id]!)
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  const aliveSessions = sessions.filter((s) => s.alive).slice(0, 3);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 max-w-screen-md w-full mx-auto">
      {lastError && (
        <div
          role="alert"
          className="mb-3 px-3 py-2 rounded-lg text-sm bg-[color-mix(in_srgb,var(--color-danger)_20%,var(--color-surface))] text-[var(--color-danger)] border border-[var(--color-danger)]"
        >
          error: {lastError}
        </div>
      )}
      {status !== 'open' && (
        <div className="mb-3 px-3 py-2 rounded-lg text-xs text-[var(--color-text-dim)] bg-[var(--color-surface)] border border-[var(--color-border)]">
          connection: {status}
        </div>
      )}

      <button
        type="button"
        onClick={newSession.open}
        className="w-full bg-[var(--color-accent)] text-white font-semibold py-4 rounded-2xl text-xl mb-10 shadow-lg shadow-[color-mix(in_srgb,var(--color-accent)_30%,transparent)] hover:scale-[1.02] active:scale-[0.98] transition flex items-center justify-center gap-2"
      >
        <Plus size={22} aria-hidden="true" />
        New Session
      </button>

      <section className="mb-8">
        <div className="flex items-center justify-between mb-3 px-1">
          <h3 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase">
            Active Sessions
          </h3>
          <Link to="/sessions" className="text-[var(--color-text-dim)] hover:text-[var(--color-text)] flex items-center gap-1 text-xs">
            See all
            <ChevronRight size={14} aria-hidden="true" />
          </Link>
        </div>
        {aliveSessions.length === 0 ? (
          <div className="bg-[color-mix(in_srgb,var(--color-surface-2)_50%,transparent)] border border-[var(--color-border)] rounded-xl py-4 px-6 text-[var(--color-text-dim)] text-center font-medium">
            No active sessions
          </div>
        ) : (
          <ul className="list-none p-0 m-0 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl divide-y divide-[var(--color-border)] overflow-hidden">
            {aliveSessions.map((s) => {
              const label = s.projectPath.split('/').filter(Boolean).pop() ?? s.projectPath;
              return (
                <li key={s.sessionId}>
                  <button
                    type="button"
                    className="w-full text-left p-4 min-h-[56px] flex items-center justify-between hover:bg-[var(--color-surface-2)] transition-colors"
                    onClick={() => navigate(`/session/${s.sessionId}`)}
                  >
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-[var(--color-text)] font-bold truncate">{label}</span>
                      <span className="text-[var(--color-text-dim)] text-xs font-mono truncate">{s.projectPath}</span>
                    </div>
                    <div className="w-2.5 h-2.5 bg-[var(--color-success)] rounded-full shadow-[0_0_8px_color-mix(in_srgb,var(--color-success)_60%,transparent)] shrink-0" aria-label="alive" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <h3 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase">History</h3>
        </div>
        <HistoryPanel />
      </section>

      {newSession.pickerNode}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck and tests**

```bash
npm run web:typecheck
npm run test --workspace=apps/web
```

Expected: PASS.

- [ ] **Step 3: Manual smoke**

```bash
npm run web:dev
```
Visit `/`. Verify: big New Session button, Active Sessions section (empty card or list), History section. Stop server.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/Home.tsx
git commit -m "feat(web): Home page launcher with active sessions + history"
```

---

### Task 11: Sessions page

**Files:**
- Modify: `apps/web/src/pages/Sessions.tsx`
- Test: `apps/web/src/pages/Sessions.test.tsx`

- [ ] **Step 1: Write failing test**

Create `apps/web/src/pages/Sessions.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { Sessions } from './Sessions';
import { useSessionsStore } from '../store/sessions';

function ContextWrapper(): JSX.Element {
  const fakeClient = {} as unknown;
  return <Outlet context={{ client: fakeClient }} />;
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/sessions']}>
      <Routes>
        <Route element={<ContextWrapper />}>
          <Route path="/sessions" element={<Sessions />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Sessions page', () => {
  it('shows empty state when no alive sessions', () => {
    useSessionsStore.setState({ sessions: {}, order: [] });
    renderPage();
    expect(screen.getByText(/no active sessions/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm run test --workspace=apps/web -- pages/Sessions
```

Expected: FAIL — placeholder Sessions page does not contain expected empty-state text.

- [ ] **Step 3: Replace `Sessions.tsx` with full page**

```tsx
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useSessionsStore } from '../store/sessions';
import type { AppShellOutletContext } from '../shell/AppShell';
import { SessionList } from '../features/session-list/SessionList';
import { useNewSession } from '../features/project-picker/useNewSession';

export function Sessions(): JSX.Element {
  const { client } = useOutletContext<AppShellOutletContext>();
  const order = useSessionsStore((s) => s.order);
  const sessionsMap = useSessionsStore((s) => s.sessions);
  const navigate = useNavigate();
  const newSession = useNewSession(client);

  const aliveSessions = order
    .map((id) => sessionsMap[id]!)
    .filter((s): s is NonNullable<typeof s> => s !== undefined && s.alive);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 max-w-screen-md w-full mx-auto">
      <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3 px-1">Active Sessions</h2>
      {aliveSessions.length === 0 ? (
        <div className="bg-[color-mix(in_srgb,var(--color-surface-2)_50%,transparent)] border border-[var(--color-border)] rounded-xl py-6 px-6 text-[var(--color-text-dim)] text-center">
          No active sessions. Start one from Home or Projects.
        </div>
      ) : (
        <SessionList
          sessions={aliveSessions}
          activeId={null}
          onSelect={(id) => navigate(`/session/${id}`)}
          onNewSession={newSession.open}
        />
      )}
      {newSession.pickerNode}
    </div>
  );
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npm run test --workspace=apps/web -- pages/Sessions
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Sessions.tsx apps/web/src/pages/Sessions.test.tsx
git commit -m "feat(web): Sessions page with alive filter"
```

---

### Task 12: projectsStore + tests

**Files:**
- Create: `apps/web/src/features/projects/projectsStore.ts`
- Test: `apps/web/src/features/projects/projectsStore.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/web/src/features/projects/projectsStore.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectsStore } from './projectsStore';

describe('projectsStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useProjectsStore.setState({ paths: [] });
  });

  it('starts empty', () => {
    expect(useProjectsStore.getState().paths).toEqual([]);
  });

  it('add appends a path and dedupes case-sensitive', () => {
    const { add } = useProjectsStore.getState();
    add('/a');
    add('/b');
    add('/a');
    expect(useProjectsStore.getState().paths).toEqual(['/a', '/b']);
  });

  it('remove drops a path', () => {
    const { add, remove } = useProjectsStore.getState();
    add('/a');
    add('/b');
    remove('/a');
    expect(useProjectsStore.getState().paths).toEqual(['/b']);
  });

  it('move swaps positions', () => {
    const { add, move } = useProjectsStore.getState();
    add('/a');
    add('/b');
    add('/c');
    move(0, 2);
    expect(useProjectsStore.getState().paths).toEqual(['/b', '/c', '/a']);
  });

  it('persists to localStorage', () => {
    useProjectsStore.getState().add('/x');
    expect(localStorage.getItem('mrt.projects')).toContain('/x');
  });

  it('survives setItem failure', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota');
    };
    try {
      useProjectsStore.getState().add('/y');
      expect(useProjectsStore.getState().paths).toEqual(['/y']);
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm run test --workspace=apps/web -- projectsStore
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement projectsStore**

Create `apps/web/src/features/projects/projectsStore.ts`:
```ts
import { create } from 'zustand';

const STORAGE_KEY = 'mrt.projects';

function readStored(): string[] {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (!v) return [];
    const parsed: unknown = JSON.parse(v);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return [];
}

function writeStored(paths: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
  } catch {
    // ignore
  }
}

interface ProjectsState {
  paths: string[];
  add(path: string): void;
  remove(path: string): void;
  move(from: number, to: number): void;
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  paths: readStored(),
  add(path) {
    if (!path) return;
    const current = get().paths;
    if (current.includes(path)) return;
    const next = [...current, path];
    writeStored(next);
    set({ paths: next });
  },
  remove(path) {
    const next = get().paths.filter((p) => p !== path);
    writeStored(next);
    set({ paths: next });
  },
  move(from, to) {
    const current = get().paths;
    if (from < 0 || from >= current.length || to < 0 || to >= current.length) return;
    const next = current.slice();
    const [item] = next.splice(from, 1);
    if (item === undefined) return;
    next.splice(to, 0, item);
    writeStored(next);
    set({ paths: next });
  },
}));
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npm run test --workspace=apps/web -- projectsStore
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/projects
git commit -m "feat(web): projectsStore with localStorage persistence"
```

---

### Task 13: Projects page

**Files:**
- Modify: `apps/web/src/pages/Projects.tsx`
- Test: `apps/web/src/pages/Projects.test.tsx`

- [ ] **Step 1: Write failing test**

Create `apps/web/src/pages/Projects.test.tsx`:
```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { Projects } from './Projects';
import { useProjectsStore } from '../features/projects/projectsStore';

function ContextWrapper(): JSX.Element {
  return <Outlet context={{ client: {} }} />;
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/projects']}>
      <Routes>
        <Route element={<ContextWrapper />}>
          <Route path="/projects" element={<Projects />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Projects page', () => {
  beforeEach(() => {
    localStorage.clear();
    useProjectsStore.setState({ paths: [] });
  });

  it('shows empty state when no projects', () => {
    renderPage();
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
  });

  it('lists known projects with their paths', () => {
    useProjectsStore.setState({ paths: ['/Volumes/foo/bar', '/Volumes/baz'] });
    renderPage();
    expect(screen.getByText('bar')).toBeInTheDocument();
    expect(screen.getByText('baz')).toBeInTheDocument();
  });

  it('removes a project when delete clicked', () => {
    useProjectsStore.setState({ paths: ['/p1'] });
    renderPage();
    const deleteBtn = screen.getByRole('button', { name: /remove \/p1/i });
    fireEvent.click(deleteBtn);
    expect(useProjectsStore.getState().paths).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm run test --workspace=apps/web -- pages/Projects
```

Expected: FAIL — placeholder Projects page does not match.

- [ ] **Step 3: Replace `Projects.tsx`**

```tsx
import { useOutletContext } from 'react-router-dom';
import { Plus, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import type { AppShellOutletContext } from '../shell/AppShell';
import { useProjectsStore } from '../features/projects/projectsStore';
import { useNewSession } from '../features/project-picker/useNewSession';

export function Projects(): JSX.Element {
  const { client } = useOutletContext<AppShellOutletContext>();
  const paths = useProjectsStore((s) => s.paths);
  const remove = useProjectsStore((s) => s.remove);
  const move = useProjectsStore((s) => s.move);
  const newSession = useNewSession(client);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 max-w-screen-md w-full mx-auto">
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase">Projects</h2>
        <button
          type="button"
          onClick={newSession.open}
          className="flex items-center gap-1 text-xs px-3 py-2 min-h-[36px] rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90"
        >
          <Plus size={14} aria-hidden="true" />
          Add Project
        </button>
      </div>

      {paths.length === 0 ? (
        <div className="bg-[color-mix(in_srgb,var(--color-surface-2)_50%,transparent)] border border-[var(--color-border)] rounded-xl py-6 px-6 text-[var(--color-text-dim)] text-center">
          No projects yet. Tap “Add Project” to start a new session.
        </div>
      ) : (
        <ul className="list-none p-0 m-0 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl divide-y divide-[var(--color-border)] overflow-hidden">
          {paths.map((path, i) => {
            const label = path.split('/').filter(Boolean).pop() ?? path;
            return (
              <li key={path} className="p-3 flex items-center justify-between min-h-[56px] gap-2">
                <button
                  type="button"
                  onClick={newSession.open}
                  className="flex-1 text-left flex flex-col gap-0.5 min-w-0"
                >
                  <span className="text-[var(--color-text)] font-semibold truncate">{label}</span>
                  <span className="text-[var(--color-text-dim)] text-xs font-mono truncate">{path}</span>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => move(i, Math.max(0, i - 1))}
                    disabled={i === 0}
                    aria-label={`Move ${path} up`}
                    className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ArrowUp size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, Math.min(paths.length - 1, i + 1))}
                    disabled={i === paths.length - 1}
                    aria-label={`Move ${path} down`}
                    className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ArrowDown size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(path)}
                    aria-label={`Remove ${path}`}
                    className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-danger)]"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {newSession.pickerNode}
    </div>
  );
}
```

- [ ] **Step 4: Auto-populate `projectsStore` from sessions in `AppShell`**

Edit `apps/web/src/shell/AppShell.tsx`. After the existing `useEffect` block, add:
```tsx
useEffect(() => {
  const unsub = useSessionsStore.subscribe((state) => {
    const projectStore = useProjectsStore.getState();
    for (const s of Object.values(state.sessions)) {
      if (s && s.projectPath) projectStore.add(s.projectPath);
    }
  });
  return () => unsub();
}, []);
```
And add to imports at top of `AppShell.tsx`:
```tsx
import { useProjectsStore } from '../features/projects/projectsStore';
```

- [ ] **Step 5: Run all tests, typecheck**

```bash
npm run test --workspace=apps/web
npm run web:typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/Projects.tsx apps/web/src/pages/Projects.test.tsx apps/web/src/shell/AppShell.tsx
git commit -m "feat(web): Projects page with reorder + remove + auto-populate"
```

---

### Task 14: Restyle ProjectPicker (use Modal)

**Files:**
- Modify: `apps/web/src/features/project-picker/ProjectPicker.tsx`
- Delete: `apps/web/src/features/project-picker/ProjectPicker.css`
- Test: `apps/web/src/features/project-picker/ProjectPicker.test.tsx` (existing — should still pass)

- [ ] **Step 1: Run existing tests, confirm baseline**

```bash
npm run test --workspace=apps/web -- project-picker
```

Expected: PASS.

- [ ] **Step 2: Replace component markup**

Read existing `ProjectPicker.tsx`. Identify:
- Where the modal wrapper / backdrop is rendered (replace with `<Modal open onClose={onClose} ariaLabel="Select Project">`).
- The agent picker section (Claude/Codex avatars).
- The working-dir input + add button.
- The list of directories with up/down/trash buttons.
- The Cancel + Open buttons row.

Restyle each block with utility classes matching the mockup. Key snippets:

Replace outer wrapper:
```tsx
import { Modal } from '../../shell/Modal';
import { Plus, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
// ... existing imports preserved

export function ProjectPicker({ open, onClose, /* rest */ }: ProjectPickerProps): JSX.Element {
  return (
    <Modal open={open} onClose={onClose} ariaLabel="Select Project">
      <div className="p-6">
        <h2 className="text-[var(--color-text)] text-xl font-semibold text-center mb-6">Select Project</h2>
        {/* Agent selector (existing logic, restyled) */}
        <div className="flex justify-center gap-8 mb-8">
          {/* ... map agents ... */}
        </div>
        {/* Working Directory (existing logic, restyled) */}
        <div className="space-y-4">
          <label className="text-[var(--color-text)] text-[15px] font-semibold block">Working Directory</label>
          <div className="flex gap-2">
            <input
              className="flex-1 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              placeholder="Add a working directory path"
              /* existing onChange/value */
            />
            <button
              type="button"
              className="p-2 bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90"
              /* existing onClick */
              aria-label="Add directory"
            >
              <Plus size={20} />
            </button>
          </div>
          <ul className="space-y-1 max-h-60 overflow-y-auto pr-1 list-none p-0 m-0">
            {/* map dirs with ArrowUp/ArrowDown/Trash2 buttons */}
          </ul>
        </div>
      </div>
      <div className="flex p-4 gap-3 bg-[color-mix(in_srgb,var(--color-bg)_50%,var(--color-surface))] border-t border-[var(--color-border)]">
        <button
          type="button"
          className="flex-1 py-2.5 min-h-[44px] bg-[var(--color-surface-2)] text-[var(--color-text)] rounded-xl font-medium hover:bg-[var(--color-surface)] transition-colors"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="flex-1 py-2.5 min-h-[44px] bg-[var(--color-accent)] text-white rounded-xl font-medium hover:opacity-90 transition-colors shadow-lg shadow-[color-mix(in_srgb,var(--color-accent)_30%,transparent)]"
          /* existing submit handler */
        >
          Open Project
        </button>
      </div>
    </Modal>
  );
}
```

(Preserve all existing prop names, state, handlers, profile-related logic. Only the JSX tree + classes change.)

For the agent avatar:
```tsx
<button
  type="button"
  onClick={() => setActiveAgent(agent)}
  className="flex flex-col items-center gap-2 group min-w-[64px]"
>
  <div className={`w-14 h-14 rounded-full flex items-center justify-center text-2xl font-bold transition-all ${
    activeAgent === agent
      ? 'bg-[var(--color-accent)] text-white ring-4 ring-[color-mix(in_srgb,var(--color-accent)_20%,transparent)]'
      : 'bg-[var(--color-surface-2)] text-[var(--color-text-dim)] group-hover:bg-[var(--color-surface)]'
  }`}>
    {agent[0].toUpperCase()}
  </div>
  <span className={`text-sm font-medium ${activeAgent === agent ? 'text-[var(--color-text)]' : 'text-[var(--color-text-dim)]'}`}>
    {agentLabel(agent)}
  </span>
</button>
```

For each working-dir row:
```tsx
<li className="flex items-center justify-between py-2 border-b border-[var(--color-border)] last:border-b-0 group">
  <span className="text-[var(--color-text)] text-sm font-mono truncate min-w-0">{dir.path}</span>
  <div className="flex items-center gap-1 shrink-0">
    <button type="button" onClick={() => moveUp(dir.id)} aria-label={`Move ${dir.path} up`} className="p-2 min-w-[44px] min-h-[44px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"><ArrowUp size={16} /></button>
    <button type="button" onClick={() => moveDown(dir.id)} aria-label={`Move ${dir.path} down`} className="p-2 min-w-[44px] min-h-[44px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"><ArrowDown size={16} /></button>
    <button type="button" onClick={() => remove(dir.id)} aria-label={`Remove ${dir.path}`} className="p-2 min-w-[44px] min-h-[44px] text-[var(--color-text-dim)] hover:text-[var(--color-danger)]"><Trash2 size={16} /></button>
  </div>
</li>
```

(Adapt names like `moveUp`, `moveDown`, `remove`, `dir.id` to whatever the existing component already uses. The point is to swap CSS classes for utility classes and use lucide icons in place of any emoji or text icons.)

- [ ] **Step 3: Delete `ProjectPicker.css`**

```bash
git rm apps/web/src/features/project-picker/ProjectPicker.css
```
Remove the corresponding `import './ProjectPicker.css';` line in `ProjectPicker.tsx`.

- [ ] **Step 4: Run tests + typecheck**

```bash
npm run test --workspace=apps/web -- project-picker
npm run web:typecheck
```

Expected: PASS. If tests assert on legacy class names, update them to assert on roles + accessible names instead.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/project-picker
git commit -m "refactor(web): restyle ProjectPicker using Modal primitive"
```

---

### Task 15: Settings page — Connection + Appearance + Default agent

**Files:**
- Modify: `apps/web/src/pages/Settings.tsx`
- Test: `apps/web/src/pages/Settings.test.tsx`

- [ ] **Step 1: Write failing test**

Create `apps/web/src/pages/Settings.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { Settings } from './Settings';
import { useThemeStore } from '../shell/themeStore';

function ContextWrapper(): JSX.Element {
  return <Outlet context={{ client: {} }} />;
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route element={<ContextWrapper />}>
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Settings page', () => {
  it('renders Connection, Appearance, and Default agent sections', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /connection/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /appearance/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /default agent/i })).toBeInTheDocument();
  });

  it('changes theme mode when a radio is selected', () => {
    useThemeStore.setState({ mode: 'system' });
    renderPage();
    const dark = screen.getByRole('radio', { name: /dark/i });
    fireEvent.click(dark);
    expect(useThemeStore.getState().mode).toBe('dark');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm run test --workspace=apps/web -- pages/Settings
```

Expected: FAIL — placeholder Settings page lacks expected headings.

- [ ] **Step 3: Replace `Settings.tsx`**

```tsx
import { useConnectionStore } from '../store/connection';
import { useThemeStore, type ThemeMode } from '../shell/themeStore';

const themes: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function Settings(): JSX.Element {
  const status = useConnectionStore((s) => s.status);
  const lastError = useConnectionStore((s) => s.lastError);
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 max-w-screen-md w-full mx-auto space-y-8">
      <h1 className="text-[var(--color-text)] text-xl font-semibold">Settings</h1>

      <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
        <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3">Connection</h2>
        <div className="text-sm space-y-1">
          <div className="text-[var(--color-text)]">Status: {status}</div>
          {lastError && <div className="text-[var(--color-danger)]">{lastError}</div>}
        </div>
      </section>

      <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
        <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3">Appearance</h2>
        <fieldset>
          <legend className="sr-only">Theme</legend>
          <div className="flex gap-2">
            {themes.map((t) => (
              <label key={t.value} className={`flex-1 cursor-pointer text-center rounded-lg px-3 py-2 min-h-[44px] flex items-center justify-center text-sm transition-colors ${
                mode === t.value
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'bg-[var(--color-surface-2)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
              }`}>
                <input
                  type="radio"
                  name="theme"
                  value={t.value}
                  checked={mode === t.value}
                  onChange={() => setMode(t.value)}
                  className="sr-only"
                />
                {t.label}
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
        <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3">Default agent</h2>
        <p className="text-[var(--color-text-dim)] text-sm">Default agent selection is applied when starting a new session via Home or Projects. (Persisted per-session inside ProjectPicker for v1.)</p>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npm run test --workspace=apps/web -- pages/Settings
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Settings.tsx apps/web/src/pages/Settings.test.tsx
git commit -m "feat(web): Settings page (Connection + Appearance + Default agent)"
```

---

### Task 16: Settings — Default workspaces section

**Files:**
- Modify: `apps/web/src/pages/Settings.tsx`
- Reuse: `apps/web/src/features/project-picker/default-workspaces.ts`

- [ ] **Step 1: Inspect existing default-workspaces module**

```bash
sed -n '1,80p' apps/web/src/features/project-picker/default-workspaces.ts
```
Note the exported API. (Whatever `getDefaultWorkspaces`, `setDefaultWorkspaces`, etc. function names exist — the code below references them generically as `getDefaults` / `addDefault` / `removeDefault`. Substitute the actual names.)

- [ ] **Step 2: Add Default Workspaces section to Settings**

In `apps/web/src/pages/Settings.tsx`, after the Default agent section, add:
```tsx
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  /* substitute actual exported names */
  getDefaultWorkspaces,
  setDefaultWorkspaces,
} from '../features/project-picker/default-workspaces';
// ... existing imports

// Inside component body, before return:
const [workspaces, setWorkspaces] = useState<string[]>(() => getDefaultWorkspaces());
const [draft, setDraft] = useState('');

const persist = (next: string[]): void => {
  setWorkspaces(next);
  setDefaultWorkspaces(next);
};
```

And in the JSX:
```tsx
<section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
  <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3">Default workspaces</h2>
  <div className="flex gap-2 mb-3">
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      placeholder="/Volumes/.../my-project"
      className="flex-1 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
    />
    <button
      type="button"
      onClick={() => {
        const v = draft.trim();
        if (!v || workspaces.includes(v)) return;
        persist([...workspaces, v]);
        setDraft('');
      }}
      aria-label="Add default workspace"
      className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90"
    >
      <Plus size={18} />
    </button>
  </div>
  {workspaces.length === 0 ? (
    <div className="text-sm text-[var(--color-text-dim)]">No default workspaces.</div>
  ) : (
    <ul className="list-none p-0 m-0 divide-y divide-[var(--color-border)]">
      {workspaces.map((p) => (
        <li key={p} className="flex items-center justify-between py-2">
          <span className="text-[var(--color-text)] text-sm font-mono truncate min-w-0">{p}</span>
          <button
            type="button"
            onClick={() => persist(workspaces.filter((x) => x !== p))}
            aria-label={`Remove ${p}`}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-danger)]"
          >
            <Trash2 size={16} />
          </button>
        </li>
      ))}
    </ul>
  )}
</section>
```

NOTE: replace `getDefaultWorkspaces` / `setDefaultWorkspaces` with the actual exported names from `default-workspaces.ts`. If the API is async or stores into another sink, adapt the calls accordingly.

- [ ] **Step 3: Add a test for the section**

In `apps/web/src/pages/Settings.test.tsx`, add a new test:
```tsx
it('renders Default workspaces section with add input', () => {
  renderPage();
  expect(screen.getByRole('heading', { name: /default workspaces/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /add default workspace/i })).toBeInTheDocument();
});
```

- [ ] **Step 4: Run tests + typecheck**

```bash
npm run test --workspace=apps/web -- pages/Settings
npm run web:typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Settings.tsx apps/web/src/pages/Settings.test.tsx
git commit -m "feat(web): Settings — default workspaces section"
```

---

### Task 17: Settings — Profiles section (port profile UI)

**Files:**
- Modify: `apps/web/src/pages/Settings.tsx`
- Modify: `apps/web/src/features/profiles/*.tsx` (restyle)
- Delete: `apps/web/src/features/profiles/profiles.css`

- [ ] **Step 1: Inspect profiles feature**

```bash
ls apps/web/src/features/profiles
sed -n '1,80p' apps/web/src/features/profiles/profileStore.ts
```
Note the exported component name(s) (e.g. `ProfileManager`, `ProfileList`, `ProfileEditor`). The code below assumes a single `<ProfileManager />` — adapt to actual names.

- [ ] **Step 2: Restyle profile components**

For each `.tsx` file in `apps/web/src/features/profiles/`, replace per-feature class names with utility classes following the same pattern used in Tasks 8–10:
- Card wrapper: `bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4`
- List rows: `p-3 min-h-[56px] flex items-center justify-between border-b border-[var(--color-border)] last:border-b-0`
- Inputs: `bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]`
- Primary buttons: `bg-[var(--color-accent)] text-white rounded-lg px-3 py-2 min-h-[44px] hover:opacity-90`
- Secondary buttons: `bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] rounded-lg px-3 py-2 min-h-[44px] hover:bg-[var(--color-surface)]`

Replace any emoji icons with lucide equivalents (`Plus`, `Trash2`, `Edit3`, `Check`, `X`, `Star`).

- [ ] **Step 3: Embed `<ProfileManager />` in Settings**

In `apps/web/src/pages/Settings.tsx`, after Default workspaces section, add:
```tsx
import { ProfileManager } from '../features/profiles/ProfileManager'; // adjust path/name

// In JSX:
<section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
  <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3">Profiles</h2>
  <ProfileManager />
</section>
```

(If the existing profile UI is currently embedded inside ProjectPicker, leave that placement alone for now — Settings is the *new* canonical home. Keeping both renderings until Task 24 cleanup is acceptable.)

- [ ] **Step 4: Delete `profiles.css` and remove its imports**

```bash
git rm apps/web/src/features/profiles/profiles.css
```
Remove `import './profiles.css';` from each profile component.

- [ ] **Step 5: Run tests + typecheck**

```bash
npm run test --workspace=apps/web
npm run web:typecheck
```

Expected: PASS. If existing profile tests select on legacy CSS classes, update to assert on roles/accessible names.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/profiles apps/web/src/pages/Settings.tsx
git commit -m "refactor(web): restyle profiles + embed in Settings"
```

---

### Task 18: Settings — Accounts section

**Files:**
- Modify: `apps/web/src/pages/Settings.tsx`

- [ ] **Step 1: Add Accounts section**

In `apps/web/src/pages/Settings.tsx`, append after the Profiles section:
```tsx
import { useAccountsStore } from '../store/accounts';
// ... existing imports

// Inside component:
const accounts = useAccountsStore((s) => s.accounts);

// In JSX:
<section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4">
  <h2 className="text-[var(--color-text-dim)] text-xs font-bold tracking-wider uppercase mb-3">Accounts</h2>
  {accounts.length === 0 ? (
    <div className="text-sm text-[var(--color-text-dim)]">No accounts.</div>
  ) : (
    <ul className="list-none p-0 m-0 divide-y divide-[var(--color-border)]">
      {accounts.map((a) => (
        <li key={a.id} className="py-2 flex items-center justify-between">
          <span className="text-[var(--color-text)] text-sm">{a.name ?? a.id}</span>
          <span className="text-[var(--color-text-dim)] text-xs">{a.kind ?? ''}</span>
        </li>
      ))}
    </ul>
  )}
</section>
```
(Adapt prop names `id`, `name`, `kind` to whatever the existing `useAccountsStore` exposes per-account.)

- [ ] **Step 2: Add a test for the section**

In `Settings.test.tsx`:
```tsx
it('renders Accounts heading', () => {
  renderPage();
  expect(screen.getByRole('heading', { name: /accounts/i })).toBeInTheDocument();
});
```

- [ ] **Step 3: Run tests + typecheck**

```bash
npm run test --workspace=apps/web -- pages/Settings
npm run web:typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/Settings.tsx apps/web/src/pages/Settings.test.tsx
git commit -m "feat(web): Settings — accounts section"
```

---

### Task 19: Restyle Chat shell (header, banners, scroll, drop-overlay)

**Files:**
- Modify: `apps/web/src/features/chat/Chat.tsx`
- Delete: `apps/web/src/features/chat/Chat.css`

- [ ] **Step 1: Run baseline chat tests**

```bash
npm run test --workspace=apps/web -- features/chat
```
Expected: PASS.

- [ ] **Step 2: Replace `Chat.tsx` markup**

Full replacement for `apps/web/src/features/chat/Chat.tsx`:
```tsx
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, Folder } from 'lucide-react';
import type { SessionView } from '../../store/sessions';
import { useSessionsStore } from '../../store/sessions';
import { MessageBubble } from './MessageBubble';
import { InputBox } from './InputBox';
import { ResumePrompt } from './ResumePrompt';
import { SessionRenameInline } from '../session-list/SessionRenameInline';
import { useImagePaste } from '../image-attach/useImagePaste';

interface ChatProps {
  session: SessionView;
  onSend(text: string, images?: ReadonlyArray<{ mime: string; base64: string }>): void;
  onStop(): void;
  onOpenMobileNav?(opener?: HTMLElement): void;
  onToggleDrawer?(): void;
  drawerOpen?: boolean;
  banner?: string | null;
  errorBanner?: string | null;
  inputDisabled?: boolean;
}

export function Chat({
  session,
  onSend,
  onStop,
  onOpenMobileNav,
  onToggleDrawer,
  drawerOpen,
  banner,
  errorBanner,
  inputDisabled,
}: ChatProps): JSX.Element {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const imagePaste = useImagePaste();
  const imagesEnabled = session.agent === 'claude' && session.alive && !inputDisabled;
  const [dragOver, setDragOver] = useState(false);
  const [renamingHeader, setRenamingHeader] = useState(false);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.events]);

  useEffect(() => {
    imagePaste.clear();
    setDragOver(false);
    setRenamingHeader(false);
  }, [session.sessionId]);

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!imagesEnabled) return;
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    if (e.currentTarget === e.target) setDragOver(false);
  };
  const onDrop = async (e: DragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault();
    setDragOver(false);
    if (!imagesEnabled) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    for (const f of files) await imagePaste.addImageFromFile(f);
  };

  return (
    <div
      className="chat flex-1 min-h-0 flex flex-col bg-[var(--color-bg)] text-[var(--color-text)] relative"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="chat-header flex items-center gap-2 px-3 py-2 min-h-[3rem] bg-[var(--color-surface)] border-b border-[var(--color-border)]">
        {onOpenMobileNav && (
          <button
            type="button"
            className="chat-mobile-menu md:hidden inline-flex items-center justify-center min-w-[44px] min-h-[44px] text-[var(--color-text-dim)] hover:text-[var(--color-text)] rounded"
            onClick={(event) => onOpenMobileNav(event.currentTarget)}
            aria-label="Open sessions and history"
          >
            <Menu size={20} aria-hidden="true" />
          </button>
        )}
        <code className="text-xs text-[var(--color-text-dim)] font-mono truncate min-w-0 flex-1">
          {session.projectPath}
        </code>
        {renamingHeader ? (
          <SessionRenameInline
            sessionId={session.sessionId}
            initialName={session.name ?? ''}
            onClose={() => setRenamingHeader(false)}
          />
        ) : (
          <>
            <span className="session-header-name text-[var(--color-text-mute)] text-xs whitespace-nowrap overflow-hidden text-ellipsis max-w-[14rem]">
              {session.name ?? session.sessionId.slice(0, 8)}
            </span>
            <button
              type="button"
              className="session-rename-pencil session-header-pencil min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] rounded"
              onClick={(e) => { e.stopPropagation(); setRenamingHeader(true); }}
              aria-label="Rename session"
            >
              ✏️
            </button>
          </>
        )}
        {onToggleDrawer && (
          <button
            type="button"
            className="chat-drawer-toggle min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] rounded"
            onClick={onToggleDrawer}
            aria-label="Toggle file explorer"
            aria-pressed={drawerOpen ? 'true' : 'false'}
          >
            <Folder size={18} aria-hidden="true" />
          </button>
        )}
      </header>

      {banner && (
        <div className="chat-banner bg-[color-mix(in_srgb,var(--color-warn)_18%,var(--color-surface))] text-[var(--color-warn)] px-3 py-2 text-sm border-b border-[color-mix(in_srgb,var(--color-warn)_30%,var(--color-border))]">
          {banner}
        </div>
      )}
      {errorBanner && (
        <div className="chat-error-banner bg-[color-mix(in_srgb,var(--color-danger)_18%,var(--color-surface))] text-[var(--color-danger)] px-3 py-2 text-sm border-b border-[color-mix(in_srgb,var(--color-danger)_30%,var(--color-border))]">
          {errorBanner}
        </div>
      )}

      <div className="chat-scroll flex-1 min-h-0 overflow-y-auto px-3 py-3 font-mono text-sm leading-relaxed" ref={scrollRef}>
        {session.events.map((e, i) => (
          <MessageBubble
            key={`${i}-${e.type}-${e.type === 'system' ? e.event : (e as { seq: number }).seq}`}
            event={e}
          />
        ))}
      </div>

      {dragOver && imagesEnabled && (
        <div className="image-attach-drop-overlay absolute inset-0 flex items-center justify-center bg-black/60 text-[var(--color-text)] text-lg pointer-events-none z-30">
          Drop image to attach
        </div>
      )}

      {!session.alive && (
        session.events.length > 0 ? (
          <ResumePrompt
            webSessionId={session.sessionId}
            alive={session.alive}
            onResume={() => void useSessionsStore.getState().resume(session.sessionId)}
          />
        ) : (
          <div className="resume-prompt flex items-center justify-center gap-2 px-3 py-2 my-2 mx-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-mute)] text-sm">
            <span>session ended; transcript unavailable —</span>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="bg-[var(--color-surface-2)] text-[var(--color-accent)] border border-[var(--color-border)] px-3 py-1 rounded hover:bg-[var(--color-surface)]"
            >
              New session
            </button>
          </div>
        )
      )}

      <InputBox
        onSend={onSend}
        onStop={onStop}
        disabled={Boolean(inputDisabled)}
        alive={session.alive}
        onResume={async () => useSessionsStore.getState().resume(session.sessionId)}
        currentProjectPath={session.projectPath}
        agent={session.agent}
        imagePaste={imagePaste}
        sessionId={session.sessionId}
      />
    </div>
  );
}
```

(NOTE: removed `import './Chat.css';`. Class names like `chat-header`, `chat-mobile-menu`, `chat-drawer-toggle`, `chat-scroll`, `chat-banner`, `chat-error-banner`, `image-attach-drop-overlay`, `resume-prompt`, `session-header-name`, `session-rename-pencil`, `session-header-pencil` are kept as decoration so existing tests selecting on them still find elements.)

- [ ] **Step 3: Delete `Chat.css`**

```bash
git rm apps/web/src/features/chat/Chat.css
```

- [ ] **Step 4: Run tests + typecheck**

```bash
npm run test --workspace=apps/web -- features/chat
npm run web:typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/chat/Chat.tsx
git commit -m "refactor(web): restyle Chat shell with tailwind"
```

---

### Task 20: Restyle MessageBubble

**Files:**
- Modify: `apps/web/src/features/chat/MessageBubble.tsx`

- [ ] **Step 1: Replace `MessageBubble.tsx`**

Full content:
```tsx
import { useState } from 'react';
import { Play, ChevronRight, ChevronDown } from 'lucide-react';
import type { SessionEvent } from '../../store/sessions';
import { MarkdownRenderer } from '../markdown/MarkdownRenderer';

interface MessageBubbleProps {
  event: SessionEvent;
}

const systemBubble = 'bubble system flex justify-center my-2 text-[var(--color-text-dim)] italic text-xs font-mono';
const userBubble =
  'bubble user max-w-[85%] ml-auto px-4 py-2.5 my-1 rounded-2xl bg-[var(--color-bubble-user)] text-white text-[15px] leading-relaxed whitespace-pre-wrap break-words';
const assistantBubble =
  'bubble assistant max-w-[85%] mr-auto px-4 py-2.5 my-1 rounded-2xl bg-[var(--color-bubble-ai)] text-[var(--color-text)] text-[15px] leading-relaxed whitespace-pre-wrap break-words';
const deltaBubble = 'bubble-delta px-1 bg-[var(--color-bubble-ai)]';

export function MessageBubble({ event }: MessageBubbleProps): JSX.Element | null {
  if (event.superseded) return null;
  if (event.type === 'system' && event.event === 'session_created') {
    return <div className={systemBubble}><span>session started</span></div>;
  }
  if (event.type === 'system' && event.event === 'session_ended') {
    const reason = event.reason;
    return (
      <div className={systemBubble}>
        <span>session ended (exit {event.exitCode ?? '?'}{reason ? `, ${reason}` : ''})</span>
      </div>
    );
  }
  if (event.type === 'stream_delta') {
    const delta = (event.payload as { delta?: string }).delta ?? '';
    return <span className={deltaBubble}>{delta}</span>;
  }
  if (event.type === 'assistant') {
    const payload = event.payload as { text?: string; toolUse?: { toolName: string; input: unknown } };
    if (payload.text) {
      return (
        <div className={assistantBubble}>
          <MarkdownRenderer source={payload.text} />
        </div>
      );
    }
    if (payload.toolUse) {
      return <ToolUseBubble toolName={payload.toolUse.toolName} input={payload.toolUse.input} />;
    }
    return null;
  }
  if (event.type === 'tool_result') {
    const payload = event.payload as { toolUseId: string; output: unknown };
    return <ToolResultBubble output={payload.output} />;
  }
  if (event.type === 'user') {
    const payload = event.payload as { text?: string };
    return (
      <div className={userBubble}>
        <MarkdownRenderer source={payload.text ?? ''} />
      </div>
    );
  }
  if (event.type === 'result') {
    const payload = event.payload as { cost?: number; durationMs?: number };
    const parts: string[] = [];
    if (typeof payload.durationMs === 'number') parts.push(`${payload.durationMs} ms`);
    if (typeof payload.cost === 'number') parts.push(`$${payload.cost.toFixed(4)}`);
    return <div className={systemBubble}><span>turn complete{parts.length > 0 ? ` (${parts.join(', ')})` : ''}</span></div>;
  }
  return null;
}

function ToolUseBubble({ toolName, input }: { toolName: string; input: unknown }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="bubble tool-use my-2 mr-auto max-w-[85%]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-tool-shell)] border border-[color-mix(in_srgb,var(--color-success)_50%,var(--color-border))] text-[var(--color-success)] font-mono text-sm"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Play size={14} aria-hidden="true" />
        <span>tool: {toolName}</span>
      </button>
      {open && (
        <pre className="mt-1 ml-2 px-3 py-2 bg-black text-[var(--color-success)] rounded overflow-x-auto text-xs">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResultBubble({ output }: { output: unknown }): JSX.Element {
  const [open, setOpen] = useState(false);
  const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  return (
    <div className="bubble tool-result my-2 mr-auto max-w-[85%]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-tool-result)] border border-[color-mix(in_srgb,var(--color-warn)_50%,var(--color-border))] text-[var(--color-warn)] font-mono text-sm"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Play size={14} aria-hidden="true" />
        <span>tool result ({text.length} chars)</span>
      </button>
      {open && (
        <pre className="mt-1 ml-2 px-3 py-2 bg-black text-[var(--color-warn)] rounded overflow-x-auto text-xs">
          {text}
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run tests + typecheck**

```bash
npm run test --workspace=apps/web -- features/chat/MessageBubble
npm run web:typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/chat/MessageBubble.tsx
git commit -m "refactor(web): restyle MessageBubble with tailwind + lucide"
```

---

### Task 21: Restyle InputBox + ResumePrompt

**Files:**
- Modify: `apps/web/src/features/chat/InputBox.tsx`
- Modify: `apps/web/src/features/chat/ResumePrompt.tsx`

- [ ] **Step 1: Replace `InputBox.tsx` JSX (logic untouched)**

Open `apps/web/src/features/chat/InputBox.tsx`. Keep ALL state, refs, handlers, and effect logic (lines 38–203 of the current file) unchanged. Replace the **return** block (currently at line 205+) with:
```tsx
return (
  <div className="input-box relative p-3 bg-[var(--color-surface)] border-t border-[var(--color-border)]" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
    {historyOpen && (
      <PromptHistoryDropdown
        {...(currentProjectPath !== undefined ? { currentProjectPath } : {})}
        onPick={(picked) => {
          setText(picked);
          setHistoryOpen(false);
        }}
        onClose={() => setHistoryOpen(false)}
      />
    )}
    <ImageThumbnails images={images} onRemove={removeImage} />
    {error && <div className="image-attach-error text-xs text-[var(--color-danger)] mb-1">{error}</div>}
    {showResumePromptInline && (
      <div className="resume-prompt flex items-center justify-center gap-2 mb-2 px-3 py-2 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-mute)] text-sm">
        <span>Sending will resume the session —</span>
        <button
          type="button"
          className="resume-prompt-button bg-[var(--color-surface)] text-[var(--color-accent)] border border-[var(--color-border)] px-3 py-1 rounded hover:bg-[var(--color-surface-2)]"
          onClick={() => void onResumeAndSend()}
        >
          Resume + send
        </button>
      </div>
    )}
    <div className="input-textarea-wrap relative bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-xl p-3 flex flex-col gap-3 shadow-inner">
      <SlashAutocomplete
        ref={slashRef}
        sessionId={sessionId}
        agent={agent}
        text={text}
        cursor={cursor}
        onPick={onPick}
      />
      <AtTagAutocomplete
        ref={atRef}
        sessionId={sessionId}
        text={text}
        cursor={cursor}
        onPick={onPick}
      />
      <textarea
        ref={taRef}
        value={text}
        placeholder={
          disabled
            ? 'Session ended.'
            : agent === 'codex'
              ? 'Type a prompt. Cmd/Ctrl+Enter to send. ↑ on empty input opens history. (Codex: no image input.)'
              : 'Type a prompt. Cmd/Ctrl+Enter to send. ↑ on empty input opens history. Paste/drop/📎 to attach images.'
        }
        onChange={(e) => {
          setText(e.target.value);
          setCursor(e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={onKey}
        onKeyUp={updateCursor}
        onSelect={updateCursor}
        onClick={updateCursor}
        onPaste={onPaste}
        rows={3}
        disabled={disabled}
        className="bg-transparent border-0 outline-none ring-0 text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] resize-none min-h-[3rem] text-sm md:text-[15px] focus:ring-0 disabled:opacity-60"
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={onFileInputChange}
      />
      <div className="input-actions flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="image-attach-button p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[color-mix(in_srgb,var(--color-surface)_70%,transparent)] rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={onAttachClick}
            disabled={!imagesEnabled}
            title={agent === 'codex' ? 'Codex sessions do not accept images' : 'Attach image (paste / drop / click)'}
            aria-label="Attach image"
          >
            <Paperclip size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setHistoryOpen((h) => !h)}
            disabled={disabled}
            aria-label="Toggle prompt history"
            className="flex items-center gap-1.5 px-3 py-2 min-h-[44px] bg-[var(--color-surface)] text-[var(--color-text-mute)] rounded-lg text-sm font-mono hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <History size={16} aria-hidden="true" />
            <span>⌘H</span>
          </button>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            onClick={onStop}
            disabled={disabled}
            className="flex items-center gap-2 px-3 py-2 min-h-[44px] bg-[var(--color-surface)] text-[var(--color-text)] rounded-lg text-sm font-medium hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="w-2.5 h-2.5 bg-[var(--color-text)] rounded-sm shrink-0" aria-hidden="true" />
            <span>Stop</span>
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={disabled || (text.trim().length === 0 && images.length === 0)}
            className={[
              'flex items-center gap-1 px-5 py-2 min-h-[44px] rounded-lg text-sm font-medium transition',
              disabled || (text.trim().length === 0 && images.length === 0)
                ? 'bg-[var(--color-surface)] text-[var(--color-text-dim)] cursor-not-allowed'
                : 'bg-[var(--color-accent)] text-white hover:opacity-90',
            ].join(' ')}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  </div>
);
```

Add `lucide-react` import at the top (alongside existing imports):
```tsx
import { Paperclip, History } from 'lucide-react';
```

- [ ] **Step 2: Replace `ResumePrompt.tsx` markup**

Read existing `ResumePrompt.tsx`. Restyle wrapper and button:
```tsx
<div className="resume-prompt flex items-center justify-center gap-2 px-3 py-2 mx-3 my-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-mute)] text-sm">
  {/* existing children */}
  <button
    type="button"
    className="resume-prompt-button bg-[var(--color-surface-2)] text-[var(--color-accent)] border border-[var(--color-border)] px-3 py-1 rounded hover:bg-[var(--color-surface)]"
    onClick={onResume}
  >
    Resume
  </button>
</div>
```
(Adapt children/button labels to match existing component.)

- [ ] **Step 3: Run tests + typecheck**

```bash
npm run test --workspace=apps/web -- features/chat
npm run web:typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/chat/InputBox.tsx apps/web/src/features/chat/ResumePrompt.tsx
git commit -m "refactor(web): restyle InputBox + ResumePrompt with tailwind + lucide"
```

---

### Task 22: Restyle SlashAutocomplete + AtTagAutocomplete

**Files:**
- Modify: `apps/web/src/features/chat/SlashAutocomplete.tsx`
- Modify: `apps/web/src/features/chat/AtTagAutocomplete.tsx`

- [ ] **Step 1: Identify popup wrapper in each file**

Both autocomplete components currently render a `.autocomplete-popup` wrapper from `App.css`. Find that wrapper's JSX in each file.

- [ ] **Step 2: Replace popup wrapper class**

For desktop popover behavior (≥md), use:
```tsx
<div className="autocomplete-popup absolute bottom-full left-0 right-0 mb-2 max-h-[40vh] overflow-y-auto z-30 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-2xl">
  {/* rows */}
</div>
```

For mobile sheet behavior (<md), the popup is repositioned via media query. Use Tailwind `max-md:` variants on the same element:
```tsx
<div className="autocomplete-popup absolute bottom-full left-0 right-0 mb-2 max-h-[40vh] overflow-y-auto z-30 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-2xl max-md:fixed max-md:left-0 max-md:right-0 max-md:bottom-0 max-md:max-h-[50vh] max-md:rounded-t-2xl max-md:rounded-b-none max-md:mb-0" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
```

- [ ] **Step 3: Replace each row class**

Each `.autocomplete-row` becomes:
```tsx
<button
  type="button"
  className={[
    'autocomplete-row flex gap-2 items-center w-full min-h-[44px] md:min-h-[44px] max-md:min-h-[56px] px-3 py-2 bg-transparent text-[var(--color-text)] border-0 border-b border-[var(--color-border)] last:border-b-0 text-left text-sm cursor-pointer hover:bg-[var(--color-surface-2)]',
    active ? 'bg-[var(--color-surface-2)]' : '',
  ].join(' ')}
  /* existing handlers */
>
  {/* row content unchanged */}
</button>
```

Keep the legacy `autocomplete-row`, `autocomplete-row-primary`, `autocomplete-row-head`, `autocomplete-row-title`, `autocomplete-row-insert`, `autocomplete-row-path`, `autocomplete-row-source`, `autocomplete-row-desc`, `autocomplete-row-time`, `autocomplete-truncated`, `at-tag-autocomplete` class names alongside the utility classes — existing tests select on them.

For the title/path/insert spans inside a row, use:
```tsx
<span className="autocomplete-row-title flex-1 min-w-0 truncate text-[var(--color-accent)]">{title}</span>
<span className="autocomplete-row-insert text-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)] border border-[color-mix(in_srgb,var(--color-accent)_25%,transparent)] rounded-full px-1.5 py-0 text-[10px] max-w-[45%] truncate">{insert}</span>
<span className="autocomplete-row-path text-[var(--color-text-dim)] text-[11px] truncate">{path}</span>
<span className="autocomplete-row-time text-[var(--color-text-dim)] text-[10px] ml-auto">{time}</span>
```

- [ ] **Step 4: Run autocomplete tests + typecheck**

```bash
npm run test --workspace=apps/web -- features/chat/SlashAutocomplete features/chat/AtTagAutocomplete
npm run web:typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/chat/SlashAutocomplete.tsx apps/web/src/features/chat/AtTagAutocomplete.tsx
git commit -m "refactor(web): restyle slash + @-tag autocompletes with tailwind"
```

---

### Task 23: Restyle PromptHistoryDropdown + image-attach

**Files:**
- Modify: `apps/web/src/features/prompt-history/PromptHistoryDropdown.tsx`
- Delete: `apps/web/src/features/prompt-history/PromptHistoryDropdown.css`
- Modify: `apps/web/src/features/image-attach/*.tsx`
- Delete: `apps/web/src/features/image-attach/ImageAttach.css`

- [ ] **Step 1: Restyle PromptHistoryDropdown**

In `PromptHistoryDropdown.tsx`, replace the popup wrapper class with:
```tsx
<div className="prompt-history-dropdown absolute bottom-full left-0 right-0 mb-2 max-h-[40vh] overflow-y-auto z-30 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-2xl">
  {/* rows */}
</div>
```
And each row:
```tsx
<button
  type="button"
  className="w-full text-left px-3 py-2 min-h-[44px] hover:bg-[var(--color-surface-2)] text-sm text-[var(--color-text)] border-b border-[var(--color-border)] last:border-b-0"
  /* handlers */
>
  {/* content */}
</button>
```
Remove the import of `./PromptHistoryDropdown.css`.

- [ ] **Step 2: Delete PromptHistoryDropdown.css**

```bash
git rm apps/web/src/features/prompt-history/PromptHistoryDropdown.css
```

- [ ] **Step 3: Restyle image-attach components**

For `ImageThumbnails.tsx` (or whatever filename hosts the thumbnail strip), replace classes:
- Strip wrapper: `flex flex-wrap gap-2 mb-2`
- Each thumbnail: `relative w-16 h-16 rounded overflow-hidden bg-[var(--color-surface-2)] border border-[var(--color-border)]`
- Remove button: `absolute top-0.5 right-0.5 w-5 h-5 flex items-center justify-center text-white bg-black/60 rounded-full text-xs`

For drop overlay (rendered inside `Chat.tsx` already with the classes shown in Task 19), nothing further to do.

For error message: `text-xs text-[var(--color-danger)] mb-1`.

Remove `import './ImageAttach.css';` from each file.

- [ ] **Step 4: Delete ImageAttach.css**

```bash
git rm apps/web/src/features/image-attach/ImageAttach.css
```

- [ ] **Step 5: Run tests + typecheck**

```bash
npm run test --workspace=apps/web
npm run web:typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/prompt-history apps/web/src/features/image-attach
git commit -m "refactor(web): restyle prompt-history + image-attach"
```

---

### Task 24: Session page restructure (drop mobile-nav-drawer, use BottomSheet)

**Files:**
- Modify: `apps/web/src/pages/Session.tsx`
- Modify: `apps/web/src/pages/Session.mobile-shell.test.tsx`

- [ ] **Step 1: Read existing Session.tsx**

Note the `mobileNavOpen`, `mobileNavTab`, `mobileNavDrawerRef`, `mobileNavCloseButtonRef`, `mobileNavReturnFocusRef`, `closeMobileNav`, `openMobileNav`, `handleMobileNavKeyDown` block (lines ~40–146 of current file). The new implementation deletes all of this and uses `BottomSheet` instead.

- [ ] **Step 2: Replace `Session.tsx` with restructured version**

Full new content:
```tsx
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { useSessionsStore } from '../store/sessions';
import { useConnectionStore } from '../store/connection';
import { useFileExplorerStore } from '../store/file-explorer';
import type { AppShellOutletContext } from '../shell/AppShell';
import { Chat } from '../features/chat/Chat';
import { useNewSession } from '../features/project-picker/useNewSession';
import { streamTranscript } from '../services/transcript-fetcher';
import { FileExplorer } from '../features/file-explorer/FileExplorer';
import { SessionList } from '../features/session-list/SessionList';
import { HistoryPanel } from '../features/history/HistoryPanel';
import { BottomSheet } from '../shell/BottomSheet';

type MobileNavTab = 'sessions' | 'history';

export function Session(): JSX.Element {
  const { client } = useOutletContext<AppShellOutletContext>();
  const { id } = useParams();
  const navigate = useNavigate();
  const order = useSessionsStore((s) => s.order);
  const sessionsMap = useSessionsStore((s) => s.sessions);
  const setActive = useSessionsStore((s) => s.setActive);
  const apply = useSessionsStore((s) => s.applyServerMsg);
  const transcriptOnly = useSessionsStore((s) => (id ? Boolean(s.transcriptOnly[id]) : false));
  const session = id ? sessionsMap[id] : undefined;
  const newSession = useNewSession(client);
  const resetExplorer = useFileExplorerStore((s) => s.reset);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileNavTab, setMobileNavTab] = useState<MobileNavTab>('sessions');
  const mobileNavReturnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (id) setActive(id);
  }, [id, setActive]);

  useEffect(() => {
    document.title = session?.name
      ? `${session.name} — mac-remote-terminal`
      : 'mac-remote-terminal';
    return () => {
      document.title = 'mac-remote-terminal';
    };
  }, [session?.name]);

  useEffect(() => {
    resetExplorer();
    setDrawerOpen(false);
  }, [id, resetExplorer]);

  const connStatus = useConnectionStore((s) => s.status);
  const lastError = useConnectionStore((s) => s.lastError);
  const askedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id || connStatus !== 'open' || transcriptOnly) {
      askedRef.current = null;
      return;
    }
    if (askedRef.current === id) return;
    askedRef.current = id;
    const snapshot = useSessionsStore.getState().sessions[id];
    const since = snapshot?.lastSeq ?? 0;
    client.send({ type: 'get_history', sessionId: id, since });
  }, [client, id, connStatus, transcriptOnly]);

  const fallbackStartedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !transcriptOnly || fallbackStartedRef.current === id) return;
    fallbackStartedRef.current = id;
    let cancelled = false;
    (async () => {
      try {
        for await (const ev of streamTranscript(id)) {
          if (cancelled) return;
          apply(ev);
        }
      } catch (err) {
        console.warn('[transcript fallback]', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, transcriptOnly, apply]);

  const sessions = order
    .map((sid) => sessionsMap[sid]!)
    .filter((s): s is NonNullable<typeof s> => s !== undefined);

  const closeMobileNav = (): void => {
    setMobileNavOpen(false);
    const returnTarget = mobileNavReturnFocusRef.current;
    if (returnTarget && document.contains(returnTarget)) returnTarget.focus();
  };
  const openMobileNav = (opener?: HTMLElement): void => {
    mobileNavReturnFocusRef.current = opener ?? null;
    setMobileNavTab('sessions');
    setMobileNavOpen(true);
  };

  if (!session && !transcriptOnly) {
    return (
      <main className="flex-1 flex items-center justify-center p-4 text-[var(--color-text-dim)]">
        <div className="flex flex-col gap-3 items-center">
          <p>Session not found.</p>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="px-4 py-2 min-h-[44px] bg-[var(--color-accent)] text-white rounded-lg"
          >
            Home
          </button>
        </div>
      </main>
    );
  }

  return (
    <>
      {session && (
        <Chat
          session={session}
          onSend={
            transcriptOnly
              ? () => {}
              : (text, images) =>
                  client.send({
                    type: 'input',
                    sessionId: session.sessionId,
                    text,
                    ...(images && images.length > 0
                      ? { images: images.slice(), correlationId: newCorrelationId() }
                      : {}),
                  })
          }
          onStop={
            transcriptOnly
              ? () => {}
              : () => client.send({ type: 'stop_session', sessionId: session.sessionId })
          }
          onToggleDrawer={() => setDrawerOpen((o) => !o)}
          drawerOpen={drawerOpen}
          onOpenMobileNav={openMobileNav}
          banner={transcriptOnly ? 'transcript-only view (session no longer live)' : null}
          errorBanner={lastError}
          inputDisabled={transcriptOnly}
        />
      )}

      <BottomSheet
        open={mobileNavOpen}
        onClose={closeMobileNav}
        ariaLabel="Sessions and history"
      >
        <div className="flex border-b border-[var(--color-border)]">
          <button
            type="button"
            onClick={() => setMobileNavTab('sessions')}
            className={[
              'flex-1 min-h-[44px] py-2 text-sm transition-colors',
              mobileNavTab === 'sessions'
                ? 'text-[var(--color-accent)] border-b-2 border-[var(--color-accent)]'
                : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]',
            ].join(' ')}
          >
            Sessions
          </button>
          <button
            type="button"
            onClick={() => setMobileNavTab('history')}
            className={[
              'flex-1 min-h-[44px] py-2 text-sm transition-colors',
              mobileNavTab === 'history'
                ? 'text-[var(--color-accent)] border-b-2 border-[var(--color-accent)]'
                : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]',
            ].join(' ')}
          >
            History
          </button>
        </div>
        <div className="p-2">
          {mobileNavTab === 'sessions' ? (
            <SessionList
              sessions={sessions}
              activeId={id ?? null}
              onSelect={(nid) => {
                navigate(`/session/${nid}`);
                closeMobileNav();
              }}
              onNewSession={newSession.open}
            />
          ) : (
            <HistoryPanel />
          )}
        </div>
      </BottomSheet>

      {!session && transcriptOnly && (
        <main className="flex-1 flex items-center justify-center text-[var(--color-text-dim)]">
          Loading transcript…
        </main>
      )}
      {drawerOpen && session && (
        <FileExplorer
          client={client}
          rootPath={session.projectPath}
          onClose={() => setDrawerOpen(false)}
        />
      )}
      {newSession.pickerNode}
    </>
  );
}

function newCorrelationId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 3: Rewrite `Session.mobile-shell.test.tsx`**

Replace its content with a test that exercises the new BottomSheet flow. Read the current file first to understand its existing harness; then replace the body of the failing test(s) so they:
1. Render `<Session />` inside a `MemoryRouter` + outlet wrapper that injects `client`.
2. Verify the chat header `Open sessions and history` button is present.
3. Click it; assert the BottomSheet's `role="dialog"` with `aria-label="Sessions and history"` appears.
4. Click the History tab; assert the History panel renders.
5. Click the backdrop; assert the dialog disappears.

Skeleton:
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { Session } from './Session';
import { useSessionsStore } from '../store/sessions';

function ContextWrapper(): JSX.Element {
  const fakeClient = { send: () => {}, on: () => () => {}, connect: () => {}, close: () => {} };
  return <Outlet context={{ client: fakeClient }} />;
}

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ContextWrapper />}>
          <Route path="/session/:id" element={<Session />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Session mobile shell (BottomSheet)', () => {
  it('opens the sessions sheet when Menu pressed', async () => {
    useSessionsStore.setState({
      sessions: {
        s1: {
          sessionId: 's1',
          alive: true,
          projectPath: '/p',
          agent: 'claude',
          events: [],
          lastSeq: 0,
        } as never,
      },
      order: ['s1'],
      transcriptOnly: {},
    });
    renderAt('/session/s1');
    const menuBtn = screen.getByRole('button', { name: /open sessions and history/i });
    fireEvent.click(menuBtn);
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /sessions and history/i })).toBeInTheDocument();
    });
  });
});
```

(Adapt the `useSessionsStore` setup to whatever the actual `SessionView` shape is — the existing test file has the right shape; copy from there.)

- [ ] **Step 4: Run tests + typecheck**

```bash
npm run test --workspace=apps/web -- pages/Session
npm run web:typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Session.tsx apps/web/src/pages/Session.mobile-shell.test.tsx
git commit -m "refactor(web): Session uses BottomSheet for mobile sessions+history"
```

---

### Task 25: Restyle FileExplorer (mobile sheet / desktop right pane)

**Files:**
- Modify: `apps/web/src/features/file-explorer/FileExplorer.tsx`
- Modify: `apps/web/src/features/file-explorer/FilePreview.tsx`
- Delete: `apps/web/src/features/file-explorer/FileExplorer.css`

- [ ] **Step 1: Read existing FileExplorer to map current markup**

```bash
sed -n '1,80p' apps/web/src/features/file-explorer/FileExplorer.tsx
```

- [ ] **Step 2: Wrap FileExplorer body in responsive container**

Restructure the outermost JSX so:
- On `< md`: the explorer renders inside a `<BottomSheet open onClose={onClose} ariaLabel="File Explorer" maxHeight="85dvh">` so it slides up from the bottom and traps focus.
- On `≥ md`: it renders as a fixed right-side pane sliding in from the right.

Use a small `useMediaQuery('(min-width: 768px)')` helper inside the component:
```tsx
import { useEffect, useState } from 'react';

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)');
    const onChange = (e: MediaQueryListEvent): void => setIsDesktop(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isDesktop;
}
```

Then in the FileExplorer return:
```tsx
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { BottomSheet } from '../../shell/BottomSheet';

const isDesktop = useIsDesktop();
const reduce = useReducedMotion();
const body = (
  <div className="file-explorer-body bg-[var(--color-surface)] text-[var(--color-text)] h-full flex flex-col">
    {/* preserve existing header, breadcrumb, list, FilePreview render */}
  </div>
);

if (!isDesktop) {
  return (
    <BottomSheet open={true} onClose={onClose} ariaLabel="File Explorer" maxHeight="85dvh">
      {body}
    </BottomSheet>
  );
}

return (
  <AnimatePresence>
    <motion.aside
      key="file-explorer-pane"
      role="complementary"
      aria-label="File Explorer"
      className="hidden md:flex fixed top-0 right-0 h-[100dvh] w-[min(28rem,90vw)] bg-[var(--color-surface)] border-l border-[var(--color-border)] shadow-2xl z-40 flex-col"
      initial={reduce ? false : { x: '100%' }}
      animate={{ x: 0 }}
      exit={reduce ? { x: 0 } : { x: '100%' }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
    >
      {body}
    </motion.aside>
  </AnimatePresence>
);
```

(Inside `body`, restyle file rows: `min-h-[44px] flex items-center gap-2 px-3 py-1.5 text-sm font-mono hover:bg-[var(--color-surface-2)]`. Restyle breadcrumb: `text-xs text-[var(--color-text-dim)] px-3 py-2 border-b border-[var(--color-border)] truncate`. Restyle close button with lucide `X`.)

- [ ] **Step 3: Restyle FilePreview**

In `FilePreview.tsx`, replace any per-feature classes with utility classes. Wrapper: `flex-1 min-h-0 overflow-auto p-3 text-xs font-mono`. Code/pre block: `bg-black text-[var(--color-text)] p-2 rounded`.

- [ ] **Step 4: Delete `FileExplorer.css` and remove imports**

```bash
git rm apps/web/src/features/file-explorer/FileExplorer.css
```
Remove `import './FileExplorer.css';` from `FileExplorer.tsx` and `FilePreview.tsx`.

- [ ] **Step 5: Run tests + typecheck**

```bash
npm run test --workspace=apps/web -- file-explorer
npm run web:typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/file-explorer
git commit -m "refactor(web): FileExplorer mobile sheet + desktop pane"
```

---

### Task 26: Markdown styles to Tailwind base layer

**Files:**
- Modify: `apps/web/src/features/markdown/markdown.css`
- (Optional) Modify: `apps/web/src/features/markdown/MarkdownRenderer.tsx`

- [ ] **Step 1: Read existing markdown.css and MarkdownRenderer**

```bash
sed -n '1,200p' apps/web/src/features/markdown/markdown.css
```

- [ ] **Step 2: Replace markdown.css with theme-token version**

Keep the file but slim it. Replace contents with:
```css
@layer components {
  .markdown {
    color: var(--color-text);
    font-family: var(--font-sans);
    font-size: 15px;
    line-height: 1.55;
  }
  .markdown p { margin: 0 0 0.5em 0; }
  .markdown h1, .markdown h2, .markdown h3, .markdown h4 {
    color: var(--color-text);
    font-weight: 600;
    margin: 0.6em 0 0.3em 0;
  }
  .markdown h1 { font-size: 1.4em; }
  .markdown h2 { font-size: 1.2em; }
  .markdown h3 { font-size: 1.05em; }
  .markdown ul, .markdown ol { margin: 0.4em 0 0.4em 1.4em; }
  .markdown li { margin: 0.15em 0; }
  .markdown code {
    font-family: var(--font-mono);
    background: var(--color-surface-2);
    color: var(--color-text);
    padding: 0.1em 0.35em;
    border-radius: 4px;
    font-size: 0.92em;
  }
  .markdown pre {
    background: #000;
    color: #afa;
    padding: 0.6em 0.8em;
    border-radius: 6px;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 0.85em;
  }
  .markdown pre code {
    background: transparent;
    color: inherit;
    padding: 0;
    border-radius: 0;
    font-size: 1em;
  }
  .markdown a { color: var(--color-accent); text-decoration: underline; }
  .markdown blockquote {
    border-left: 3px solid var(--color-border);
    padding: 0 0.8em;
    margin: 0.5em 0;
    color: var(--color-text-mute);
  }
  .markdown table { border-collapse: collapse; }
  .markdown th, .markdown td { border: 1px solid var(--color-border); padding: 0.3em 0.5em; }
  .markdown hr { border: 0; border-top: 1px solid var(--color-border); margin: 0.8em 0; }
}
```

(Keep `shiki` / `mermaid` / `katex` integration as-is. They inject their own styles globally; the bubbles inherit text/background color from variables now.)

- [ ] **Step 3: Confirm `MarkdownRenderer.tsx` still imports `markdown.css`**

If `MarkdownRenderer.tsx` (or wherever it lives) still imports `'./markdown.css'`, leave it. If not, ensure something imports the file (e.g. `apps/web/src/main.tsx` or the renderer module).

- [ ] **Step 4: Run tests + typecheck**

```bash
npm run test --workspace=apps/web -- markdown
npm run web:typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/markdown/markdown.css
git commit -m "refactor(web): markdown styles use theme tokens"
```

---

### Task 27: Cleanup — delete legacy CSS + update responsive-css.test.ts

**Files:**
- Delete: `apps/web/src/App.css`
- Modify or delete: `apps/web/src/responsive-css.test.ts`
- Verify: no remaining imports of deleted CSS files.

- [ ] **Step 1: Confirm `App.css` is no longer imported**

```bash
grep -r "App.css" apps/web/src
```

Expected: no results (or only the file itself). If `main.tsx` or `App.tsx` still imports it, remove that import.

- [ ] **Step 2: Delete `App.css`**

```bash
git rm apps/web/src/App.css
```

- [ ] **Step 3: Audit for any remaining per-feature `.css` files**

```bash
find apps/web/src/features -name "*.css" -type f
```

Expected: only `apps/web/src/features/markdown/markdown.css` remains. If any other CSS file lingers (e.g. an overlooked one), check whether anything imports it; if not, delete it; if so, repeat the per-feature restyle pattern from earlier tasks.

- [ ] **Step 4: Replace or delete `responsive-css.test.ts`**

The current test asserts on plain CSS class breakpoints from now-deleted files. Delete it:
```bash
git rm apps/web/src/responsive-css.test.ts
```

(Manual visual verification covers responsive behavior in the next task.)

- [ ] **Step 5: Run all tests + typecheck + build**

```bash
npm run test --workspace=apps/web
npm run web:typecheck
npm run web:build
```

Expected: all pass; build artifact produced.

- [ ] **Step 6: Commit**

```bash
git add -A apps/web/src
git commit -m "chore(web): remove legacy CSS files + obsolete responsive test"
```

---

### Task 28: Final visual verification

**Files:** none — manual checklist.

- [ ] **Step 1: Start dev server**

```bash
npm run web:dev
```

- [ ] **Step 2: Walk through every page on three viewports**

For viewport widths 375px (mobile), 768px (tablet/desktop boundary), 1280px (desktop), open Chrome DevTools and verify each route renders correctly:

| Route | Mobile checks | Desktop checks |
|---|---|---|
| `/` | bottom nav visible, big New Session button, history list | left rail visible, content centered max-w-screen-md |
| `/sessions` | bottom nav, alive sessions or empty state | left rail, list |
| `/projects` | bottom nav, list with up/down/trash buttons all reachable (≥44px) | left rail, list |
| `/settings` | sections stack vertically, theme radios full-width | sections stack, max-w-screen-md |
| `/session/:id` | NavRail HIDDEN, full-screen chat, Menu opens BottomSheet | NavRail visible, chat fills, FileExplorer slides in from right when toggled |

- [ ] **Step 3: Toggle theme**

In `/settings`, click each of System / Light / Dark. Verify `<html data-theme="...">` updates and colors switch immediately. Refresh the page; chosen theme persists.

- [ ] **Step 4: Reduced motion**

In Chrome DevTools → Rendering panel → Emulate CSS media feature → `prefers-reduced-motion: reduce`. Navigate between routes and toggle modals/sheets. Verify no animations play.

- [ ] **Step 5: Tap target audit**

In DevTools, hover-inspect at 375px width. Confirm every interactive element (button, NavLink, list row) has a bounding box ≥44×44px.

- [ ] **Step 6: Focus trap**

Open ProjectPicker modal (`+ New Session` from Home). Press Tab repeatedly — focus stays inside modal. Press Escape — modal closes; focus returns to opener button.

Open mobile sessions sheet (Menu in chat header). Same trap + Escape behavior.

- [ ] **Step 7: Stop server, commit checklist evidence**

(No code commit here — this is a verification gate. If issues found, file follow-up tasks; do not break the visual sweep into the same commit as fixes.)

---

## Self-Review Notes

- **Spec coverage:** Every spec section maps to one or more tasks above. Settings page sections (Connection, Appearance, Default agent, Default workspaces, Profiles, Accounts) are covered by Tasks 15–18. All chat sub-features (autocompletes, prompt history, image-attach, resume prompt) are covered by Tasks 19–24. Mobile-shell drawer replacement is Task 24.
- **Type consistency:** `BridgeClient` is the single client type passed via `useOutletContext<AppShellOutletContext>()` in all pages. `BottomSheet` and `Modal` use identical prop signatures (`open`, `onClose`, `ariaLabel`, `children`).
- **Risks called out in plan:** Vite 5 vs `@tailwindcss/vite` (Task 1 includes a fallback bump). `motion` package import path uses `motion/react` (Tasks 5, 6, 7, 25 — consistent).
- **Each task ends with a commit.** No multi-task uncommitted state.

---

## Execution Notes

- Single feature branch recommended. Phasing is for commit hygiene; each task = 1 commit.
- After every commit, the app should build (`web:build`), typecheck (`web:typecheck`), and pass tests (`web:test`).
- If a restyle task breaks an existing test that asserted on legacy CSS class names rather than roles/text, update the test to assert on roles/accessible names or `data-testid`s — do not weaken behavioral coverage.
