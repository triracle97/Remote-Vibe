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
| `apps/web/src/store/sessions.ts` | `SessionEvent` augmented with optional `superseded?: true`. New private helper `markPriorStreamDeltasSuperseded(events, assistantIndex)` flips the flag on every preceding `stream_delta` event up to the first non-`stream_delta` boundary. `applyServerMsg` for `type === 'assistant'` invokes the helper when `payload` contains a non-empty `text: string`. |
| `apps/web/src/store/sessions.test.ts` | 3 new test cases for the supersession walk. |
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
import { describe, it, expect } from 'vitest';
import { renderMermaid } from './mermaid-loader';

describe('renderMermaid', () => {
  it('resolves to {svg} for a valid graph', async () => {
    const result = await renderMermaid('mtest-1', 'graph TD; A-->B;');
    expect(result.svg).toContain('<svg');
  });

  it('rejects for invalid input', async () => {
    await expect(renderMermaid('mtest-2', 'this is not mermaid syntax {{{')).rejects.toBeDefined();
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

Expected: 2 passed. (Note: mermaid renders inside happy-dom which has SVG support; tests should not need a real DOM.)

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
    <div data-test="mermaid-mock">{source}</div>
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
  });

  it('renders inline code as <code className="md-inline-code">', () => {
    const { container } = render(<CodeBlock inline>{['hello']}</CodeBlock>);
    const code = container.querySelector('code.md-inline-code');
    expect(code?.textContent).toBe('hello');
  });

  it('delegates language-mermaid to MermaidBlock', () => {
    const { getByTestId } = render(
      <CodeBlock className="language-mermaid">{['graph TD; A-->B;']}</CodeBlock>,
    );
    expect(getByTestId('mermaid-mock').textContent).toBe('graph TD; A-->B;');
  });

  it('renders Shiki HTML for a curated language once highlighter resolves', async () => {
    (getHighlighter as ReturnType<typeof vi.fn>).mockResolvedValue({
      codeToHtml: (src: string, _opts: unknown) => `<pre data-test="shiki">${src}</pre>`,
    });
    const { container } = render(
      <CodeBlock className="language-ts">{['const x = 1;']}</CodeBlock>,
    );
    await waitFor(() => {
      expect(container.querySelector('pre[data-test="shiki"]')).toBeTruthy();
    });
  });

  it('falls through to plain <pre> for non-curated language', () => {
    const { container } = render(
      <CodeBlock className="language-fortran">{['program hi']}</CodeBlock>,
    );
    expect(container.querySelector('.md-code-block pre code')?.textContent).toBe('program hi');
    expect(getHighlighter).not.toHaveBeenCalled();
  });

  it('copy button writes the original source to navigator.clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      <CodeBlock className="language-fortran">{['program hi']}</CodeBlock>,
    );
    const copy = container.querySelector('button.md-code-copy') as HTMLButtonElement;
    expect(copy).toBeTruthy();
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith('program hi');
  });

  it('hides copy button when navigator.clipboard is undefined', () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const { container } = render(
      <CodeBlock className="language-fortran">{['program hi']}</CodeBlock>,
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
import { useEffect, useState } from 'react';
import { getHighlighter, CURATED_LANGUAGES } from './shiki-loader';
import { MermaidBlock } from './MermaidBlock';

interface CodeBlockProps {
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
}

function extractLang(className?: string): string | null {
  if (!className) return null;
  const m = /\blanguage-([a-zA-Z0-9_+-]+)\b/.exec(className);
  return m ? m[1]! : null;
}

function nodeToString(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(nodeToString).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    const props = (children as { props?: { children?: React.ReactNode } }).props;
    if (props && 'children' in props) return nodeToString(props.children);
  }
  return '';
}

function CodeFenceWrapper({
  lang,
  source,
  body,
}: {
  lang: string | null;
  source: string;
  body: React.ReactNode;
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
    </div>
  );
}

export function CodeBlock({ inline, className, children }: CodeBlockProps): JSX.Element {
  const source = nodeToString(children);

  if (inline) {
    return <code className="md-inline-code">{children}</code>;
  }

  const lang = extractLang(className);

  if (lang === 'mermaid') {
    return <MermaidBlock source={source.trim()} />;
  }

  // Curated language → render via Shiki async-highlighter pattern.
  const supported = lang !== null && (CURATED_LANGUAGES as readonly string[]).includes(lang);

  return supported ? (
    <ShikiBlock lang={lang!} source={source} />
  ) : (
    <CodeFenceWrapper
      lang={lang}
      source={source}
      body={
        <pre>
          <code>{children}</code>
        </pre>
      }
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

Expected: 7 passed.

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
  CodeBlock: (props: { inline?: boolean; className?: string; children?: React.ReactNode }) => (
    <div
      data-test="code-block"
      data-inline={props.inline ? '1' : '0'}
      data-className={props.className ?? ''}
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

  it('renders inline code via CodeBlock with inline=true', () => {
    const { container } = render(<MarkdownRenderer source={'use \`foo\` here'} />);
    const cb = container.querySelector('[data-test="code-block"]');
    expect(cb?.getAttribute('data-inline')).toBe('1');
    expect(cb?.textContent).toBe('foo');
  });

  it('renders fenced code via CodeBlock with className', () => {
    const { container } = render(
      <MarkdownRenderer source={'\`\`\`ts\nconst x = 1;\n\`\`\`'} />,
    );
    const cb = container.querySelector('[data-test="code-block"]');
    expect(cb?.getAttribute('data-inline')).toBe('0');
    expect(cb?.getAttribute('data-className')).toContain('language-ts');
  });

  it('renders block math as a .katex element', () => {
    const { container } = render(<MarkdownRenderer source={'$$x^2$$'} />);
    expect(container.querySelector('.katex')).toBeTruthy();
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
        rehypePlugins={[rehypeKatex]}
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

Expected: 6 passed.

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

- [ ] **Step 2: Run test — expect FAIL on the three new ones**

```bash
npm run web:test -- sessions
```

Expected: 3 new tests fail (no supersession behavior yet).

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
function markPriorStreamDeltasSuperseded(
  events: SessionEvent[],
  assistantIndex: number,
): SessionEvent[] {
  // Walk backwards from just-before assistantIndex; flag stream_delta events
  // until we hit any non-stream_delta boundary.
  const out = events.slice();
  for (let i = assistantIndex - 1; i >= 0; i--) {
    const e = out[i]!;
    if (e.type !== 'stream_delta') break;
    if (e.superseded) continue; // idempotent
    out[i] = { ...e, superseded: true };
  }
  return out;
}
```

Locate the `applyServerMsg` action's branch that handles `m.type === 'assistant'` (it appends to the events array). Augment the append step: after appending, if `m.payload` is an object with a non-empty `text: string`, replace the events array with `markPriorStreamDeltasSuperseded(eventsAfterAppend, eventsAfterAppend.length - 1)`.

Concretely, find code shaped like:

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
  if (
    m.type === 'assistant' &&
    typeof (m.payload as { text?: unknown }).text === 'string' &&
    (m.payload as { text: string }).text.length > 0
  ) {
    nextEvents = markPriorStreamDeltasSuperseded(nextEvents, nextEvents.length - 1);
  }
  const next = { ...existing, events: nextEvents, lastSeq: m.seq };
  set((s) => ({ sessions: { ...s.sessions, [m.sessionId]: next } }));
  return;
}
```

(If the existing branching is structured differently — e.g. multiple `if` arms per type — apply the supersession step inside the `assistant` arm only.)

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run web:test -- sessions
```

Expected: existing tests + 3 new tests all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/store/sessions.ts apps/web/src/store/sessions.test.ts
git commit -m "feat(web): supersede stream_delta events when assistant text arrives"
```

---

## Task 9: Wire MarkdownRenderer + supersession early-return into MessageBubble

**Files:**
- Modify: `apps/web/src/features/chat/MessageBubble.tsx`

- [ ] **Step 1: Read the existing file**

```bash
cat /Volumes/WDSSD/Code/mac-remote-terminal/apps/web/src/features/chat/MessageBubble.tsx
```

The current file branches on `event.type` to render bubbles. Phase 4 changes:
1. Top-of-function early return: if the event has `superseded === true`, return `null`.
2. `assistant` text branch: replace `<div className="bubble assistant">{payload.text}</div>` with `<div className="bubble assistant"><MarkdownRenderer source={payload.text} /></div>`.
3. `user` branch: replace `<div className="bubble user">{payload.text}</div>` with `<div className="bubble user"><MarkdownRenderer source={payload.text} /></div>`.
4. All other branches (stream_delta, tool_use, tool_result, result, system) unchanged.

- [ ] **Step 2: Edit `apps/web/src/features/chat/MessageBubble.tsx`**

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

- [ ] **Step 3: Run all web tests + typecheck + build**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run web:test
npx tsc --noEmit -p apps/web/tsconfig.json
npm run web:build 2>&1 | tail -5
```

Expected: green; bundle ~785 KB gzipped.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/chat/MessageBubble.tsx
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
