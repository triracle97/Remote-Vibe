# Phase 4 — Markdown Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render assistant + user chat bubbles as full markdown — GFM, syntax-highlighted code (Shiki), inline + block math (KaTeX), and Mermaid diagrams. Streaming `stream_delta` spans get superseded by the consolidated `assistant` markdown bubble once the turn completes.

**Architecture:** Pure web change — bridge unchanged. New `apps/web/src/features/markdown/` directory hosts a `MarkdownRenderer` (react-markdown + plugins) plus `CodeBlock` (Shiki-driven syntax highlight + copy button) and `MermaidBlock` (mermaid SVG renderer). `apps/web/src/store/sessions.ts` gains a `superseded` flag walk that runs when an `assistant` event with text payload arrives. `MessageBubble` early-returns null on superseded events and renders MarkdownRenderer for assistant + user bubbles.

**Tech Stack:** React 18, Vite 5, react-markdown 9, remark-gfm 4, remark-math 6, rehype-katex 7, shiki 1.x, mermaid 11.x, katex 0.16. Eager bundle (no code-splitting per operator's explicit choice — bundle grows ~595 KB gzip on top of Phase 3's ~190 KB).

**Spec:** `docs/superpowers/specs/2026-05-07-phase-4-markdown-rendering-design.md`

**Out of scope (per spec §2):** code-splitting, service-worker pre-cache, markdown in tool-use/tool-result/file-explorer-preview, custom code themes per language.

---

## File Structure

### Web — new files

```
apps/web/src/features/markdown/
├── MarkdownRenderer.tsx          # react-markdown wrapper with plugin pipeline
├── MarkdownRenderer.test.tsx
├── CodeBlock.tsx                 # custom <code> renderer; Shiki + copy button
├── CodeBlock.test.tsx
├── MermaidBlock.tsx              # mermaid SVG renderer with parse-error fallback
├── MermaidBlock.test.tsx
├── shiki-loader.ts               # singleton highlighter
├── shiki-loader.test.ts
├── mermaid-loader.ts             # one-time mermaid.initialize + renderMermaid
├── mermaid-loader.test.ts
└── markdown.css                  # styles for headings/lists/tables/blockquote/code/mermaid
```

### Web — modified files

| File | Change |
|---|---|
| `apps/web/src/main.tsx` | Eager imports of `katex/dist/katex.min.css` and `./features/markdown/markdown.css`. After `createRoot(...).render(...)`, fire-and-forget `void import('./features/markdown/shiki-loader').then((m) => m.getHighlighter())` to warm the Shiki cache without blocking first paint. |
| `apps/web/package.json` | Add deps: `react-markdown` `^9`, `remark-gfm` `^4`, `remark-math` `^6`, `rehype-katex` `^7`, `shiki` `^1.22`, `mermaid` `^11`, `katex` `^0.16`. |
| `apps/web/src/store/sessions.ts` | `SessionEvent` augmented with optional `superseded?: true`. New private helper `applySupersessionWalk(events)` re-derives flags from event order in one pass — for each `assistant` with non-empty text payload, walks backwards flagging stream_delta events until the first non-`stream_delta` boundary. Idempotent + order-only so reload-replay reaches the same flag set as live. Invoked in BOTH the live `assistant` append path AND the `history` bulk-merge path. |
| `apps/web/src/store/sessions.test.ts` | 4 new test cases for the supersession walk (including reload-replay parity). |
| `apps/web/src/features/chat/MessageBubble.test.tsx` | New file — TDD additions per spec §8: assistant text + user bubbles render `<MarkdownRenderer />` (mocked), tool-use/tool-result/result/system branches unchanged, `superseded === true` returns `null`. |
| `apps/web/src/features/chat/MessageBubble.tsx` | Top-of-function: `if ((event as { superseded?: boolean }).superseded) return null;`. `event.type === 'assistant'` text branch wraps in `<MarkdownRenderer source={text} />` instead of plain text. `event.type === 'user'` likewise. Other branches unchanged. |

### Bridge

No changes.

---

## Task 1: Install deps + boot wiring

**Files:**
- Modify: `apps/web/package.json` (deps)
- Modify: `apps/web/src/main.tsx` (CSS imports + Shiki warm-up)

This task is pure scaffolding — no TDD. Verifies the deps install, the build still succeeds, and existing tests pass.

- [ ] **Step 1: Install the seven new deps**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal/apps/web
npm install react-markdown@^9 remark-gfm@^4 remark-math@^6 rehype-katex@^7 shiki@^1.22 mermaid@^11 katex@^0.16
```

Expected: deps added to `package.json`. Lockfile updated.

- [ ] **Step 2: Update `apps/web/src/main.tsx`**

Replace the contents with:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './App.css';
import 'katex/dist/katex.min.css';
import './features/markdown/markdown.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

// Warm Shiki after first paint so the first markdown bubble doesn't pay the
// async-load cost. Fire-and-forget; failures fall through to the per-CodeBlock
// fallback (plain <pre>).
void import('./features/markdown/shiki-loader').then((m) => m.getHighlighter()).catch((err) => {
  console.warn('[shiki-warmup]', err);
});
```

Note: `markdown.css` and the `features/markdown/shiki-loader` module do not exist yet — they're created in Tasks 2 and 7. Vite + TS will report errors until those files land. We work around this by creating placeholder stubs in Step 3 below so the build stays green between tasks.

- [ ] **Step 3: Create stub files so the import resolves**

Create `apps/web/src/features/markdown/shiki-loader.ts` (real impl in Task 2):

```ts
// Stub — real implementation lands in Task 2.
export async function getHighlighter(): Promise<unknown> {
  return null;
}
```

Create `apps/web/src/features/markdown/markdown.css` (real styles in Task 7):

```css
/* Stub — real styles land in Task 7. */
```

- [ ] **Step 4: Verify the build still succeeds**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run web:build 2>&1 | tail -10
```

Expected: build succeeds. Bundle larger than Phase 3 (KaTeX CSS alone is ~25 KB), but the additions are inert until later tasks wire them in.

- [ ] **Step 5: Verify existing tests still pass**

```bash
npm run web:test 2>&1 | tail -5
```

Expected: all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/src/main.tsx apps/web/src/features/markdown/shiki-loader.ts apps/web/src/features/markdown/markdown.css apps/web/package-lock.json ../package-lock.json
git commit -m "chore(web): install markdown rendering deps + boot CSS imports"
```

(`../package-lock.json` is the root workspaces lockfile.)

---

## Task 2: `shiki-loader.ts` — singleton highlighter

**Files:**
- Replace: `apps/web/src/features/markdown/shiki-loader.ts` (real impl)
- Create: `apps/web/src/features/markdown/shiki-loader.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/markdown/shiki-loader.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getHighlighter, CURATED_LANGUAGES } from './shiki-loader';

describe('shiki-loader', () => {
  it('returns the same promise on repeated calls', () => {
    const a = getHighlighter();
    const b = getHighlighter();
    expect(a).toBe(b);
  });

  it('CURATED_LANGUAGES contains the expected set', () => {
    expect(CURATED_LANGUAGES).toContain('ts');
    expect(CURATED_LANGUAGES).toContain('python');
    expect(CURATED_LANGUAGES).toContain('json');
    expect(CURATED_LANGUAGES).toContain('diff');
    expect(CURATED_LANGUAGES.length).toBeGreaterThanOrEqual(15);
  });

  it('highlights ts code with the github-dark theme (HTML contains color spans)', async () => {
    const h = await getHighlighter();
    const html = h.codeToHtml('const x: number = 1;', { lang: 'ts', theme: 'github-dark' });
    expect(html).toContain('<pre');
    expect(html).toMatch(/<span style="color:#[0-9a-fA-F]{3,8}/);
  });

  it('hostile fence content does not produce executable HTML elements', async () => {
    const h = await getHighlighter();
    const hostile = '</span><img src=x onerror=alert(1)>';
    const html = h.codeToHtml(hostile, { lang: 'ts', theme: 'github-dark' });
    const dom = new DOMParser().parseFromString(`<!doctype html><div>${html}</div>`, 'text/html');
    expect(dom.querySelectorAll('img').length).toBe(0);
    expect(dom.querySelectorAll('script').length).toBe(0);
    // Source `<` and `>` survive as text-content escapes:
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run web:test -- shiki-loader
```

Expected: FAIL — `getHighlighter` exists (stub) but returns null, no `CURATED_LANGUAGES` export, no `codeToHtml` method.

- [ ] **Step 3: Replace `apps/web/src/features/markdown/shiki-loader.ts`**

```ts
import { createHighlighter, type Highlighter } from 'shiki';

export const CURATED_LANGUAGES = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'bash',
  'sh',
  'zsh',
  'python',
  'rust',
  'go',
  'yaml',
  'toml',
  'dockerfile',
  'markdown',
  'html',
  'css',
  'sql',
  'diff',
] as const;

let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (highlighterPromise === null) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark'],
      langs: [...CURATED_LANGUAGES],
    });
  }
  return highlighterPromise;
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run web:test -- shiki-loader
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/markdown/shiki-loader.ts apps/web/src/features/markdown/shiki-loader.test.ts
git commit -m "feat(web): shiki singleton highlighter with curated language set"
```

---

## Task 3: `mermaid-loader.ts` — one-time init + renderMermaid

**Files:**
- Create: `apps/web/src/features/markdown/mermaid-loader.ts`
- Create: `apps/web/src/features/markdown/mermaid-loader.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/markdown/mermaid-loader.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock mermaid: the unit test does NOT exercise real Mermaid SVG generation
// (Mermaid 11 depends on browser SVG/font/DOMPurify behavior that happy-dom
// does not fully emulate, and would either flake or pull in heavy deps).
// Real-rendering verification belongs in the manual e2e smoke (Task 10).
vi.mock('mermaid', () => {
  const initialize = vi.fn();
  const render = vi.fn();
  return { default: { initialize, render } };
});

import mermaid from 'mermaid';
import { renderMermaid } from './mermaid-loader';

describe('renderMermaid', () => {
  beforeEach(() => {
    (mermaid.initialize as ReturnType<typeof vi.fn>).mockClear();
    (mermaid.render as ReturnType<typeof vi.fn>).mockClear();
  });

  it('initializes mermaid with strict security + dark theme exactly once across calls', async () => {
    (mermaid.render as ReturnType<typeof vi.fn>).mockResolvedValue({ svg: '<svg/>' });
    await renderMermaid('m1', 'graph TD; A-->B;');
    await renderMermaid('m2', 'graph TD; C-->D;');
    expect(mermaid.initialize).toHaveBeenCalledTimes(1);
    expect(mermaid.initialize).toHaveBeenCalledWith({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
    });
  });

  it('resolves to {svg} when mermaid.render succeeds', async () => {
    (mermaid.render as ReturnType<typeof vi.fn>).mockResolvedValue({
      svg: '<svg data-test="ok"/>',
    });
    const result = await renderMermaid('m3', 'graph TD; A-->B;');
    expect(result.svg).toBe('<svg data-test="ok"/>');
    expect(mermaid.render).toHaveBeenCalledWith('m3', 'graph TD; A-->B;');
  });

  it('rejects when mermaid.render rejects', async () => {
    (mermaid.render as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('parse failed'));
    await expect(renderMermaid('m4', 'bad source {{{')).rejects.toThrow('parse failed');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run web:test -- mermaid-loader
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/web/src/features/markdown/mermaid-loader.ts`**

```ts
import mermaid from 'mermaid';

let initialized = false;

function init(): void {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'strict',
  });
  initialized = true;
}

export async function renderMermaid(id: string, source: string): Promise<{ svg: string }> {
  init();
  const result = await mermaid.render(id, source);
  return { svg: result.svg };
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run web:test -- mermaid-loader
```

Expected: 3 passed. (Real Mermaid SVG generation is exercised in Task 10's manual smoke; happy-dom does not fully emulate Mermaid 11's SVG/DOMPurify path so unit tests mock the module instead.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/markdown/mermaid-loader.ts apps/web/src/features/markdown/mermaid-loader.test.ts
git commit -m "feat(web): mermaid loader with strict security + dark theme"
```

---

## Task 4: `MermaidBlock.tsx` — SVG renderer with parse-error fallback

**Files:**
- Create: `apps/web/src/features/markdown/MermaidBlock.tsx`
- Create: `apps/web/src/features/markdown/MermaidBlock.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/markdown/MermaidBlock.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MermaidBlock } from './MermaidBlock';

vi.mock('./mermaid-loader', () => ({
  renderMermaid: vi.fn(),
}));

import { renderMermaid } from './mermaid-loader';

describe('MermaidBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('injects the rendered SVG when render succeeds', async () => {
    (renderMermaid as ReturnType<typeof vi.fn>).mockResolvedValue({
      svg: '<svg data-test="ok"><g/></svg>',
    });
    const { container } = render(<MermaidBlock source="graph TD; A-->B;" />);
    await waitFor(() => {
      expect(container.querySelector('svg[data-test="ok"]')).toBeTruthy();
    });
  });

  it('renders fallback <pre> + error caption when render rejects', async () => {
    (renderMermaid as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('parse failed'));
    const { container, findByText } = render(<MermaidBlock source="bad source" />);
    await findByText(/Mermaid parse error: parse failed/);
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toBe('bad source');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run web:test -- MermaidBlock
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/web/src/features/markdown/MermaidBlock.tsx`**

```tsx
import { useEffect, useId, useRef, useState } from 'react';
import { renderMermaid } from './mermaid-loader';

interface MermaidBlockProps {
  source: string;
}

export function MermaidBlock({ source }: MermaidBlockProps): JSX.Element {
  const idBase = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const safeId = `mermaid-${idBase.replace(/[^a-zA-Z0-9-]/g, '')}`;
    renderMermaid(safeId, source)
      .then(({ svg }) => {
        if (cancelled) return;
        if (ref.current) ref.current.innerHTML = svg;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [idBase, source]);

  if (error !== null) {
    return (
      <div className="md-mermaid-error">
        <div className="md-mermaid-error-caption">Mermaid parse error: {error}</div>
        <pre>{source}</pre>
      </div>
    );
  }
  return <div className="md-mermaid" ref={ref} />;
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run web:test -- MermaidBlock
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/markdown/MermaidBlock.tsx apps/web/src/features/markdown/MermaidBlock.test.tsx
git commit -m "feat(web): MermaidBlock with parse-error fallback"
```

---

## Task 5: `CodeBlock.tsx` — inline / mermaid / shiki / copy-button dispatch

**Files:**
- Create: `apps/web/src/features/markdown/CodeBlock.tsx`
- Create: `apps/web/src/features/markdown/CodeBlock.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/markdown/CodeBlock.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { CodeBlock } from './CodeBlock';

vi.mock('./MermaidBlock', () => ({
  MermaidBlock: ({ source }: { source: string }) => (
    <div data-testid="mermaid-mock">{source}</div>
  ),
}));

vi.mock('./shiki-loader', () => ({
  getHighlighter: vi.fn(),
  CURATED_LANGUAGES: ['ts', 'js'],
}));

import { getHighlighter } from './shiki-loader';

describe('CodeBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  // react-markdown 9 does NOT pass an `inline` prop. The CodeBlock detects
  // inline vs block from props alone:
  //   - no className AND single-line text  → inline
  //   - has language-* className OR multi-line text → block
  // This matches react-markdown 9's actual `code` component prop shape.

  it('renders inline code (no className, single-line) as <code className="md-inline-code">', () => {
    const { container } = render(<CodeBlock>{'hello'}</CodeBlock>);
    const code = container.querySelector('code.md-inline-code');
    expect(code?.textContent).toBe('hello');
    expect(container.querySelector('.md-code-block')).toBeNull();
  });

  it('delegates language-mermaid to MermaidBlock', () => {
    const { getByTestId, container } = render(
      <CodeBlock className="language-mermaid">{'graph TD; A-->B;\n'}</CodeBlock>,
    );
    expect(getByTestId('mermaid-mock').textContent).toBe('graph TD; A-->B;');
    expect(container.querySelector('.md-inline-code')).toBeNull();
  });

  it('renders Shiki HTML for a curated language once highlighter resolves', async () => {
    (getHighlighter as ReturnType<typeof vi.fn>).mockResolvedValue({
      codeToHtml: (src: string, _opts: unknown) => `<pre data-test="shiki">${src}</pre>`,
    });
    const { container } = render(
      <CodeBlock className="language-ts">{'const x = 1;\n'}</CodeBlock>,
    );
    await waitFor(() => {
      expect(container.querySelector('pre[data-test="shiki"]')).toBeTruthy();
    });
    expect(getHighlighter).toHaveBeenCalled();
  });

  it('falls through to plain <pre> wrapper for non-curated language', () => {
    const { container } = render(
      <CodeBlock className="language-fortran">{'program hi\n'}</CodeBlock>,
    );
    expect(container.querySelector('.md-code-block pre code')?.textContent).toBe('program hi\n');
    expect(getHighlighter).not.toHaveBeenCalled();
  });

  it('renders block <pre> wrapper for fenced code WITHOUT a language (multi-line, no className)', () => {
    const { container } = render(<CodeBlock>{'line one\nline two\n'}</CodeBlock>);
    // multi-line + no className → block path, plain wrapper, no Shiki
    expect(container.querySelector('.md-code-block pre code')?.textContent).toBe(
      'line one\nline two\n',
    );
    expect(container.querySelector('.md-inline-code')).toBeNull();
    expect(getHighlighter).not.toHaveBeenCalled();
  });

  it('shows a dev-only "language X not highlighted" caption for non-curated lang in DEV', () => {
    // import.meta.env.DEV is true by default under Vitest (dev-mode module).
    const { container } = render(
      <CodeBlock className="language-fortran">{'program hi\n'}</CodeBlock>,
    );
    const caption = container.querySelector('.md-code-dev-caption');
    expect(caption?.textContent).toMatch(/language\s+`?fortran`?\s+not highlighted/);
  });

  it('copy button writes the original source to navigator.clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      <CodeBlock className="language-fortran">{'program hi\n'}</CodeBlock>,
    );
    const copy = container.querySelector('button.md-code-copy') as HTMLButtonElement;
    expect(copy).toBeTruthy();
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith('program hi\n');
  });

  it('hides copy button when navigator.clipboard is undefined', () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const { container } = render(
      <CodeBlock className="language-fortran">{'program hi\n'}</CodeBlock>,
    );
    expect(container.querySelector('button.md-code-copy')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run web:test -- CodeBlock
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/web/src/features/markdown/CodeBlock.tsx`**

```tsx
import { useEffect, useState, type ReactNode } from 'react';
import { getHighlighter, CURATED_LANGUAGES } from './shiki-loader';
import { MermaidBlock } from './MermaidBlock';

interface CodeBlockProps {
  className?: string;
  children?: ReactNode;
}

function extractLang(className?: string): string | null {
  if (!className) return null;
  const m = /\blanguage-([a-zA-Z0-9_+-]+)\b/.exec(className);
  return m ? m[1]! : null;
}

function nodeToString(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(nodeToString).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    const props = (children as { props?: { children?: ReactNode } }).props;
    if (props && 'children' in props) return nodeToString(props.children);
  }
  return '';
}

// react-markdown 9 removed the `inline` prop. Detect inline vs block from
// the props that ARE passed through:
//   - has a `language-*` className → fenced block (always)
//   - no className AND source has no internal newline → inline backtick
//   - no className AND source DOES have internal newlines → fenced block w/o language
function isInline(className: string | undefined, source: string): boolean {
  if (className && /\blanguage-/.test(className)) return false;
  return !source.includes('\n');
}

function CodeFenceWrapper({
  lang,
  source,
  body,
  devCaption,
}: {
  lang: string | null;
  source: string;
  body: ReactNode;
  devCaption?: string;
}): JSX.Element {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const canCopy =
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard !== 'undefined' &&
    typeof navigator.clipboard.writeText === 'function';

  const onCopy = (): void => {
    if (!canCopy) return;
    navigator.clipboard
      .writeText(source)
      .then(() => {
        setCopied('ok');
        setTimeout(() => setCopied('idle'), 1500);
      })
      .catch(() => {
        setCopied('fail');
        setTimeout(() => setCopied('idle'), 1500);
      });
  };

  return (
    <div className="md-code-block">
      {lang && <div className="md-code-lang">{lang}</div>}
      {canCopy && (
        <button
          type="button"
          className="md-code-copy"
          onClick={onCopy}
          aria-label="Copy code to clipboard"
        >
          {copied === 'idle' ? '📋' : copied === 'ok' ? '✓' : '✗'}
        </button>
      )}
      {body}
      {devCaption !== undefined && (
        <div className="md-code-dev-caption">{devCaption}</div>
      )}
    </div>
  );
}

export function CodeBlock({ className, children }: CodeBlockProps): JSX.Element {
  const source = nodeToString(children);

  if (isInline(className, source)) {
    return <code className="md-inline-code">{children}</code>;
  }

  const lang = extractLang(className);

  if (lang === 'mermaid') {
    return <MermaidBlock source={source.trim()} />;
  }

  const supported = lang !== null && (CURATED_LANGUAGES as readonly string[]).includes(lang);

  if (supported) {
    return <ShikiBlock lang={lang!} source={source} />;
  }

  // Non-curated language OR fenced code without a language — plain block wrapper.
  // Per spec §6: dev mode shows a small caption naming the unhighlighted lang.
  const devCaption =
    import.meta.env.DEV && lang !== null ? `language \`${lang}\` not highlighted` : undefined;

  return (
    <CodeFenceWrapper
      lang={lang}
      source={source}
      body={
        <pre>
          <code>{children}</code>
        </pre>
      }
      {...(devCaption !== undefined ? { devCaption } : {})}
    />
  );
}

function ShikiBlock({ lang, source }: { lang: string; source: string }): JSX.Element {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHighlighter().then((h) => {
      if (cancelled) return;
      try {
        setHtml(h.codeToHtml(source, { lang, theme: 'github-dark' }));
      } catch {
        setHtml(null); // fall through to fallback below
      }
    });
    return () => {
      cancelled = true;
    };
  }, [lang, source]);

  if (html !== null) {
    return (
      <CodeFenceWrapper
        lang={lang}
        source={source}
        body={<div dangerouslySetInnerHTML={{ __html: html }} />}
      />
    );
  }
  return (
    <CodeFenceWrapper
      lang={lang}
      source={source}
      body={
        <pre>
          <code>{source}</code>
        </pre>
      }
    />
  );
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run web:test -- CodeBlock
```

Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/markdown/CodeBlock.tsx apps/web/src/features/markdown/CodeBlock.test.tsx
git commit -m "feat(web): CodeBlock with Shiki + Mermaid + copy button"
```

---

## Task 6: `MarkdownRenderer.tsx` — react-markdown wrapper

**Files:**
- Create: `apps/web/src/features/markdown/MarkdownRenderer.tsx`
- Create: `apps/web/src/features/markdown/MarkdownRenderer.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/markdown/MarkdownRenderer.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MarkdownRenderer } from './MarkdownRenderer';

vi.mock('./CodeBlock', () => ({
  CodeBlock: (props: { className?: string; children?: React.ReactNode }) => (
    <div
      data-test="code-block"
      data-classname={props.className ?? ''}
    >
      {props.children}
    </div>
  ),
}));

describe('MarkdownRenderer', () => {
  it('renders bold + italic + heading + list + link', () => {
    const { container } = render(
      <MarkdownRenderer
        source={`# Title\n\n**bold** and *italic* and [a](https://example.com)\n\n- one\n- two`}
      />,
    );
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(container.querySelectorAll('ul li').length).toBe(2);
  });

  it('renders inline code via CodeBlock with no className', () => {
    const { container } = render(<MarkdownRenderer source={'use `foo` here'} />);
    const cb = container.querySelector('[data-test="code-block"]');
    // react-markdown 9: inline backticks pass through `code` with no className.
    expect(cb?.getAttribute('data-classname')).toBe('');
    expect(cb?.textContent).toBe('foo');
  });

  it('renders fenced code via CodeBlock with language className', () => {
    const { container } = render(
      <MarkdownRenderer source={'```ts\nconst x = 1;\n```'} />,
    );
    const cb = container.querySelector('[data-test="code-block"]');
    expect(cb?.getAttribute('data-classname')).toContain('language-ts');
  });

  it('renders block math as a .katex element', () => {
    const { container } = render(<MarkdownRenderer source={'$$x^2$$'} />);
    expect(container.querySelector('.katex')).toBeTruthy();
  });

  it('does NOT throw on malformed math (KaTeX throwOnError: false)', () => {
    // Spec §6: malformed math must render as a styled error, not crash.
    expect(() =>
      render(<MarkdownRenderer source={'$$\\frac$$'} />),
    ).not.toThrow();
  });

  it('renders GFM tables', () => {
    const { container } = render(
      <MarkdownRenderer source={'| a | b |\n|---|---|\n| 1 | 2 |'} />,
    );
    expect(container.querySelector('table thead th')?.textContent).toBe('a');
  });

  it('escapes raw <script> in source — no script element materializes', () => {
    const { container } = render(
      <MarkdownRenderer source={`Try <script>alert(1)</script> here`} />,
    );
    expect(container.querySelectorAll('script').length).toBe(0);
    expect(container.innerHTML).toContain('&lt;script&gt;');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run web:test -- MarkdownRenderer
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/web/src/features/markdown/MarkdownRenderer.tsx`**

```tsx
import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { CodeBlock } from './CodeBlock';

interface MarkdownRendererProps {
  source: string;
}

function MarkdownRendererImpl({ source }: MarkdownRendererProps): JSX.Element {
  return (
    <div className="md-rendered">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          // Spec §6: throwOnError: false renders malformed math as red literal
          // text instead of crashing the bubble. errorColor matches the spec.
          [rehypeKatex, { throwOnError: false, errorColor: '#cc0000' }],
        ]}
        components={{
          code: CodeBlock as never,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownRenderer = memo(
  MarkdownRendererImpl,
  (prev, next) => prev.source === next.source,
);
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run web:test -- MarkdownRenderer
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/markdown/MarkdownRenderer.tsx apps/web/src/features/markdown/MarkdownRenderer.test.tsx
git commit -m "feat(web): MarkdownRenderer wraps react-markdown plugin pipeline"
```

---

## Task 7: `markdown.css` — styles

**Files:**
- Modify: `apps/web/src/features/markdown/markdown.css` (replace stub)

No tests — pure CSS.

- [ ] **Step 1: Replace `apps/web/src/features/markdown/markdown.css`**

```css
.md-rendered { color: #ddd; line-height: 1.45; word-break: break-word; }
.md-rendered h1 { font-size: 1.4rem; margin: 0.5rem 0 0.4rem; border-bottom: 1px solid #2a2a2a; padding-bottom: 0.25rem; }
.md-rendered h2 { font-size: 1.2rem; margin: 0.5rem 0 0.4rem; }
.md-rendered h3 { font-size: 1.05rem; margin: 0.4rem 0 0.3rem; }
.md-rendered h4, .md-rendered h5, .md-rendered h6 { font-size: 0.95rem; margin: 0.4rem 0 0.3rem; color: #aaa; }
.md-rendered p { margin: 0.4rem 0; }
.md-rendered ul, .md-rendered ol { margin: 0.4rem 0; padding-left: 1.5rem; }
.md-rendered li { margin: 0.15rem 0; }
.md-rendered blockquote { border-left: 3px solid #444; padding: 0.1rem 0.6rem; margin: 0.4rem 0; color: #aaa; }
.md-rendered hr { border: 0; border-top: 1px solid #2a2a2a; margin: 0.6rem 0; }
.md-rendered a { color: #6fa8ff; text-decoration: none; }
.md-rendered a:hover { text-decoration: underline; }
.md-rendered table { border-collapse: collapse; margin: 0.4rem 0; }
.md-rendered th, .md-rendered td { border: 1px solid #2a2a2a; padding: 0.2rem 0.5rem; }
.md-rendered th { background: #1a1a1a; font-weight: 600; }

.md-inline-code {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 0.85em;
  background: #1a1a1a;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  border: 1px solid #2a2a2a;
}

.md-code-block {
  position: relative;
  background: #0d1117;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  overflow: hidden;
  margin: 0.5rem 0;
}
.md-code-block pre { margin: 0; padding: 0.7rem 0.8rem; overflow-x: auto; font-family: ui-monospace, Menlo, monospace; font-size: 0.82rem; }
.md-code-block pre code { background: transparent; padding: 0; border: 0; font-size: inherit; }
.md-code-lang {
  position: absolute; top: 0.2rem; left: 0.6rem;
  font-size: 0.65rem; color: #888; text-transform: lowercase; letter-spacing: 0.04em;
}
.md-code-copy {
  position: absolute; top: 0.2rem; right: 0.4rem;
  background: #1f1f1f; color: #ccc; border: 1px solid #2a2a2a;
  width: 22px; height: 22px; padding: 0;
  font-size: 0.75rem; cursor: pointer; border-radius: 3px;
}
.md-code-copy:hover { background: #2a2a2a; }

.md-mermaid { background: #0d1117; padding: 0.6rem; border: 1px solid #2a2a2a; border-radius: 6px; margin: 0.5rem 0; overflow-x: auto; }
.md-mermaid svg { max-width: 100%; height: auto; }
.md-mermaid-error { background: #2a1010; border: 1px solid #4a1a1a; border-radius: 6px; padding: 0.5rem; margin: 0.5rem 0; }
.md-mermaid-error-caption { color: #f88; font-size: 0.75rem; margin-bottom: 0.4rem; }
.md-mermaid-error pre { background: #1a0a0a; color: #ddd; margin: 0; padding: 0.4rem 0.6rem; font-size: 0.8rem; overflow-x: auto; }
```

- [ ] **Step 2: Verify build still succeeds**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run web:build 2>&1 | tail -5
```

Expected: build OK.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/markdown/markdown.css
git commit -m "feat(web): markdown styles for headings, lists, tables, code blocks, mermaid"
```

---

## Task 8: Streaming supersession in sessions store

**Files:**
- Modify: `apps/web/src/store/sessions.ts`
- Modify: `apps/web/src/store/sessions.test.ts`

- [ ] **Step 1: Append three new test cases to `apps/web/src/store/sessions.test.ts`**

Append inside the existing `describe('sessions store', ...)` block:

```ts
  it('flags preceding stream_deltas as superseded when assistant text arrives', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    store.applyServerMsg({
      type: 'stream_delta',
      sessionId: 's1',
      seq: 2,
      payload: { delta: 'hel' },
    });
    store.applyServerMsg({
      type: 'stream_delta',
      sessionId: 's1',
      seq: 3,
      payload: { delta: 'lo' },
    });
    store.applyServerMsg({
      type: 'assistant',
      sessionId: 's1',
      seq: 4,
      payload: { text: 'hello' },
    });
    const events = useSessionsStore.getState().sessions['s1']!.events;
    const deltas = events.filter((e) => e.type === 'stream_delta');
    expect(deltas).toHaveLength(2);
    expect(deltas.every((e) => (e as { superseded?: boolean }).superseded === true)).toBe(true);
    const assistant = events.find((e) => e.type === 'assistant');
    expect((assistant as { superseded?: boolean }).superseded).toBeUndefined();
  });

  it('does NOT supersede stream_deltas from a previous turn', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    // Turn 1: deltas + result
    store.applyServerMsg({
      type: 'stream_delta',
      sessionId: 's1',
      seq: 2,
      payload: { delta: 'hi' },
    });
    store.applyServerMsg({ type: 'result', sessionId: 's1', seq: 3, payload: {} });
    // Turn 2: deltas + assistant text
    store.applyServerMsg({
      type: 'stream_delta',
      sessionId: 's1',
      seq: 4,
      payload: { delta: 'world' },
    });
    store.applyServerMsg({
      type: 'assistant',
      sessionId: 's1',
      seq: 5,
      payload: { text: 'world' },
    });
    const events = useSessionsStore.getState().sessions['s1']!.events;
    const seq2 = events.find((e) => 'seq' in e && e.seq === 2)!;
    const seq4 = events.find((e) => 'seq' in e && e.seq === 4)!;
    expect((seq2 as { superseded?: boolean }).superseded).toBeUndefined(); // turn 1 delta NOT touched
    expect((seq4 as { superseded?: boolean }).superseded).toBe(true);
  });

  it('reload-replay (cold reload via history) reaches the same superseded set', () => {
    // Spec §5 + §8 test #3: replay the same events from a cold store and
    // verify the supersession walk re-derives identical superseded flags.
    const replay = [
      { type: 'system', event: 'session_created', sessionId: 's1', seq: 1 } as const,
      { type: 'stream_delta', sessionId: 's1', seq: 2, payload: { delta: 'hel' } } as const,
      { type: 'stream_delta', sessionId: 's1', seq: 3, payload: { delta: 'lo' } } as const,
      { type: 'assistant', sessionId: 's1', seq: 4, payload: { text: 'hello' } } as const,
    ];
    // Pass 1: live append path (event-by-event)
    const store1 = useSessionsStore.getState();
    for (const e of replay) store1.applyServerMsg(e);
    const liveDeltas = useSessionsStore
      .getState()
      .sessions['s1']!.events.filter((e) => e.type === 'stream_delta');
    const liveFlags = liveDeltas.map((e) => (e as { superseded?: boolean }).superseded === true);

    // Reset store to cold and re-load the same events via the history bulk-merge path.
    useSessionsStore.setState({ sessions: {}, order: [], activeId: null, transcriptOnly: {} });
    const store2 = useSessionsStore.getState();
    // Seed the session row first (history path requires existing summary).
    store2.applyServerMsg({
      type: 'session_list',
      sessions: [{ sessionId: 's1', agent: 'claude', projectPath: '/p', createdAt: 1 }],
    });
    store2.applyServerMsg({ type: 'history', sessionId: 's1', events: replay, hasMore: false });
    const replayDeltas = useSessionsStore
      .getState()
      .sessions['s1']!.events.filter((e) => e.type === 'stream_delta');
    const replayFlags = replayDeltas.map(
      (e) => (e as { superseded?: boolean }).superseded === true,
    );

    expect(replayFlags).toEqual(liveFlags);
    expect(replayFlags.every((f) => f === true)).toBe(true);
  });

  it('does NOT supersede on assistant events that have no text payload (e.g. tool_use)', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    store.applyServerMsg({
      type: 'stream_delta',
      sessionId: 's1',
      seq: 2,
      payload: { delta: 'hi' },
    });
    store.applyServerMsg({
      type: 'assistant',
      sessionId: 's1',
      seq: 3,
      payload: { toolUse: { kind: 'tool_use', toolUseId: 'tu1', toolName: 'Bash', input: {} } },
    });
    const events = useSessionsStore.getState().sessions['s1']!.events;
    const delta = events.find((e) => 'seq' in e && e.seq === 2)!;
    expect((delta as { superseded?: boolean }).superseded).toBeUndefined();
  });
```

- [ ] **Step 2: Run test — expect FAIL on the four new ones**

```bash
npm run web:test -- sessions
```

Expected: 4 new tests fail (no supersession behavior yet).

- [ ] **Step 3: Update `apps/web/src/store/sessions.ts`**

In the existing file, locate the `SessionEvent` type definition and augment it. The discriminated union members already include `ServerStreamMsg | ServerLifecycleMsg`. Add an optional `superseded?: true` to both interfaces in `apps/web/src/types/protocol.ts`? — No: the `superseded` flag is web-store-only and must NOT cross the wire (per spec §5). Instead, augment the `SessionEvent` type defined inside `sessions.ts` (or wherever `SessionView.events` is typed) with a local intersection.

Locate `SessionView.events` typing. Likely:

```ts
import type { ServerLifecycleMsg, ServerStreamMsg } from '../types/protocol';
type SessionEvent = ServerLifecycleMsg | ServerStreamMsg;
```

Replace with:

```ts
import type { ServerLifecycleMsg, ServerStreamMsg } from '../types/protocol';
export type SessionEvent = (ServerLifecycleMsg | ServerStreamMsg) & {
  /**
   * Web-store-only flag. Set on stream_delta events whose contents have been
   * superseded by a consolidated `assistant` event with text payload.
   * MessageBubble early-returns null for these. NEVER carried on the wire —
   * the store sets/clears it locally; replay re-derives it from order.
   */
  superseded?: true;
};
```

Add this private helper inside the store module (above the `useSessionsStore` factory):

```ts
function applySupersessionWalk(events: SessionEvent[]): SessionEvent[] {
  // Single SSOT for the supersession derivation. Order-only and idempotent:
  // for each `assistant` with a non-empty text payload, walk backwards until
  // any non-`stream_delta` boundary, flagging stream_delta events as
  // `superseded: true`. Already-flagged events are not re-allocated.
  // Used by BOTH the live `assistant` append path and the `history` bulk-merge
  // (replay) path so reload-replay reaches the same superseded set as live.
  let out: SessionEvent[] | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type !== 'assistant') continue;
    const text = (e.payload as { text?: unknown }).text;
    if (typeof text !== 'string' || text.length === 0) continue;
    for (let j = i - 1; j >= 0; j--) {
      const prev = (out ?? events)[j]!;
      if (prev.type !== 'stream_delta') break;
      if (prev.superseded) continue;
      if (out === null) out = events.slice();
      out[j] = { ...prev, superseded: true };
    }
  }
  return out ?? events;
}
```

#### 3a. Live `assistant` append path

Locate the `applyServerMsg` action's branch that handles `m.type === 'assistant'` (it appends to the session's events array). Augment the append step: after appending, replace the events array with `applySupersessionWalk(nextEvents)`. The walk is idempotent and cheap (O(n) per assistant; flagged events are skipped without re-allocation), so calling it on every relevant append is safe.

Find code shaped like:

```ts
if (m.type === 'assistant' || m.type === 'stream_delta' || ...) {
  const existing = get().sessions[m.sessionId];
  if (!existing) return;
  const next = { ...existing, events: [...existing.events, m as SessionEvent], lastSeq: m.seq };
  set((s) => ({ sessions: { ...s.sessions, [m.sessionId]: next } }));
  return;
}
```

Replace with:

```ts
if (m.type === 'assistant' || m.type === 'stream_delta' || m.type === 'tool_result' || m.type === 'result' || m.type === 'status' || m.type === 'user') {
  const existing = get().sessions[m.sessionId];
  if (!existing) return;
  let nextEvents: SessionEvent[] = [...existing.events, m as SessionEvent];
  // Only the `assistant` append can introduce a new supersession boundary —
  // skip the walk on every other event type for performance.
  if (m.type === 'assistant') {
    nextEvents = applySupersessionWalk(nextEvents);
  }
  const next = { ...existing, events: nextEvents, lastSeq: m.seq };
  set((s) => ({ sessions: { ...s.sessions, [m.sessionId]: next } }));
  return;
}
```

(If the existing branching is structured differently — e.g. multiple `if` arms per type — apply the supersession step inside the `assistant` arm only.)

#### 3b. History bulk-merge path (reload-replay parity)

The `if (m.type === 'history')` branch in `apps/web/src/store/sessions.ts` (around line 117) merges replayed events by `seq` and writes a new state. After computing the merged array but BEFORE writing state, run the same supersession walk:

```ts
if (m.type === 'history') {
  const existing = get().sessions[m.sessionId];
  if (!existing) return;
  if (m.events.length === 0) return;
  const knownSeqs = new Set<number>();
  for (const e of existing.events) {
    const seq = (e as { seq?: number }).seq;
    if (typeof seq === 'number') knownSeqs.add(seq);
  }
  const novel = m.events.filter((e) => !knownSeqs.has(e.seq));
  if (novel.length === 0) return;

  const bySeq = new Map<number, SessionEvent>();
  for (const e of existing.events) {
    const seq = (e as { seq?: number }).seq;
    if (typeof seq === 'number') bySeq.set(seq, e);
  }
  for (const e of novel) bySeq.set(e.seq, e);
  const merged = [...bySeq.values()].sort(
    (a, b) => (a as { seq: number }).seq - (b as { seq: number }).seq,
  );
  // Re-derive supersession flags on the merged array. The walk is purely
  // additive and order-only — replay reaches the same flag set as live.
  const mergedWithFlags = applySupersessionWalk(merged);
  const lastSeq =
    mergedWithFlags.length > 0
      ? (mergedWithFlags[mergedWithFlags.length - 1] as { seq: number }).seq
      : existing.lastSeq;
  const next: SessionView = { ...existing, events: mergedWithFlags, lastSeq };
  set((s) => ({ sessions: { ...s.sessions, [m.sessionId]: next } }));
  return;
}
```

(Edit only the two new lines: the `applySupersessionWalk(merged)` call and the rename of the `merged` reference inside the `lastSeq` computation + `next` object. Existing dedup + sort logic is unchanged.)

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run web:test -- sessions
```

Expected: existing tests + 4 new tests all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/store/sessions.ts apps/web/src/store/sessions.test.ts
git commit -m "feat(web): supersede stream_delta events when assistant text arrives"
```

---

## Task 9: Wire MarkdownRenderer + supersession early-return into MessageBubble (TDD)

**Files:**
- Create: `apps/web/src/features/chat/MessageBubble.test.tsx`
- Modify: `apps/web/src/features/chat/MessageBubble.tsx`

This task is TDD — write failing tests first, then make them pass.

The existing file branches on `event.type` to render bubbles. Phase 4 changes:
1. Top-of-function early return: if the event has `superseded === true`, return `null`.
2. `assistant` text branch wraps in `<MarkdownRenderer source={text} />`.
3. `user` branch wraps in `<MarkdownRenderer source={text ?? ''} />`.
4. `stream_delta`, tool_use (assistant payload variant), tool_result, result, system branches unchanged.

- [ ] **Step 1: Read the existing file for line-accurate context**

```bash
cat /Volumes/WDSSD/Code/mac-remote-terminal/apps/web/src/features/chat/MessageBubble.tsx
```

Expected shape (Phase 3 state): plain function `MessageBubble({ event })` with a series of `if (event.type === '...')` branches. Inline payload casts.

- [ ] **Step 2: Write `apps/web/src/features/chat/MessageBubble.test.tsx` (failing tests)**

Per spec §8: assertions cover assistant + user → MarkdownRenderer, unchanged non-markdown branches (tool_use, tool_result, result, system), and the `superseded` early-return.

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MessageBubble } from './MessageBubble';
import type { SessionEvent } from '../../store/sessions';

vi.mock('../markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ source }: { source: string }) => (
    <div data-test="md-renderer">{source}</div>
  ),
}));

function ev(partial: Partial<SessionEvent> & { type: SessionEvent['type'] }): SessionEvent {
  return partial as SessionEvent;
}

describe('MessageBubble', () => {
  it('renders assistant text via MarkdownRenderer', () => {
    const { container } = render(
      <MessageBubble
        event={ev({
          type: 'assistant',
          sessionId: 's1',
          seq: 5,
          payload: { text: '**bold**' },
        })}
      />,
    );
    const md = container.querySelector('[data-test="md-renderer"]');
    expect(md).toBeTruthy();
    expect(md?.textContent).toBe('**bold**');
    expect(container.querySelector('.bubble.assistant')).toBeTruthy();
  });

  it('renders user text via MarkdownRenderer', () => {
    const { container } = render(
      <MessageBubble
        event={ev({
          type: 'user',
          sessionId: 's1',
          seq: 6,
          payload: { text: 'hello `world`' },
        })}
      />,
    );
    const md = container.querySelector('[data-test="md-renderer"]');
    expect(md?.textContent).toBe('hello `world`');
    expect(container.querySelector('.bubble.user')).toBeTruthy();
  });

  it('returns null for events flagged superseded', () => {
    // Task 8 augments `SessionEvent` with `superseded?: true`, so this is a
    // first-class typed field — no @ts-expect-error needed.
    const { container } = render(
      <MessageBubble
        event={ev({
          type: 'stream_delta',
          sessionId: 's1',
          seq: 4,
          payload: { delta: 'hel' },
          superseded: true,
        })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders stream_delta unchanged (no markdown) when not superseded', () => {
    const { container } = render(
      <MessageBubble
        event={ev({
          type: 'stream_delta',
          sessionId: 's1',
          seq: 4,
          payload: { delta: '**not markdown**' },
        })}
      />,
    );
    // stream_delta shows raw text in <span class="bubble-delta">; no MarkdownRenderer.
    expect(container.querySelector('[data-test="md-renderer"]')).toBeNull();
    expect(container.querySelector('span.bubble-delta')?.textContent).toBe('**not markdown**');
  });

  it('renders tool_use bubble unchanged (no markdown)', () => {
    const { container } = render(
      <MessageBubble
        event={ev({
          type: 'assistant',
          sessionId: 's1',
          seq: 7,
          payload: { toolUse: { kind: 'tool_use', toolUseId: 'tu1', toolName: 'Bash', input: {} } },
        })}
      />,
    );
    expect(container.querySelector('[data-test="md-renderer"]')).toBeNull();
    expect(container.querySelector('.bubble.tool-use')).toBeTruthy();
  });

  it('renders tool_result bubble unchanged (no markdown)', () => {
    const { container } = render(
      <MessageBubble
        event={ev({
          type: 'tool_result',
          sessionId: 's1',
          seq: 8,
          payload: { toolUseId: 'tu1', output: 'ok' },
        })}
      />,
    );
    expect(container.querySelector('[data-test="md-renderer"]')).toBeNull();
    expect(container.querySelector('.bubble.tool-result')).toBeTruthy();
  });

  it('renders result (turn complete) unchanged (no markdown)', () => {
    const { container } = render(
      <MessageBubble
        event={ev({
          type: 'result',
          sessionId: 's1',
          seq: 9,
          payload: { durationMs: 100 },
        })}
      />,
    );
    expect(container.querySelector('[data-test="md-renderer"]')).toBeNull();
    expect(container.querySelector('.bubble.system')?.textContent).toMatch(/turn complete/);
  });

  it('renders system session_created unchanged (no markdown)', () => {
    const { container } = render(
      <MessageBubble
        event={ev({
          type: 'system',
          event: 'session_created',
          sessionId: 's1',
          seq: 1,
        })}
      />,
    );
    expect(container.querySelector('[data-test="md-renderer"]')).toBeNull();
    expect(container.querySelector('.bubble.system')?.textContent).toBe('session started');
  });
});
```

- [ ] **Step 3: Run test — expect FAIL**

```bash
npm run web:test -- MessageBubble
```

Expected: assistant-text + user + superseded tests fail (impl doesn't import MarkdownRenderer, doesn't handle superseded). Other tests should already pass against the Phase 3 impl.

- [ ] **Step 4: Edit `apps/web/src/features/chat/MessageBubble.tsx`**

Add the import at the top:

```tsx
import { MarkdownRenderer } from '../markdown/MarkdownRenderer';
```

Add the early return as the very first line inside the `MessageBubble` function body:

```tsx
if ((event as { superseded?: boolean }).superseded) return null;
```

Locate the `event.type === 'assistant'` branch where text is rendered. Replace:

```tsx
if (payload.text) {
  return <div className="bubble assistant">{payload.text}</div>;
}
```

with:

```tsx
if (payload.text) {
  return (
    <div className="bubble assistant">
      <MarkdownRenderer source={payload.text} />
    </div>
  );
}
```

Locate the `event.type === 'user'` branch. Replace:

```tsx
if (event.type === 'user') {
  const payload = event.payload as { text?: string };
  return <div className="bubble user">{payload.text ?? ''}</div>;
}
```

with:

```tsx
if (event.type === 'user') {
  const payload = event.payload as { text?: string };
  return (
    <div className="bubble user">
      <MarkdownRenderer source={payload.text ?? ''} />
    </div>
  );
}
```

- [ ] **Step 5: Run test — expect PASS**

```bash
npm run web:test -- MessageBubble
```

Expected: 8 passed.

- [ ] **Step 6: Run full web suite + typecheck + build**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run web:test
npx tsc --noEmit -p apps/web/tsconfig.json
npm run web:build 2>&1 | tail -5
```

Expected: green; bundle ~785 KB gzipped.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/chat/MessageBubble.tsx apps/web/src/features/chat/MessageBubble.test.tsx
git commit -m "feat(web): MessageBubble renders markdown for assistant + user; hides superseded events"
```

---

## Task 10: Manual e2e smoke

This task changes no code. It validates the Phase 4 increment end-to-end against a real bridge.

**Pre-reqs:** `claude` CLI on PATH and authed; existing repo build green.

- [ ] **Step 1: Build everything**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run build
```

Expected: web bundle produced. Bundle size ~785 KB gzipped (visible in `npm run web:build` output).

- [ ] **Step 2: Boot the bridge**

```bash
export BRIDGE_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
export BRIDGE_ALLOWED_DIRS=/Volumes/WDSSD/Code,$HOME
node packages/bridge/dist/index.js
```

- [ ] **Step 3: Open the URL printed**

Expected: bundle loads. DevTools → Console — zero errors. DevTools → Network tab → confirm `katex.min.css` loaded; bundle size visible.

- [ ] **Step 4: Open a Claude session**

Click `+ New session`, pick Claude, project path under `BRIDGE_ALLOWED_DIRS`.

- [ ] **Step 5: Send a markdown-rich prompt**

```
Show me a markdown sample with a heading, a bulleted list, a TypeScript code block, a Mermaid diagram (graph TD; A-->B-->C), inline math like $x^2$, and a block math equation $$\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$$.
```

Expected behaviors:
- During streaming: typewriter text in `bubble-delta` spans (raw, no markdown).
- On completion: streaming spans disappear; a rendered markdown bubble appears with:
  - `<h1>` heading.
  - `<ul>` bulleted list.
  - Syntax-highlighted TypeScript code block (Shiki, github-dark theme).
  - Mermaid SVG diagram.
  - Inline KaTeX-rendered `x²`.
  - Block-rendered KaTeX equation.

- [ ] **Step 6: Verify copy button**

Hover the code block. Click 📋. Verify the textarea source is in clipboard (paste somewhere). Button briefly shows ✓ for ~1.5 s.

- [ ] **Step 7: Verify reload-replay parity**

Reload the browser. Navigate to the same `/session/<id>`. The bubble re-renders identically. Streaming spans do NOT reappear (supersession applied during replay).

- [ ] **Step 8: Verify user-bubble markdown**

Type into the InputBox:

```
Test from me: **bold** and `inline code` plus
```ts
const x: number = 1;
```
```

Send. Verify the user bubble renders the same way (bold, inline code, syntax-highlighted code fence).

- [ ] **Step 9: Verify Mermaid parse error fallback**

Type a malformed Mermaid block:

```
\`\`\`mermaid
this is not valid syntax {{{
\`\`\`
```

Send. Verify the bubble shows "Mermaid parse error: ..." caption above a `<pre>` of the source (no crash).

- [ ] **Step 10: Verify CSP not broken**

DevTools → Console while normal use — confirm zero CSP violations. If a CSP error appears, the policy needs adjustment (Phase 3 §3 had `'self' ws: wss:`; Phase 4 may surface a violation if KaTeX or Mermaid attempts to load remote fonts).

- [ ] **Step 11: Tag the slice**

```bash
git tag phase-4-markdown-rendering
```

The tag is local-only — push if you've added a remote.

---

## Self-Review (run before declaring Phase 4 done)

1. `npm run typecheck` — both workspaces clean.
2. `npm test` — all bridge + web unit tests pass.
3. `npm run build` — both packages build cleanly. Web bundle ~785 KB gzip visible.
4. Manual smoke (Task 10) executed end-to-end against real Claude.
5. Streaming supersession works: spans disappear when consolidated bubble arrives.
6. Reload-replay reproduces final state: streaming spans stay hidden after page reload.
7. Mermaid parse errors do NOT crash — fallback `<pre>` + caption render.
8. Copy button copies the original source (not the rendered HTML).
9. `<script>` in markdown source does NOT materialize as a `<script>` element; appears as escaped text.
10. Hostile fence content (`</span><img onerror=...>`) does NOT produce `<img>` or `<script>` in the rendered DOM.
11. CSP/Permissions-Policy unchanged from Phase 3 still works — no console violations during normal use.

If any check fails, fix before tagging.
