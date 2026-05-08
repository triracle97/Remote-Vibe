# Phase 4 — Markdown Rendering — Design

**Date:** 2026-05-07
**Status:** Drafted (pre codex review)
**Builds on:** Phases 1-3.

## 1. Goals

Render assistant and user chat bubbles as full markdown with syntax-highlighted code, math, and Mermaid diagrams. Streaming experience preserved — typewriter text during generation, replaced by the rendered markdown bubble once Claude/Codex finishes the turn.

Specifically:

- **Markdown core:** GFM (tables, strikethrough, task lists, autolinks) plus inline / block math `$...$` / `$$...$$`.
- **Syntax highlight:** code fences rendered via Shiki with the `github-dark` theme and a curated language set (~20 commonly-used languages).
- **Mermaid:** \`\`\`mermaid blocks render as SVG via the Mermaid library, dark theme, `securityLevel: 'strict'`.
- **Streaming supersession:** when the consolidated `assistant` event arrives, preceding `stream_delta` spans are flagged as superseded in the store and hidden by `MessageBubble`. The data stays in the store + transcript so reload-replay reproduces the same experience.
- **Copy button** on every fenced code block.
- **Eager bundle:** all libraries imported at startup (per user choice — single big bundle, no code-splitting). Initial JS payload ~785 KB gzipped (up from ~190 KB at Phase 3).

After Phase 4, the chat surface looks like a real chat app instead of a `<pre>` dump. No new bridge code.

## 2. Non-Goals

- Code-splitting / lazy-loading (deferred — eager bundle was the operator's pick).
- Service-worker pre-cache (same — deferred).
- Markdown rendering in tool-use / tool-result bubbles (those stay structured `<pre>` JSON).
- Markdown rendering in the file-explorer preview pane (Phase 3's plain `<pre>`).
- Editing markdown in InputBox preview (the input box is plain textarea; rendering only happens on bubbles).
- Custom code themes per language. One theme: `github-dark`.

## 3. Architecture Diff vs. Phase 3

```
existing (Phases 1-3):                          new in Phase 4:

apps/web/src/features/chat/                     apps/web/src/features/markdown/
  ├── Chat.tsx                                    ├── MarkdownRenderer.tsx
  ├── MessageBubble.tsx                           ├── CodeBlock.tsx
  ├── InputBox.tsx                                ├── MermaidBlock.tsx
  └── Chat.css                                    ├── markdown.css
                                                  ├── shiki-loader.ts
                                                  └── mermaid-loader.ts

apps/web/src/store/sessions.ts                  (modified — adds supersession walk + superseded flag on SessionEvent)
apps/web/src/features/chat/MessageBubble.tsx    (modified — assistant + user branches render MarkdownRenderer; early-return on superseded)
apps/web/src/main.tsx                           (modified — eager imports of katex.min.css + markdown.css; warm shiki on boot)
apps/web/package.json                           (modified — adds 6 deps)
```

Bridge: no changes. Markdown is a pure web concern; bridge keeps streaming raw stream-json as before.

## 4. Components

### Web — new files

| File | Responsibility |
|---|---|
| `apps/web/src/features/markdown/MarkdownRenderer.tsx` | Single entry point. Wraps `<ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{ code: CodeBlock }}>`. Output wrapped in `<div className="md-rendered">`. `React.memo`-ed on `source` so identical re-renders skip parsing. |
| `apps/web/src/features/markdown/CodeBlock.tsx` | Custom `code` component injected via `react-markdown`'s `components` prop. Branches by `inline` flag and `className` (which carries `language-<lang>` for fenced blocks). Branches: inline → `<code className="md-inline-code">`; `language-mermaid` → `<MermaidBlock>`; other language → Shiki via `shiki-loader`; unknown / no language → plain `<pre><code>`. Wraps fenced output in `<div className="md-code-block">` with a language label and a copy-to-clipboard button. |
| `apps/web/src/features/markdown/MermaidBlock.tsx` | `useEffect` calls `mermaid-loader`'s `renderMermaid(uniqueId, source)`. On success, sets a ref'd `<div>`'s `innerHTML` to the SVG. On parse failure, renders the source as a fallback `<pre>` with a "Mermaid parse error: <message>" caption. Memoized on `source`. |
| `apps/web/src/features/markdown/shiki-loader.ts` | Singleton highlighter. Exports exactly two symbols: `getHighlighter(): Promise<Highlighter>` (returns a memoized promise — first call triggers async load, subsequent calls reuse it) and `CURATED_LANGUAGES: readonly string[]` (the registered set: `ts`, `tsx`, `js`, `jsx`, `json`, `bash`, `sh`, `zsh`, `python`, `rust`, `go`, `yaml`, `toml`, `dockerfile`, `markdown`, `html`, `css`, `sql`, `diff`). The loader resolves a `Highlighter` configured with theme `github-dark` and the curated languages. Callers invoke ONLY `highlighter.codeToHtml(source, { lang, theme: 'github-dark' })`. The loader does NOT export a sync `highlight()` helper — async-only contract avoids the sync-vs-async ambiguity. Languages outside `CURATED_LANGUAGES` are detected at the call site (CodeBlock) and rendered as plain `<pre>` without invoking Shiki. |
| `apps/web/src/features/markdown/mermaid-loader.ts` | One-time `mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })`. Exports `async renderMermaid(id: string, source: string): Promise<{ svg: string }>`. The initialize call is idempotent; subsequent imports are cheap. |
| `apps/web/src/features/markdown/markdown.css` | Styles for `.md-rendered h1/h2/h3/p/ul/ol/li/blockquote/hr`, `.md-rendered table/th/td`, `.md-inline-code`, `.md-code-block`, `.md-code-lang`, `.md-code-copy`, `.md-mermaid`, `.md-mermaid-error`. Tight, dark-themed, matches existing chat palette. |

### Web — modified files

| File | Change |
|---|---|
| `apps/web/src/features/chat/MessageBubble.tsx` | At the top of the function: `if ((event as { superseded?: boolean }).superseded) return null;`. The `event.type === 'assistant'` text-payload branch and the `event.type === 'user'` branch render `<MarkdownRenderer source={text} />` instead of plain `<div>{text}</div>`. Tool-use, tool-result, result, stream_delta, and system branches unchanged. |
| `apps/web/src/store/sessions.ts` | `SessionEvent` augmented with optional `superseded?: true`. New action `markStreamDeltasSuperseded(sessionId, assistantSeq)` flips the flag on every `stream_delta` whose seq < `assistantSeq` AND whose seq > the most recent prior boundary event's seq (boundary = any `result`, `assistant` with text, or `system` lifecycle event). `applyServerMsg` for `type === 'assistant'` invokes the action when `payload` contains a non-empty `text` string. Tests cover (a) supersession marks the right deltas, (b) does NOT cross turn boundaries (deltas before a previous turn's `result`), (c) reload-replay re-supersedes correctly. |
| `apps/web/src/main.tsx` | Add eager imports near the top: `import 'katex/dist/katex.min.css';` and `import './features/markdown/markdown.css';`. After `createRoot(...).render(...)`, fire-and-forget warm Shiki: `void import('./features/markdown/shiki-loader').then((m) => m.getHighlighter());`. Mermaid CSS is injected by the lib itself; no manual import. |
| `apps/web/package.json` | Add deps: `react-markdown` `^9`, `remark-gfm` `^4`, `remark-math` `^6`, `rehype-katex` `^7`, `shiki` `^1.22`, `mermaid` `^11`, `katex` `^0.16`. (Versions pinned at impl time.) |

### Bridge

No changes.

## 5. Data Flow

### Streaming supersession

1. User sends a prompt. Bridge emits `stream_delta` events with monotonic `seq` as Claude generates text.
2. Web receives each `stream_delta` → `applyServerMsg` appends to `events`. `MessageBubble` renders each as a `<span class="bubble-delta">`. Visually: typewriter effect.
3. When Claude finishes the turn, bridge emits an `assistant` server message with `payload.text` set to the consolidated string and `seq = N`.
4. `applyServerMsg`'s `assistant` branch (in addition to its existing append) walks backwards through the session's `events` array starting just before the new event (it's appended at index `events.length - 1`). For each preceding event:
   - If its type is **anything other than `stream_delta`** — STOP. The walk does not cross this boundary. Concretely the boundary set is: `result`, `assistant` (any payload — text, tool_use, etc.), `tool_result`, `status`, `user`, `system` (init/session_created/session_ended/etc). This means a contiguous run of `stream_delta` events ending immediately before the new `assistant` is the supersession scope; nothing earlier is touched.
   - If its type is `stream_delta` — flag `superseded: true`. Continue.
5. The store commits the events array with the `superseded` flags set.
6. `MessageBubble` early-returns `null` for any event with `superseded === true`. The streaming spans visually disappear; the rendered markdown bubble appears in their place.

**Idempotency for replay parity.** `applyServerMsg` ignores any `superseded` field on incoming server messages — the bridge protocol does not carry it (server-side `ServerStreamMsg`/`ServerLifecycleMsg` types in Phases 1-3 do not declare `superseded`). The flag is purely a web-store derivative computed by the supersession walk. Replay correctness:

- **Live → reload via `get_history`:** the bridge replays the original `stream_delta` and `assistant` events in order. Each `applyServerMsg('assistant', …)` invocation re-runs the walk on whatever stream_deltas now sit immediately before in the events array. The walk is purely additive — it sets `superseded: true`; it never clears the flag. Re-flagging an already-flagged event is a no-op write of the same boolean.
- **Live → reload via transcript-only fallback (`streamTranscript`):** transcript JSONL contains the same events in the same order. The store is reset before the fallback streams in (`Session.tsx` calls `useFileExplorerStore.reset()` and the same `useSessionsStore` cleanup pattern is used). `applyServerMsg` runs once per yielded event and reaches the same final state.
- **Cross-turn isolation:** because the walk's STOP condition is "any non-stream_delta event", stream_deltas from a previous turn (separated by a `result` or another non-delta event) are NOT touched by a later turn's assistant. Tested explicitly.

### Markdown render path

1. `MessageBubble` for `event.type === 'assistant'` (text variant) returns `<div className="bubble assistant"><MarkdownRenderer source={payload.text} /></div>`.
2. `MarkdownRenderer` runs `react-markdown` with the configured plugin pipeline. Output is a tree of React elements (headings, paragraphs, lists, links, etc.) plus the custom `CodeBlock` for fenced and inline code.
3. `CodeBlock` receives `({ inline, className, children })`. Branching:
   - `inline === true` → `<code className="md-inline-code">{children}</code>`. Done.
   - className matches `language-mermaid` → `<MermaidBlock source={String(children).trim()} />`.
   - className matches `language-<lang>` for some lang in `CURATED_LANGUAGES` → render through the async-highlighter pattern below.
   - className matches `language-<lang>` outside `CURATED_LANGUAGES` → `<div className="md-code-block">` wrapping `<pre><code>{children}</code></pre>` plain (no Shiki invocation), plus the language label and copy button.
   - No className → `<pre><code>{children}</code></pre>` plain (no wrapper, no copy button — bare inline-style code).

   **Async-highlighter pattern (Shiki-eligible languages):** `CodeBlock` keeps a piece of local state `const [html, setHtml] = useState<string | null>(null)`. A `useEffect` keyed on `[source, lang]` runs:
   ```ts
   let cancelled = false;
   getHighlighter().then((h) => {
     if (cancelled) return;
     setHtml(h.codeToHtml(source, { lang, theme: 'github-dark' }));
   });
   return () => { cancelled = true; };
   ```
   Render: while `html === null`, output a fallback `<div className="md-code-block"><pre><code>{children}</code></pre></div>` plus the language label and copy button. Once `html` resolves, output `<div className="md-code-block" dangerouslySetInnerHTML={{ __html: html }} />` plus the same overlays. The fallback's first paint shows raw text; the highlighted version replaces it on the next render. There is no separate `setHighlighted` API — `setHtml` is the only state setter.
4. `MermaidBlock`:
   - `useEffect` triggers on `source` change. Calls `renderMermaid(\`mermaid-\${useId()}\`, source)`.
   - On success: `ref.current.innerHTML = svg`.
   - On rejection: state `error = e.message`. Render fallback `<div className="md-mermaid-error">Mermaid parse error: {error}<pre>{source}</pre></div>`.

### Copy-to-clipboard

`CodeBlock`'s copy button: `navigator.clipboard.writeText(source).then(() => setCopied(true)); setTimeout(() => setCopied(false), 1500);`. Button label flips `📋` → `✓` for 1.5 s. If `navigator.clipboard` is undefined (rare), the button is hidden via `if (!navigator.clipboard) return null;` on the button element.

### Shiki warm-up

`main.tsx` after `createRoot(...).render(...)` schedules:

```ts
void import('./features/markdown/shiki-loader').then((m) => m.getHighlighter());
```

This fires AFTER first paint. The first code-block render before warm-up completes falls through to plain `<pre>` (no highlight); subsequent renders pick up the highlighter once cached. Visible flash on the first markdown bubble is acceptable given the eager-bundle choice.

## 6. Errors + Edge Cases

| Failure | Behavior |
|---|---|
| Malformed Mermaid source | `MermaidBlock` catches, renders `<div className="md-mermaid-error">` with the source preserved as `<pre>` and the error text as a caption. Bubble rendering does NOT crash. |
| Shiki language not registered | `CodeBlock` falls through to plain `<pre>`. Production: silent. Dev (`import.meta.env.DEV`): a small "language `<lang>` not highlighted" caption shown. |
| Shiki highlighter still loading at first render | Plain `<pre>` rendered as fallback; subsequent re-render shows highlighted version. Visible flash, acceptable. |
| KaTeX parse error (`$\frac$` malformed) | KaTeX's default `errorColor: '#cc0000'` and `throwOnError: false` settings render the failed expression as red literal text. No crash. |
| Markdown source contains `<script>...</script>` (or any other raw HTML) | `react-markdown` is configured WITHOUT `rehype-raw`. Per the lib's default behavior, raw HTML in markdown source is rendered as literal text content (the `<` and `>` become escaped text nodes — `&lt;script&gt;…&lt;/script&gt;`). No `<script>` element materializes in the DOM. CSP `script-src 'self'` is the second line of defense. The acceptance test asserts BOTH: (a) `document.querySelectorAll('script').length === 0` after rendering a `<script>` source, AND (b) the literal `<script>` substring appears as escaped text in `innerHTML`. |
| `navigator.clipboard.writeText` rejects | Button briefly shows `✗` for 1.5 s then reverts. No exception bubbled. |
| User pastes a 50 KB code fence | Shiki handles; render time ~O(size). No special handling. If problematic in practice, virtualize later. |
| Inline `$5 vs $10` (currency, not math) | remark-math requires no whitespace inside `$...$`. The literal string `$5 vs $10` does NOT trigger math rendering. |
| Streaming text mid-`stream_delta` contains incomplete markdown (e.g. `**bold` without closing `**`) | Streaming bubbles render as raw text spans (NOT markdown), so partial-token ugliness is avoided by design. Markdown only renders on the consolidated `assistant` bubble. |
| `MarkdownRenderer` receives identical `source` on parent re-render | `React.memo` short-circuits. No re-parse. |
| Large code fence reaches Shiki before highlighter ready | Plain `<pre>` fallback rendered immediately (see §5 async-highlighter pattern). The `useEffect` awaits `getHighlighter()` and calls `setHtml` once resolved, triggering a single re-render of the same `CodeBlock` instance. Already-mounted code blocks therefore upgrade in place once the highlighter resolves; new bubbles after warm-up render highlighted on first paint. |

## 7. Security

- **No raw HTML in markdown source.** `react-markdown` is configured WITHOUT `rehype-raw`. The default behavior renders raw HTML in markdown source as literal escaped text (the `<` and `>` characters become text-content escapes; the resulting DOM contains zero `<script>`/`<img>`/`<iframe>` elements derived from the source). This is the single SSOT for the raw-HTML claim across §6 and §7.
- **Mermaid `securityLevel: 'strict'`** disables click handlers and HTML embedding inside diagrams. Mermaid renders SVG; SVG embeds no `<script>` under strict mode.
- **CSP from Phase 3** (`script-src 'self'`) is the secondary line of defense if anything slips through.
- **Shiki output uses `dangerouslySetInnerHTML`.** Shiki's `codeToHtml` (the only Shiki API the codebase calls) emits library-generated HTML with all source bytes HTML-entity-escaped before being wrapped in `<span style="color:#xxx">…</span>`. Concrete acceptance criteria the implementer MUST satisfy:
  - **Pinned API path.** `shiki-loader.ts` exports a single `getHighlighter()` that returns `Highlighter`, and code-rendering callers invoke ONLY `highlighter.codeToHtml(source, { lang, theme })`. Other Shiki APIs (`getTokens`, `codeToHast`, `codeToTokensBase`) are out of scope and must NOT be used in Phase 4.
  - **Regression test for hostile content.** A unit test in `shiki-loader.test.ts` feeds a hostile fence body — exactly `</span><img src=x onerror=alert(1)>` — through `highlight(source, 'ts')`, then parses the resulting HTML via `DOMParser` (or a `JSDOM`/`happy-dom` equivalent in Vitest's `happy-dom` env) and asserts: (a) zero `<img>` elements exist in the parsed tree, (b) zero `<script>` elements exist, (c) the literal `<` and `>` characters from the source appear as `&lt;` / `&gt;` text-content escapes in the rendered HTML. This pins the contract and catches a future Shiki regression.
  - **No additional sanitizer.** A second-pass DOMPurify is intentionally NOT added — pinning the API + the regression test gives equivalent assurance with zero new dep weight. If the test ever fails on a Shiki upgrade, the upgrade is rolled back until either the upstream bug is fixed or DOMPurify is added in a follow-up phase.
- **Math via KaTeX** renders MathML + HTML; no script execution.
- **Copy button** uses `navigator.clipboard.writeText(source)` — original markdown source, not the rendered HTML. Safe.
- **No new env vars, no new bridge endpoints, no new data exfiltration surface.** Phase 4 is pure rendering.

## 8. Testing

### Web unit tests

- **`MarkdownRenderer.test.tsx`** — bold (`**x**` → `<strong>`), italic (`*x*` → `<em>`), heading (`# Title` → `<h1>`), unordered list, ordered list, link, inline code → `<code>`, fenced code → CodeBlock invoked (mocked), block math `$$x^2$$` → `.katex` element exists, GFM table → `<table>` with `<thead>`. **Raw-HTML escape test (§7 acceptance criterion):** source `Try this: <script>alert(1)</script> and <img src=x onerror=...>` renders to a DOM where `container.querySelectorAll('script').length === 0`, `container.querySelectorAll('img').length === 0`, AND `container.innerHTML` contains the literal substring `&lt;script&gt;` (proving the source bytes survive as escaped text content).
- **`CodeBlock.test.tsx`** — `inline=true` renders `<code className="md-inline-code">`. Block + `language-mermaid` invokes `<MermaidBlock>` (mocked). Block + `language-typescript` calls `getHighlighter()` (mocked) and renders the result. Block + unknown lang renders plain `<pre>`. Copy button calls `navigator.clipboard.writeText` with original source. Copy button hidden when `navigator.clipboard` undefined.
- **`MermaidBlock.test.tsx`** — valid source → SVG injected. Invalid source → fallback `<pre>` + error caption. Mock `mermaid.render` to control success/failure deterministically.
- **`shiki-loader.test.ts`** — `getHighlighter()` returns the same promise on repeated calls. After resolution, `highlighter.codeToHtml('const x = 1', { lang: 'ts', theme: 'github-dark' })` returns HTML containing `<pre>` and at least one `<span style="color:`. **Hostile-content regression test (§7 acceptance criterion):** feed `</span><img src=x onerror=alert(1)>` through `codeToHtml` with `lang: 'ts'`; parse the result via `DOMParser`; assert `parsed.querySelectorAll('img').length === 0`, `parsed.querySelectorAll('script').length === 0`, and that the literal `<` and `>` from the source appear as `&lt;`/`&gt;` text escapes in `innerHTML`.
- **`mermaid-loader.test.ts`** — `renderMermaid` resolves to `{svg}` for a valid graph. Rejects for invalid input.
- **`sessions.test.ts` (additions)** — three tests:
  1. After `assistant` event with text payload, all preceding `stream_delta` events in the same turn are flagged `superseded`.
  2. `stream_delta` events from a previous turn (before a `result` event) are NOT flagged.
  3. Reload-replay (calling `applyServerMsg` on the same events again from cold) reaches the same final superseded set.
- **`MessageBubble.test.tsx` (additions)** — assistant text bubble renders `<MarkdownRenderer />` (mock). User bubble renders `<MarkdownRenderer />`. Tool-use, tool-result, result, system unchanged. Event with `superseded: true` returns null.

### Bridge unit tests

None added. Phase 4 is web-only.

### Manual e2e smoke

Add to Phase 4 plan's last task. Operator:

1. Boots the bridge as in Phase 3 smoke.
2. Opens a Claude session.
3. Sends a prompt that produces rich markdown (e.g. `Show me a TypeScript example with a Mermaid diagram and a fraction`).
4. Verifies during streaming: typewriter text appears.
5. Verifies on completion: the streaming text disappears and a rendered bubble shows headings, lists, syntax-highlighted TypeScript, a Mermaid SVG, and a KaTeX-rendered fraction.
6. Verifies the copy button on the code block works.
7. Reloads the browser; verifies the rendered bubble re-appears via transcript replay.
8. Pastes a markdown message into the InputBox themself (e.g. `**bold** and \`code\``) and sends; verifies the user bubble renders the same way.
9. Inspects DevTools → no CSP violations, no console errors during normal use.

## 9. Environment

No new environment variables. No new config files.

## 10. Open Items Deferred to Implementation

- Exact Shiki version-pin (1.22 latest at draft time; impl pins to whichever 1.x has stable curated bundles).
- Whether to include language `kotlin` / `swift` / `java` / `c` / `cpp` / `csharp` in the curated set. The current spec's set covers ~95 % of expected use — extras can join later.
- Whether the Shiki `github-dark` theme needs a small CSS tweak to fit the existing palette. Dec at impl time.
- Whether `katex.min.css` should be deduplicated with our own font setup. Likely no — KaTeX ships its own fonts.
- Whether the user-bubble markdown should auto-link bare URLs. `remark-gfm` does this by default; spec keeps it on.

## 11. Implementation Phasing

The Phase 4 plan (separate doc under `docs/superpowers/plans/`) breaks into ~10 tasks following the same TDD cadence as Phases 1-3:

1. Add deps + main.tsx CSS imports + Shiki warm-up.
2. `shiki-loader.ts` + tests.
3. `mermaid-loader.ts` + tests.
4. `MermaidBlock.tsx` + tests.
5. `CodeBlock.tsx` + tests.
6. `MarkdownRenderer.tsx` + tests.
7. `markdown.css` (no tests — pure CSS).
8. Streaming supersession in `sessions.ts` + tests.
9. `MessageBubble.tsx` updates (assistant + user → MarkdownRenderer; superseded early-return) + tests.
10. Manual e2e smoke.

After Phase 4: every original spec feature plus full markdown rendering shipped.
