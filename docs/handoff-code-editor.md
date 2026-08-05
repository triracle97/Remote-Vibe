# Handoff — port nimbalyst's Monaco code editor into Remote Vibe

**Goal:** replace the read-only file preview with nimbalyst's Monaco-based code editor, so files
can be opened and edited from the phone.

**Status:** done. See §8 for what landed and where the plan below was departed from.

---

## 1. What nimbalyst actually has

All under `/Volumes/WDSSD/Code/nimbalyst/packages/runtime/src/editors/`:

| File | Lines | What it is | Port? |
| --- | --- | --- | --- |
| `MonacoCodeEditor.tsx` | 545 | The editor itself. Normal + diff mode, theme, language detection, dirty tracking, `onGetContent` accessor | **Yes — this is the core** |
| `monacoUtils.ts` | 225 | `getMonacoLanguage(path)` extension→language map, `getMonacoTheme` | **Yes** |
| `MonacoEditor.tsx` | 351 | Wrapper adapting the editor to their `EditorHost` interface (loadContent / saveContent / setDirty / onFileChanged) | Pattern only — we have no `EditorHost` |
| `MarkdownEditor.tsx` | 384 | Lexical rich-text, not code | No |
| `monacoCollabBinding.ts` | 61 | Yjs multi-user binding | No — single user |
| `monacoModelReady.ts` | 50 | Collab model-ready gate | No |

`MonacoCodeEditor` props (`MonacoCodeEditor.tsx:26`) are already close to what we need:
`filePath`, `fileName`, `initialContent`, `theme`, `isActive`, `editorOptions`,
`onDirtyChange`, `onGetContent`, `onEditorReady`, `onDiffChangeCountUpdate`.
Plus `MonacoDiffModeConfig { oldContent, newContent }`.

Its only nimbalyst-specific couplings are `ConfigTheme` from `../editor` and
`getTheme` from `../editor/themes/registry`. Both get swapped for our `--color-*` tokens
(same treatment the transcript port already got).

### Dependencies

```
monaco-editor       ^0.55.1     (nimbalyst root package.json:123)
@monaco-editor/react            (listed in electron.vite.config.ts:531)
```

**Do not let `@monaco-editor/react` fetch Monaco from its default CDN.** Nimbalyst pins it to the
local package — `loader.config({ monaco })` at
`packages/electron/src/renderer/utils/monacoConfig.ts:226`. We must do the same: this app is
served over Tailscale from a laptop, and a CDN dependency makes the editor fail exactly when
the tailnet is up but the internet isn't.

Monaco also needs 5 web workers, wired with Vite's native `?worker` imports
(`monacoConfig.ts:19-23`): `editor`, `json`, `css`, `html`, `typescript`.

---

## 2. The blocker: the bridge cannot write files

This is the part to solve first, and it is not a port — it is new bridge surface.

`packages/bridge/src/fs-api.ts` exposes exactly two operations:

```
listDirs(path)                   fs-api.ts:179
readFile(path, sizeCap)          fs-api.ts:228
```

There is no `writeFile`, and no `write_file` message anywhere in the protocol. Today the file
drawer is strictly read-only: `FilePreview.tsx` renders a `<pre>`. An editor without a save path
is just a nicer viewer.

So the work splits:

**A. Bridge write path (new, security-relevant)**
- `FsApi.writeFile(path, content)` reusing the existing `resolveAndGate()` (`fs-api.ts:162`) so
  writes land under `BRIDGE_ALLOWED_DIRS` and nowhere else. The gate already handles symlink
  escape and the `DENIED_SEGMENT_RUNS` list — use it, do not write a second check.
- `write_file` client message + result, wired in `websocket.ts` next to the `read_file` handler.
- Atomic write (tmpfile + rename), matching `JobStore` and `SessionRegistry`.
- A size cap. The read cap is currently `5 * 1024 * 1024` hardcoded at `websocket.ts:535` —
  worth lifting both into `env.ts` while you are there.

**Think hard about the security note in the README before shipping this.** Today the bridge's
blast radius is "the agent can write files"; after this it becomes "anyone holding the token can
write files directly, without an agent in the loop." That is a real widening. Worth a
confirmation-on-overwrite in the UI at minimum, and worth telling the user explicitly.

**B. Editor UI (the actual port)**
- `MonacoCodeEditor.tsx` + `monacoUtils.ts`, theme tokens swapped.
- Replace or wrap `apps/web/src/features/file-explorer/FilePreview.tsx`.
- Dirty state, explicit save (Cmd/Ctrl+S and a button), and a guard against navigating away dirty.

---

## 3. The risk nobody should skip: Monaco on a phone

Remote Vibe is phone-first. Two hard facts:

1. **Our main chunk is already 2.3 MB** (`apps/web/dist/assets/index-*.js`). Monaco adds roughly
   2–4 MB more plus five worker bundles.
2. **Nimbalyst does not use Monaco on iOS.** Their `packages/ios/src` has zero Monaco references —
   it is Electron-only. The original port plan for this repo records why:

   > nimbalyst's own mobile work hit a 25MB bundle that crashed WKWebView because barrel
   > `export *` blocked tree-shaking. Import each ported module by **deep path**, never through
   > an `index.ts` barrel.

   So "the same code editor as in nimbalyst" has never actually run on a phone, in nimbalyst.

Mitigations, in order of preference:
- **Lazy-load Monaco behind a dynamic `import()`**, the way `mermaid-loader.ts` already keeps
  mermaid out of the main chunk. The editor should cost nothing until a file is opened.
- Deep-path imports only. No barrel `index.ts`.
- Consider gating the editor behind a desktop-width check and keeping the `<pre>` viewer on
  narrow screens — decide this *with the user*, do not assume.
- Measure before and after: `du -sh apps/web/dist/assets/*.js | sort -h | tail -5`.

An alternative worth raising with the user before committing: **CodeMirror 6** is a fraction of
Monaco's size and is built for touch. It would not be "the same editor as nimbalyst", which is
what was asked for — so raise it as a question, do not silently substitute.

---

## 4. Where it plugs in

- `apps/web/src/features/file-explorer/FilePreview.tsx` — the read-only `<pre>` this replaces.
- `apps/web/src/features/file-explorer/FileExplorer.tsx` — the tree that selects a file.
- `apps/web/src/store/file-explorer.ts` — holds `dirs`, `selectedFile` (`SelectedFile` is a
  discriminated union of `loading | text | binary | too_large`), `requestFile`, `applyFileResult`.
  A `saving` state and a `dirty` flag belong here.
- `apps/web/src/features/chat/Chat.tsx:62` — `openFile()` already resolves a transcript file
  reference (relative paths against the session cwd) and opens the drawer. **This is the entry
  point**: clicking a path in an agent's diff should land in the editor.

---

## 5. Suggested sequencing

```
1. Bridge write path (FsApi.writeFile + write_file message + tests)   ← blocker, do first
2. monacoUtils.ts port (pure, zero-dep, trivially testable)
3. MonacoCodeEditor.tsx port, lazy-loaded, theme tokens swapped
4. Wire into FilePreview / file-explorer store: dirty, save, conflict
5. Diff mode (MonacoDiffModeConfig) against the agent's edits
6. Measure the bundle. Decide the mobile story with the user.
```

Steps 2–3 are useless without 1, and step 6 may send you back to step 3.

---

## 6. Repo conventions that will bite you

- **vitest runs `globals: false`.** RTL auto-cleanup does NOT register — every component test
  file needs an explicit `afterEach(cleanup)`.
- **`packages/bridge/tsconfig.json` excludes `src/__tests__`**, so bridge tests are not
  typechecked. Web tests *are*.
- Bind broadcast arrays per-test (`const sink: ServerMsg[] = []`), never a shared `let` — a late
  async broadcast from one test otherwise lands in the next test's array.
- Run the full gate before declaring done:
  `npm run typecheck && npm test && npm run build`.
- Background bridge processes get reaped in agent sessions. To host, tell the user to run
  `! node packages/bridge/dist/index.js` in their own shell. It auto-detects the Tailscale IP
  (`index.ts:114`); no `BRIDGE_BIND_HOST` needed when Tailscale is up.
- When finding the bridge process, use `lsof -nP -tiTCP:8765 -sTCP:LISTEN`. Plain
  `lsof -ti tcp:8765` also returns *client* connections, and killing one of those kills a browser
  tab instead of the bridge.

---

## 7. Open questions for the user

1. Monaco despite the size, or CodeMirror 6 for a phone-sized editor? ("same as nimbalyst" = Monaco,
   but nimbalyst never shipped it to mobile.)
2. Is direct file writing from the browser acceptable, given it widens the token's blast radius
   beyond "drive an agent"?
3. Editor on mobile too, or desktop-only with the current viewer on narrow screens?

**Answers, given by the user before the work started:**

1. **Monaco, lazy-loaded.** Not CodeMirror.
2. **Yes, with an overwrite confirmation.**
3. Mobile included — no desktop-width gate.

---

## 8. What actually landed

### Bridge

- `fs-api.ts` — `FsApi.writeFile(path, content, baseHash?)`. Reuses `resolveAndGate()`, so a
  write is subject to the identical allowlist, denylist and symlink-escape resolution as a read.
  Atomic (sibling tmpfile + `rename`), preserves the original file mode so an executable script
  does not silently lose `+x`. **Cannot create files** — `resolveAndGate` is built on `realpath`,
  which only resolves paths that already exist, and leaning on that is what keeps the write path
  from needing a second, subtly different gate for parent directories.
- Conflict detection via SHA-256 rather than mtime or size: `file_result` now carries a `hash`,
  `write_file` sends it back as `baseHash`, and a mismatch is refused with `file_conflict`.
  Omitting `baseHash` forces the write — that is what the UI's "Overwrite anyway" does.
- `env.ts` — read and write caps lifted out of the hardcoded `5 * 1024 * 1024` at the old
  `websocket.ts:535` into `BRIDGE_FS_READ_MAX_BYTES` / `BRIDGE_FS_WRITE_MAX_BYTES`. They live on
  `FsApi` rather than being threaded through `handleMessage`'s positional parameter list.
- `websocket.ts` — `write_file` handler beside `read_file`; both now share a `sendFsError` helper
  so a typed FS code reaches the client instead of collapsing to `unsupported_message`.
- New error codes: `file_too_large`, `file_conflict`, `file_write_failed`.

### Web

- `features/editor/monacoUtils.ts` — ported. Extension→language map carried over and extended;
  the nimbalyst theme-registry lookup dropped in favour of the two `data-theme` themes. Also
  handles `.env.local`-style names, which the original missed.
- `features/editor/monaco-loader.ts` — worker wiring + `loader.config({ monaco })`. That second
  part matters: `@monaco-editor/react` otherwise fetches Monaco from a **public CDN** at runtime,
  which is wrong for a Tailscale-only bridge.
- `features/editor/MonacoCodeEditor.tsx` — ported, including the content-ownership pattern and
  diff mode. External reloads use `executeEdits` rather than `setValue`, so the cursor and undo
  stack survive a re-read.
- `features/editor/CodeEditorPane.tsx` — the app-specific shell: dirty dot, discard, save with
  confirm, conflict banner with Reload, ⌘S, `beforeunload` guard. Monaco sits behind the
  `React.lazy` boundary here and nowhere else.
- `store/file-explorer.ts` — `editor` slice (`dirty`/`saving`/`error`/`conflict`) plus
  `saveFile`/`applyFileWritten`/`applyServerError`. Save errors are claimed by the store and kept
  out of the global banner.

### Departures from the plan above

- **Steps 4 and 5 were merged, and diff mode is not yet wired to a UI.** `MonacoCodeEditor`
  supports `showDiff`/`acceptDiff`/`rejectDiff` via its `onEditorReady` handle, but nothing calls
  them — there is no "review the agent's edit" affordance yet. The capability is ported and
  tested-by-type; the feature is not built.
- **Static assets are now gzipped** (`http-server.ts`). Not in the plan, but the measurement in
  step 6 made it necessary: the bridge served everything uncompressed, and the Monaco chunk plus
  the TypeScript worker are ~10 MB raw. `worker-src 'self' blob:` added to the CSP at the same
  time.

### Measurements (step 6)

| Chunk | Raw | Gzip |
| --- | --- | --- |
| `index-*.js` (main) | 2,448.52 kB | 721.81 kB |
| `MonacoCodeEditor-*.js` (lazy) | 3,826.48 kB | 990.69 kB |
| `MonacoCodeEditor-*.css` (lazy) | 146.49 kB | 23.02 kB |
| `ts.worker` (lazy, on first `.ts`/`.js`) | 6.7 MB | — |

The main chunk's content hash is **unchanged** from the pre-Monaco build, which is the useful
proof that the lazy boundary holds: Monaco contributed exactly zero bytes to it.

### Still open

- Monaco's touch behaviour on a real phone is untested. It has not been run on a device.
- The TypeScript worker is the single largest asset in the app and is fetched the first time any
  `.ts`/`.js` file is opened. Diagnostics are already disabled; if the worker proves too heavy on
  mobile, the next lever is to stop registering it and accept losing completions/hover for TS,
  which would keep syntax highlighting (Monarch runs on the main thread) at a fraction of the cost.
