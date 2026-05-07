# Phase 3 — File Explorer + Image Attach + Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the original spec by shipping a read-only lazy file explorer (right-side drawer + plain `<pre>` preview), Claude-only image attach (paste / drop / 📎 button), and the FS denylist + CSP polish that protect both.

**Architecture:** Bridge gains `fs-api.ts` (single source of FS truth: allowlist + denylist + binary detection) and `image-store.ts` (validate + audit-copy + cleanup). WebSocket gains `list_dirs` and `read_file` routes; the existing `input` route validates images before forwarding. `claude-process.sendUserText` learns to embed base64 image content blocks alongside text. Web gains `store/file-explorer.ts` (Zustand), `FileExplorer` + `FilePreview` components mounted in `Session.tsx`, and `useImagePaste` + `ImageThumbnails` hooked into `InputBox`. CSP polish is a single-file change to `http-server.ts`.

**Tech Stack:** Same as Phases 1 + 2 — Node 20 LTS, TypeScript 5 ESM (NodeNext), `ws@^8`, Vitest 1, React 18, Vite 5, Zustand 4, React Router 6.

**Spec:** `docs/superpowers/specs/2026-05-07-phase-3-explorer-images-hardening-design.md`

**Out of scope (per spec §2):** syntax highlighting in preview, file write/delete/rename, Codex image input, markdown rendering, Playwright E2E in CI, idle reaping, separate audit log.

---

## File Structure

### Bridge — new files

```
packages/bridge/src/
├── fs-api.ts                         # listDirs + readFile with allowlist + denylist
├── image-store.ts                    # validate + writeAuditCopy + cleanup
└── __tests__/                        # one *.test.ts per new module
└── test/fixtures/
    └── tiny.png                      # 1x1 PNG used by binary-detection + image-store tests
```

### Bridge — modified files

| File | Change |
|---|---|
| `types.ts` | New `ClientListDirsMsg`, `ClientReadFileMsg`. New `ServerDirsResultMsg` and discriminated `ServerFileResultMsg = ServerFileResultText \| ServerFileResultBinary \| ServerFileResultTooLarge`. New `ServerErrorCode` members `path_denied`, `image_too_large`, `image_invalid_mime`, `too_many_images`. |
| `websocket.ts` | New routes `list_dirs` and `read_file`. `input` route validates images via `imageStore.validate(images, agent)` before forwarding. `AttachWsOpts` gains `fsApi` + `imageStore`. `MAX_MSG_BYTES` bumped from 16 MB to 64 MB. |
| `session.ts` | `SessionManagerOpts` gains `imageStore?`. `sendInput(sessionId, text, images?)` — when `images` present, after the synchronous broadcast/transcript/promptStore/proc.sendUserText steps complete, schedules `void imageStore.writeAuditCopy(...).catch(log)`. `onProcExit` calls `imageStore.cleanup(sessionId)`. |
| `claude-process.ts` | `sendUserText(text, images?)` builds Anthropic content blocks: `[{type:'text',text}, ...images.map(i => ({type:'image', source:{type:'base64', media_type:i.mime, data:i.base64}}))]`. |
| `codex-process.ts` | `sendUserText(text, images?)` ignores `images` (Codex sessions never reach here with images — gated at SessionManager). Signature change is type-compatibility only. |
| `http-server.ts` | `SECURITY_HEADERS` updated: new `Content-Security-Policy` and `Permissions-Policy`. |
| `index.ts` | Constructs `FsApi(allowedDirs)` and `ImageStore({dataDir})`. Wires `imageStore` into SessionManager and `fsApi` + `imageStore` into `attachWebSocket`. |

### Web — new files

```
apps/web/src/
├── store/
│   └── file-explorer.ts              # Zustand: dirs cache, expanded, loadingPaths, selectedFile
├── services/                         # (no new files; webhooks reuse bridge-client.ts)
└── features/
    ├── file-explorer/
    │   ├── FileExplorer.tsx          # right drawer with lazy tree
    │   ├── FilePreview.tsx           # <pre> preview / binary metadata / too-large message
    │   └── FileExplorer.css
    └── image-attach/
        ├── ImageThumbnails.tsx       # strip above InputBox
        └── useImagePaste.ts          # paste + drop + click-button hook
```

### Web — modified files

| File | Change |
|---|---|
| `types/protocol.ts` | Mirror `packages/bridge/src/types.ts` byte-for-byte. |
| `pages/Session.tsx` | Mount `FileExplorer` drawer with toggle button in chat header. Reset file-explorer store on `id` change. |
| `features/chat/InputBox.tsx` | Mount `ImageThumbnails` + 📎 button. Wire `useImagePaste`. On Send include `images` and a fresh `correlationId` in `client.send`. Disable image affordances for codex sessions. |
| `features/chat/Chat.tsx` | Pass `agent` from session into InputBox. |
| `App.tsx` | Route `dirs_result` and `file_result` into `useFileExplorerStore`. New error codes route to `connection.lastError` (existing channel). |

---

## Task 1: Land Phase 3 protocol type surface (bridge + web byte-identical)

**Files:**
- Modify: `packages/bridge/src/types.ts`
- Modify: `apps/web/src/types/protocol.ts`

The two files MUST end up byte-identical. Subsequent tasks consume the new types.

- [ ] **Step 1: Replace `packages/bridge/src/types.ts` with the Phase 3 surface**

```ts
export type AgentKind = 'claude' | 'codex';

export interface ClientStartMsg {
  type: 'start';
  agent: AgentKind;
  projectPath: string;
  account?: string;
  sessionId?: string;
  resume?: boolean;
  correlationId?: string;
}

export interface ClientInputMsg {
  type: 'input';
  sessionId: string;
  text: string;
  images?: Array<{ mime: string; base64: string }>;
  correlationId?: string;
}

export interface ClientStopMsg {
  type: 'stop_session';
  sessionId: string;
  correlationId?: string;
}

export interface ClientListSessionsMsg {
  type: 'list_sessions';
  correlationId?: string;
}

export interface ClientGetHistoryMsg {
  type: 'get_history';
  sessionId: string;
  since?: number;
  correlationId?: string;
}

export interface ClientListAccountsMsg {
  type: 'list_accounts';
  correlationId?: string;
}

export interface ClientListPromptsMsg {
  type: 'list_prompts';
  query?: string;
  limit?: number;
  correlationId?: string;
}

export interface ClientListDirsMsg {
  type: 'list_dirs';
  path: string;
  correlationId?: string;
}

export interface ClientReadFileMsg {
  type: 'read_file';
  path: string;
  correlationId?: string;
}

export type ClientMsg =
  | ClientStartMsg
  | ClientInputMsg
  | ClientStopMsg
  | ClientListSessionsMsg
  | ClientGetHistoryMsg
  | ClientListAccountsMsg
  | ClientListPromptsMsg
  | ClientListDirsMsg
  | ClientReadFileMsg;

export type AgentEvent =
  | { kind: 'assistant_text'; text: string }
  | { kind: 'stream_delta'; delta: string }
  | { kind: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; output: unknown }
  | { kind: 'result'; cost?: number; durationMs?: number; error?: string };

export interface ServerInitMsg {
  type: 'system';
  event: 'init';
}

export interface ServerLifecycleMsg {
  type: 'system';
  event: 'session_created' | 'session_ended';
  sessionId: string;
  seq: number;
  agent?: AgentKind;
  projectPath?: string;
  createdAt?: number;
  account?: string;
  correlationId?: string;
  reason?: string;
  exitCode?: number;
}

export interface ServerStreamMsg {
  type: 'assistant' | 'stream_delta' | 'tool_result' | 'result' | 'status' | 'user';
  sessionId: string;
  seq: number;
  payload: unknown;
}

export interface ServerSessionListMsg {
  type: 'session_list';
  sessions: Array<{
    sessionId: string;
    agent: AgentKind;
    projectPath: string;
    createdAt: number;
    account?: string;
  }>;
  correlationId?: string;
}

export interface ServerHistoryMsg {
  type: 'history';
  sessionId: string;
  events: Array<ServerLifecycleMsg | ServerStreamMsg>;
  hasMore: boolean;
  correlationId?: string;
}

export interface ServerAccountListMsg {
  type: 'account_list';
  accounts: Array<{ name: string; agent: 'codex'; isDefault: boolean }>;
  correlationId?: string;
}

export interface ServerPromptsResultMsg {
  type: 'prompts_result';
  prompts: Array<{
    text: string;
    lastUsedAt: number;
    projectPaths: string[];
    agents: AgentKind[];
  }>;
  correlationId?: string;
}

export interface ServerDirsResultMsg {
  type: 'dirs_result';
  path: string;
  entries: Array<{ name: string; kind: 'dir' | 'file'; size?: number }>;
  correlationId?: string;
}

export interface ServerFileResultText {
  type: 'file_result';
  kind: 'text';
  path: string;
  content: string;
  bytesRead: number;
  truncated: boolean;
  correlationId?: string;
}

export interface ServerFileResultBinary {
  type: 'file_result';
  kind: 'binary';
  path: string;
  mime?: string;
  size: number;
  correlationId?: string;
}

export interface ServerFileResultTooLarge {
  type: 'file_result';
  kind: 'too_large';
  path: string;
  size: number;
  correlationId?: string;
}

export type ServerFileResultMsg =
  | ServerFileResultText
  | ServerFileResultBinary
  | ServerFileResultTooLarge;

export type ServerErrorCode =
  | 'not_authorized'
  | 'origin_mismatch'
  | 'path_outside_allowlist'
  | 'path_denied'
  | 'session_dead'
  | 'agent_not_installed'
  | 'unknown_account'
  | 'codex_session_id_missing'
  | 'message_too_large'
  | 'history_truncated'
  | 'unsupported_message'
  | 'images_not_supported_for_agent'
  | 'image_too_large'
  | 'image_invalid_mime'
  | 'too_many_images';

export interface ServerErrorMsg {
  type: 'error';
  code: ServerErrorCode;
  message: string;
  sessionId?: string;
  correlationId?: string;
}

export type ServerMsg =
  | ServerInitMsg
  | ServerLifecycleMsg
  | ServerStreamMsg
  | ServerSessionListMsg
  | ServerHistoryMsg
  | ServerAccountListMsg
  | ServerPromptsResultMsg
  | ServerDirsResultMsg
  | ServerFileResultMsg
  | ServerErrorMsg;
```

- [ ] **Step 2: Copy bridge types to web protocol.ts**

```bash
cp /Volumes/WDSSD/Code/mac-remote-terminal/packages/bridge/src/types.ts \
   /Volumes/WDSSD/Code/mac-remote-terminal/apps/web/src/types/protocol.ts
```

- [ ] **Step 3: Verify byte-identical**

```bash
diff /Volumes/WDSSD/Code/mac-remote-terminal/packages/bridge/src/types.ts \
     /Volumes/WDSSD/Code/mac-remote-terminal/apps/web/src/types/protocol.ts
```

Expected: empty diff.

- [ ] **Step 4: Verify type-checks pass on both packages**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npx tsc --noEmit -p packages/bridge/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: both clean.

- [ ] **Step 5: Run all existing tests**

```bash
npm test 2>&1 | tail -10
```

Expected: all 154+ existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/bridge/src/types.ts apps/web/src/types/protocol.ts
git commit -m "feat(types): land Phase 3 protocol surface (file-explorer + images)"
```

---

## Task 2: `fs-api.ts` — allowlist + denylist + binary detection

**Files:**
- Create: `packages/bridge/src/fs-api.ts`
- Create: `packages/bridge/src/__tests__/fs-api.test.ts`
- Create: `packages/bridge/test/fixtures/tiny.png` (1×1 PNG, 67 bytes)

- [ ] **Step 1: Generate the fixture file**

Create the 1×1 transparent PNG fixture by writing the canonical bytes:

```bash
node -e '
const fs = require("node:fs");
// 1x1 transparent PNG (minimum valid PNG)
const png = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082",
  "hex"
);
fs.mkdirSync("/Volumes/WDSSD/Code/mac-remote-terminal/packages/bridge/test/fixtures", { recursive: true });
fs.writeFileSync(
  "/Volumes/WDSSD/Code/mac-remote-terminal/packages/bridge/test/fixtures/tiny.png",
  png
);
console.log("wrote", png.length, "bytes");
'
```

Expected: prints `wrote 70 bytes` (or close — the exact byte count varies with the precise PNG, but the file is a valid 1×1 PNG).

- [ ] **Step 2: Write the failing test**

`packages/bridge/src/__tests__/fs-api.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsApi } from '../fs-api.js';

const __filename = fileURLToPath(import.meta.url);
const FIXTURE_PNG = join(dirname(__filename), '..', '..', 'test', 'fixtures', 'tiny.png');

describe('FsApi.listDirs', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mrt-fs-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists files and dirs sorted (dirs first, then files; case-insensitive)', async () => {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'README.md'), 'hi');
    writeFileSync(join(root, 'a.txt'), 'aa');

    const api = new FsApi({ allowedDirs: [root] });
    const entries = await api.listDirs(root);
    expect(entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'dir:docs',
      'dir:src',
      'file:README.md',
      'file:a.txt',
    ]);
    expect(entries.find((e) => e.name === 'a.txt')!.size).toBe(2);
  });

  it('rejects paths outside the allowlist', async () => {
    const other = mkdtempSync(join(tmpdir(), 'mrt-other-'));
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.listDirs(other)).rejects.toMatchObject({ code: 'path_outside_allowlist' });
    rmSync(other, { recursive: true, force: true });
  });

  it('rejects denylist segments at the requested path', async () => {
    mkdirSync(join(root, '.ssh'));
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.listDirs(join(root, '.ssh'))).rejects.toMatchObject({ code: 'path_denied' });
  });

  it('drops denylisted children from listings', async () => {
    mkdirSync(join(root, '.ssh'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'id_rsa'), 'fake');
    writeFileSync(join(root, 'id_rsa.PUB'), 'fake');
    writeFileSync(join(root, 'cert.PEM'), 'fake');
    writeFileSync(join(root, 'README.md'), 'hi');

    const api = new FsApi({ allowedDirs: [root] });
    const names = (await api.listDirs(root)).map((e) => e.name);
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    expect(names).not.toContain('.ssh');
    expect(names).not.toContain('id_rsa');
    expect(names).not.toContain('cert.PEM');
    // id_rsa.PUB has the prefix 'id_rsa' but the basename match is exact, so it's allowed.
    expect(names).toContain('id_rsa.PUB');
  });

  it('drops symlink children whose realpath escapes the allowlist', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mrt-out-'));
    writeFileSync(join(outside, 'secret.txt'), 'shh');
    symlinkSync(outside, join(root, 'escape'));

    const api = new FsApi({ allowedDirs: [root] });
    const names = (await api.listDirs(root)).map((e) => e.name);
    expect(names).not.toContain('escape');
    rmSync(outside, { recursive: true, force: true });
  });

  it('rejects listDirs on a regular file as path_outside_allowlist', async () => {
    writeFileSync(join(root, 'plain.txt'), 'hi');
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.listDirs(join(root, 'plain.txt'))).rejects.toMatchObject({
      code: 'path_outside_allowlist',
    });
  });
});

describe('FsApi.readFile', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mrt-fs-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns kind:text for small text files', async () => {
    writeFileSync(join(root, 'hello.txt'), 'hello world');
    const api = new FsApi({ allowedDirs: [root] });
    const r = await api.readFile(join(root, 'hello.txt'), 5_242_880);
    expect(r).toEqual({
      kind: 'text',
      content: 'hello world',
      bytesRead: 11,
      truncated: false,
    });
  });

  it('returns kind:binary for a PNG, with no content body', async () => {
    copyFileSync(FIXTURE_PNG, join(root, 'tiny.png'));
    const api = new FsApi({ allowedDirs: [root] });
    const r = await api.readFile(join(root, 'tiny.png'), 5_242_880);
    expect(r.kind).toBe('binary');
    if (r.kind === 'binary') {
      expect(r.mime).toBe('image/png');
      expect(r.size).toBeGreaterThan(0);
    }
  });

  it('returns kind:too_large when stat.size > sizeCap', async () => {
    writeFileSync(join(root, 'big.txt'), 'a'.repeat(2048));
    const api = new FsApi({ allowedDirs: [root] });
    const r = await api.readFile(join(root, 'big.txt'), 1024);
    expect(r).toEqual({ kind: 'too_large', size: 2048 });
  });

  it('rejects ENOENT as path_outside_allowlist (no existence leak)', async () => {
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.readFile(join(root, 'nope.txt'), 1024)).rejects.toMatchObject({
      code: 'path_outside_allowlist',
    });
  });

  it('rejects denylisted basenames', async () => {
    writeFileSync(join(root, 'id_rsa'), 'pretend-key');
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.readFile(join(root, 'id_rsa'), 1024)).rejects.toMatchObject({
      code: 'path_denied',
    });
  });

  it('rejects denylisted segment-runs', async () => {
    mkdirSync(join(root, '.docker'));
    writeFileSync(join(root, '.docker', 'config.json'), '{}');
    const api = new FsApi({ allowedDirs: [root] });
    await expect(api.readFile(join(root, '.docker', 'config.json'), 1024)).rejects.toMatchObject({
      code: 'path_denied',
    });
  });

  it('detects invalid-UTF8 binary content even without NUL bytes', async () => {
    // A single 0xFF byte is invalid UTF-8 (no NUL to short-circuit on). The
    // TextDecoder fatal:true gate must catch it; the legacy heuristic that
    // treated b >= 0x80 as printable would mislabel this as text.
    writeFileSync(join(root, 'latin1.bin'), Buffer.from([0xff, 0xfe, 0xfd]));
    const api = new FsApi({ allowedDirs: [root] });
    const r = await api.readFile(join(root, 'latin1.bin'), 1024);
    expect(r.kind).toBe('binary');
  });
});
```

- [ ] **Step 3: Run test — expect FAIL (module not found)**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run bridge:test -- fs-api
```

Expected: FAIL.

- [ ] **Step 4: Implement `packages/bridge/src/fs-api.ts`**

```ts
import { realpath as fsRealpath, readdir, readFile as fsReadFile, stat, open } from 'node:fs/promises';
import { sep } from 'node:path';

const DENIED_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.gnupg-keys',
  '.kube',
]);

const DENIED_SEGMENT_RUNS: ReadonlyArray<readonly string[]> = [
  ['.config', 'op'],
  ['.config', 'keys'],
  ['.docker', 'config.json'],
  ['Library', 'Keychains'],
  ['Library', 'Cookies'],
];

const DENIED_BASENAMES_CI: ReadonlySet<string> = new Set([
  '.netrc',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
]);

const DENIED_BASENAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^.+\.pem$/i,
  /^.+\.key$/i,
  /^.+\.p12$/i,
  /^.+\.pfx$/i,
];

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
};

export interface FsApiOpts {
  allowedDirs: string[];
}

export interface DirEntry {
  name: string;
  kind: 'dir' | 'file';
  size?: number;
}

export type FileResult =
  | { kind: 'text'; content: string; bytesRead: number; truncated: boolean }
  | { kind: 'binary'; mime?: string; size: number }
  | { kind: 'too_large'; size: number };

export class FsAccessError extends Error {
  constructor(public code: 'path_outside_allowlist' | 'path_denied', message: string) {
    super(message);
  }
}

function splitSegments(p: string): string[] {
  return p.split(sep).filter((s) => s.length > 0);
}

function basenameOf(p: string): string {
  const segs = splitSegments(p);
  return segs[segs.length - 1] ?? '';
}

function pathHitsDenylist(resolved: string): boolean {
  const segs = splitSegments(resolved);
  for (const s of segs) {
    if (DENIED_PATH_SEGMENTS.has(s)) return true;
  }
  for (const run of DENIED_SEGMENT_RUNS) {
    for (let i = 0; i + run.length <= segs.length; i++) {
      let match = true;
      for (let j = 0; j < run.length; j++) {
        if (segs[i + j] !== run[j]) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }
  }
  const base = basenameOf(resolved);
  if (DENIED_BASENAMES_CI.has(base.toLowerCase())) return true;
  for (const re of DENIED_BASENAME_PATTERNS) {
    if (re.test(base)) return true;
  }
  return false;
}

function isInsideAllowed(resolved: string, allowedDirs: string[]): boolean {
  return allowedDirs.some((d) => resolved === d || resolved.startsWith(d + sep));
}

function looksBinary(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  // 1. NUL byte → definitely binary.
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x00) return true;
  }
  // 2. Try strict UTF-8 decode. Any malformed sequence (e.g. Latin-1 tail
  //    bytes that don't form a valid UTF-8 multi-byte sequence) → binary.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return true;
  }
  // 3. Valid UTF-8, but might still be unprintable control chars
  //    (e.g. some structured-binary formats coincidentally happen to be
  //    valid UTF-8). Count low-range control bytes that aren't tab / LF / CR.
  let nonPrintable = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    const isWhitespace = b === 0x09 || b === 0x0a || b === 0x0d;
    const isPrintableAscii = b >= 0x20 && b <= 0x7e;
    const isMultibyteUtf8Lead = b >= 0x80; // already validated by step 2
    if (!isWhitespace && !isPrintableAscii && !isMultibyteUtf8Lead) {
      nonPrintable++;
    }
  }
  return nonPrintable * 20 > buf.length; // > 5 % non-printable
}

function guessMime(path: string): string | undefined {
  const base = basenameOf(path);
  const dot = base.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext];
}

export class FsApi {
  private readonly allowedDirs: string[];

  constructor(opts: FsApiOpts) {
    this.allowedDirs = opts.allowedDirs;
  }

  private async resolveAndGate(path: string): Promise<string> {
    let resolved: string;
    try {
      resolved = await fsRealpath(path);
    } catch {
      throw new FsAccessError('path_outside_allowlist', `cannot resolve ${path}`);
    }
    if (!isInsideAllowed(resolved, this.allowedDirs)) {
      throw new FsAccessError('path_outside_allowlist', `${resolved} is not in allowed dirs`);
    }
    if (pathHitsDenylist(resolved)) {
      throw new FsAccessError('path_denied', `${resolved} hits the FS denylist`);
    }
    return resolved;
  }

  async listDirs(path: string): Promise<DirEntry[]> {
    const resolved = await this.resolveAndGate(path);
    let st;
    try {
      st = await stat(resolved);
    } catch {
      throw new FsAccessError('path_outside_allowlist', `cannot stat ${resolved}`);
    }
    if (!st.isDirectory()) {
      throw new FsAccessError('path_outside_allowlist', `${resolved} is not a directory`);
    }
    const dirents = await readdir(resolved, { withFileTypes: true });
    const out: DirEntry[] = [];
    for (const d of dirents) {
      const childRaw = resolved + sep + d.name;
      let childResolved: string;
      try {
        childResolved = await fsRealpath(childRaw);
      } catch {
        continue; // dangling symlink etc — skip silently
      }
      if (!isInsideAllowed(childResolved, this.allowedDirs)) continue;
      if (pathHitsDenylist(childResolved)) continue;

      const isDir = d.isDirectory() || (d.isSymbolicLink() && (await safeIsDir(childResolved)));
      if (isDir) {
        out.push({ name: d.name, kind: 'dir' });
      } else {
        let size: number | undefined;
        try {
          size = (await stat(childResolved)).size;
        } catch {
          size = undefined;
        }
        out.push({ name: d.name, kind: 'file', ...(size !== undefined ? { size } : {}) });
      }
    }
    out.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return out;
  }

  async readFile(path: string, sizeCap: number): Promise<FileResult> {
    const resolved = await this.resolveAndGate(path);
    let st;
    try {
      st = await stat(resolved);
    } catch {
      throw new FsAccessError('path_outside_allowlist', `cannot stat ${resolved}`);
    }
    if (!st.isFile()) {
      throw new FsAccessError('path_outside_allowlist', `${resolved} is not a regular file`);
    }
    if (st.size > sizeCap) {
      return { kind: 'too_large', size: st.size };
    }
    const fh = await open(resolved, 'r');
    try {
      const head = Buffer.alloc(Math.min(8192, st.size));
      if (head.length > 0) await fh.read(head, 0, head.length, 0);
      if (looksBinary(head)) {
        return { kind: 'binary', size: st.size, ...(guessMime(resolved) ? { mime: guessMime(resolved)! } : {}) };
      }
    } finally {
      await fh.close();
    }
    const content = await fsReadFile(resolved, 'utf8');
    return { kind: 'text', content, bytesRead: Buffer.byteLength(content, 'utf8'), truncated: false };
  }
}

async function safeIsDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run test — expect PASS**

```bash
npm run bridge:test -- fs-api
```

Expected: 13 passed.

- [ ] **Step 6: Commit**

```bash
git add packages/bridge/src/fs-api.ts packages/bridge/src/__tests__/fs-api.test.ts packages/bridge/test/fixtures/tiny.png
git commit -m "feat(bridge): add FsApi with allowlist + denylist + binary detection"
```

---

## Task 3: `image-store.ts` — validate + audit-copy + cleanup

**Files:**
- Create: `packages/bridge/src/image-store.ts`
- Create: `packages/bridge/src/__tests__/image-store.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/image-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageStore } from '../image-store.js';

const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex');

function tinyPngBase64(): string {
  return Buffer.concat([PNG_HEADER, Buffer.alloc(60)]).toString('base64');
}

describe('ImageStore.validate', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mrt-img-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('accepts up to 4 valid Claude images', () => {
    const store = new ImageStore({ dataDir });
    const images = Array.from({ length: 4 }, () => ({ mime: 'image/png', base64: tinyPngBase64() }));
    expect(store.validate(images, 'claude')).toEqual({ ok: true });
  });

  it('rejects images on a codex session', () => {
    const store = new ImageStore({ dataDir });
    const images = [{ mime: 'image/png', base64: tinyPngBase64() }];
    expect(store.validate(images, 'codex')).toEqual({
      ok: false,
      error: 'images_not_supported_for_agent',
    });
  });

  it('rejects > 4 images', () => {
    const store = new ImageStore({ dataDir });
    const images = Array.from({ length: 5 }, () => ({ mime: 'image/png', base64: tinyPngBase64() }));
    expect(store.validate(images, 'claude')).toEqual({ ok: false, error: 'too_many_images' });
  });

  it('rejects unknown MIME', () => {
    const store = new ImageStore({ dataDir });
    expect(
      store.validate([{ mime: 'image/svg+xml', base64: tinyPngBase64() }], 'claude'),
    ).toEqual({ ok: false, error: 'image_invalid_mime' });
  });

  it('rejects images > 10 MB decoded', () => {
    const store = new ImageStore({ dataDir });
    // 11 MB base64 is ~14.6 MB encoded, decodes to 11 MB
    const big = Buffer.alloc(11 * 1024 * 1024).toString('base64');
    expect(store.validate([{ mime: 'image/png', base64: big }], 'claude')).toEqual({
      ok: false,
      error: 'image_too_large',
    });
  });
});

describe('ImageStore.writeAuditCopy / cleanup', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mrt-img-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes one file per image with mode 0600 in a 0700 dir', async () => {
    const store = new ImageStore({ dataDir });
    const sessionId = 'sess-1';
    await store.writeAuditCopy(sessionId, [
      { mime: 'image/png', base64: tinyPngBase64() },
      { mime: 'image/jpeg', base64: 'AAEC' },
    ]);
    const dir = join(dataDir, 'images', sessionId);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const entries = readdirSync(dir);
    expect(entries.length).toBe(2);
    for (const name of entries) {
      const p = join(dir, name);
      expect(statSync(p).mode & 0o777).toBe(0o600);
    }
    expect(entries.some((n) => n.endsWith('.png'))).toBe(true);
    expect(entries.some((n) => n.endsWith('.jpg') || n.endsWith('.jpeg'))).toBe(true);
  });

  it('cleanup removes the per-session directory', async () => {
    const store = new ImageStore({ dataDir });
    await store.writeAuditCopy('sess-1', [{ mime: 'image/png', base64: tinyPngBase64() }]);
    const dir = join(dataDir, 'images', 'sess-1');
    expect(existsSync(dir)).toBe(true);
    await store.cleanup('sess-1');
    expect(existsSync(dir)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run bridge:test -- image-store
```

- [ ] **Step 3: Implement `packages/bridge/src/image-store.ts`**

```ts
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentKind, ServerErrorCode } from './types.js';

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const MAX_IMAGES = 4;
const MAX_BYTES_PER_IMAGE = 10 * 1024 * 1024;

export interface RawImage {
  mime: string;
  base64: string;
}

export interface ImageStoreOpts {
  dataDir: string;
}

export type ValidateResult = { ok: true } | { ok: false; error: ServerErrorCode };

function decodedBytes(base64: string): number {
  // 4 base64 chars encode 3 raw bytes. Subtract 1 byte per '=' padding.
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export class ImageStore {
  private readonly dataDir: string;

  constructor(opts: ImageStoreOpts) {
    this.dataDir = opts.dataDir;
  }

  validate(images: RawImage[] | undefined, agent: AgentKind): ValidateResult {
    if (!images || images.length === 0) return { ok: true };
    if (agent !== 'claude') return { ok: false, error: 'images_not_supported_for_agent' };
    if (images.length > MAX_IMAGES) return { ok: false, error: 'too_many_images' };
    for (const img of images) {
      if (!MIME_TO_EXT[img.mime]) return { ok: false, error: 'image_invalid_mime' };
      if (decodedBytes(img.base64) > MAX_BYTES_PER_IMAGE) {
        return { ok: false, error: 'image_too_large' };
      }
    }
    return { ok: true };
  }

  async writeAuditCopy(sessionId: string, images: RawImage[]): Promise<void> {
    if (images.length === 0) return;
    const dir = join(this.dataDir, 'images', sessionId);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      console.warn(`[image-store] mkdir(${dir}) failed: ${(err as Error).message}`);
      return;
    }
    for (const img of images) {
      const ext = MIME_TO_EXT[img.mime] ?? 'bin';
      const path = join(dir, `${randomUUID()}.${ext}`);
      try {
        await writeFile(path, Buffer.from(img.base64, 'base64'), { mode: 0o600 });
      } catch (err) {
        console.warn(`[image-store] write(${path}) failed: ${(err as Error).message}`);
      }
    }
  }

  async cleanup(sessionId: string): Promise<void> {
    const dir = join(this.dataDir, 'images', sessionId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[image-store] cleanup(${dir}) failed: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run bridge:test -- image-store
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/image-store.ts packages/bridge/src/__tests__/image-store.test.ts
git commit -m "feat(bridge): add ImageStore with validation + audit copy + cleanup"
```

---

## Task 4: SessionManager + ClaudeProcess accept images

**Files:**
- Modify: `packages/bridge/src/session.ts`
- Modify: `packages/bridge/src/claude-process.ts`
- Modify: `packages/bridge/src/codex-process.ts`
- Modify: `packages/bridge/src/__tests__/session.test.ts`
- Modify: `packages/bridge/src/__tests__/claude-process.test.ts`

This task extends the driver interface so `sendUserText` accepts an optional `images` argument and SessionManager schedules the audit copy.

- [ ] **Step 1: Update `AgentDriver.sendUserText` signature in `session.ts`**

In `packages/bridge/src/session.ts`, locate the `AgentDriver` interface and change:

```ts
export interface AgentDriver extends EventEmitter {
  sendUserText(text: string): void;
  kill(): void;
}
```

to:

```ts
export interface AgentDriver extends EventEmitter {
  sendUserText(text: string, images?: ReadonlyArray<{ mime: string; base64: string }>): void;
  kill(): void;
}
```

- [ ] **Step 2: Add `imageStore` to `SessionManagerOpts` and field**

Add the import at the top of `session.ts`:

```ts
import type { ImageStore } from './image-store.js';
```

Add `imageStore?: ImageStore` to `SessionManagerOpts`. Add field + assignment in constructor:

```ts
private readonly imageStore: ImageStore | undefined;
// in constructor body:
this.imageStore = opts.imageStore;
```

- [ ] **Step 3: Update `sendInput` to accept images and schedule audit copy**

Replace the existing `sendInput` method body with:

```ts
sendInput(
  sessionId: string,
  text: string,
  images?: ReadonlyArray<{ mime: string; base64: string }>,
): void {
  const s = this.sessions.get(sessionId);
  if (!s || !s.alive) throw new SessionDeadError(sessionId);
  this.appendAndBroadcast(s, {
    type: 'user',
    sessionId,
    seq: s.nextSeq++,
    payload: { text, ...(images && images.length > 0 ? { imageCount: images.length } : {}) },
  });
  this.promptStore?.add({ text, projectPath: s.projectPath, agent: s.agent });
  s.proc.sendUserText(text, images);
  // Fire-and-forget audit copy (Phase 3 §6 ordering). Errors are logged inside
  // ImageStore; never block delivery.
  if (this.imageStore && images && images.length > 0) {
    void this.imageStore
      .writeAuditCopy(sessionId, images.slice())
      .catch((err) => console.warn('[image-audit]', err));
  }
}
```

- [ ] **Step 4: Update `onProcExit` to clean up image audit dir**

Locate `onProcExit` and add an `imageStore.cleanup` call alongside `transcriptStore.close`:

```ts
this.transcriptStore?.close(s.sessionId);
void this.imageStore?.cleanup(s.sessionId).catch((err) =>
  console.warn('[image-audit] cleanup', err),
);
```

- [ ] **Step 5: Update `claude-process.ts` to embed images in stream-json**

In `packages/bridge/src/claude-process.ts`, replace the `sendUserText` method:

```ts
sendUserText(text: string, images?: ReadonlyArray<{ mime: string; base64: string }>): void {
  const content: Array<unknown> = [{ type: 'text', text }];
  if (images) {
    for (const img of images) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mime, data: img.base64 },
      });
    }
  }
  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
  }) + '\n';
  this.child.stdin.write(line);
}
```

- [ ] **Step 6: Update `codex-process.ts` to accept (and ignore) images**

In `packages/bridge/src/codex-process.ts`, change the `sendUserText` signature so `CodexProcess` matches the `AgentDriver` interface. Locate the existing method:

```ts
sendUserText(text: string): void {
```

Change to:

```ts
sendUserText(text: string, _images?: ReadonlyArray<{ mime: string; base64: string }>): void {
```

The body is unchanged — Codex never receives images because SessionManager rejects them at validation time, but the type signature must match `AgentDriver`.

- [ ] **Step 7: Add a session.test.ts case for image audit-copy scheduling**

Append to `packages/bridge/src/__tests__/session.test.ts` inside the `describe('SessionManager', ...)` block:

```ts
  it('schedules ImageStore.writeAuditCopy as a fire-and-forget after sendInput', async () => {
    const procs: FakeProc[] = [];
    const auditCalls: Array<{ id: string; n: number }> = [];
    const fakeImageStore = {
      validate: () => ({ ok: true as const }),
      writeAuditCopy: async (id: string, imgs: unknown[]) => {
        auditCalls.push({ id, n: imgs.length });
      },
      cleanup: async () => {},
    };
    const mgr = new SessionManager({
      allowedDirs: ['/Users/test'],
      bufferCap: 100,
      driverFactory: () => {
        const p = new FakeProc();
        procs.push(p);
        return p as unknown as import('../session.js').AgentDriver;
      },
      realpath: async (p) => p,
      imageStore: fakeImageStore as unknown as import('../image-store.js').ImageStore,
    });
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    mgr.sendInput(s.sessionId, 'hi', [{ mime: 'image/png', base64: 'AA==' }]);
    // sendInput returns synchronously; audit copy was scheduled.
    await new Promise((r) => setImmediate(r));
    expect(auditCalls).toEqual([{ id: s.sessionId, n: 1 }]);
  });

  it('forwards images to the driver via proc.sendUserText', async () => {
    const procs: FakeProc[] = [];
    const mgr = new SessionManager({
      allowedDirs: ['/Users/test'],
      bufferCap: 100,
      driverFactory: () => {
        const p = new FakeProc();
        procs.push(p);
        return p as unknown as import('../session.js').AgentDriver;
      },
      realpath: async (p) => p,
    });
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    mgr.sendInput(s.sessionId, 'hi', [{ mime: 'image/png', base64: 'AAA=' }]);
    expect(procs[0]!.sentText).toEqual(['hi']);
    expect(procs[0]!.sentImages).toEqual([[{ mime: 'image/png', base64: 'AAA=' }]]);
  });
```

Also update the `FakeProc` class earlier in the test file so it captures `images`:

```ts
class FakeProc extends EventEmitter {
  killed = false;
  sentText: string[] = [];
  sentImages: Array<ReadonlyArray<{ mime: string; base64: string }> | undefined> = [];
  sendUserText(s: string, images?: ReadonlyArray<{ mime: string; base64: string }>) {
    this.sentText.push(s);
    this.sentImages.push(images);
  }
  kill() { this.killed = true; this.emit('exit', 0); }
  emitEvent(e: AgentEvent) { this.emit('event', e); }
}
```

- [ ] **Step 8: Add a claude-process.test.ts case asserting image stream-json shape**

Append to `packages/bridge/src/__tests__/claude-process.test.ts`:

```ts
  it('embeds image content blocks alongside text in the user message', () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });
    proc.sendUserText('look at this', [
      { mime: 'image/png', base64: 'PNGDATA' },
      { mime: 'image/jpeg', base64: 'JPGDATA' },
    ]);
    expect(fakes.stdinWrites.length).toBe(1);
    const written = JSON.parse(fakes.stdinWrites[0]!.trimEnd()) as {
      type: string;
      message: {
        role: string;
        content: Array<
          | { type: 'text'; text: string }
          | { type: 'image'; source: { type: string; media_type: string; data: string } }
        >;
      };
    };
    expect(written.type).toBe('user');
    expect(written.message.content).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PNGDATA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'JPGDATA' } },
    ]);
  });
```

- [ ] **Step 9: Run all bridge tests**

```bash
npm run bridge:test
```

Expected: all existing tests still pass plus 3 new ones (1 fire-and-forget, 1 forward-to-driver, 1 stream-json shape).

- [ ] **Step 10: Type-check**

```bash
npx tsc --noEmit -p packages/bridge/tsconfig.json
```

Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add packages/bridge/src/session.ts packages/bridge/src/claude-process.ts packages/bridge/src/codex-process.ts packages/bridge/src/__tests__/session.test.ts packages/bridge/src/__tests__/claude-process.test.ts
git commit -m "feat(bridge): SessionManager + ClaudeProcess accept and audit-copy images"
```

---

## Task 5: WebSocket routes — list_dirs, read_file, image-validation in input

**Files:**
- Modify: `packages/bridge/src/websocket.ts`
- Modify: `packages/bridge/src/__tests__/websocket.test.ts`

- [ ] **Step 1: Add tests for the new routes and image validation**

Append to `packages/bridge/src/__tests__/websocket.test.ts` inside the `describe('websocket', ...)` block:

```ts
  it('list_dirs replies with dirs_result on a happy path', async () => {
    const fakeFsApi = {
      listDirs: async (_path: string) => [
        { name: 'src', kind: 'dir' as const },
        { name: 'README.md', kind: 'file' as const, size: 42 },
      ],
      readFile: async () => ({ kind: 'text' as const, content: '', bytesRead: 0, truncated: false }),
    };
    const { port, close } = await startServer({ fsApi: fakeFsApi });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{ type: string; entries: unknown[]; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'dirs_result') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'list_dirs', path: '/Users/test/proj', correlationId: 'cd' }));
    const msg = await got;
    expect(msg.entries).toHaveLength(2);
    expect(msg.correlationId).toBe('cd');
    sock.close();
    await close();
  });

  it('list_dirs propagates path_outside_allowlist errors with correlationId', async () => {
    const fakeFsApi = {
      listDirs: async () => {
        const e = new Error('outside') as Error & { code?: string };
        e.code = 'path_outside_allowlist';
        throw e;
      },
      readFile: async () => ({ kind: 'text' as const, content: '', bytesRead: 0, truncated: false }),
    };
    const { port, close } = await startServer({ fsApi: fakeFsApi });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{ type: string; code?: string; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'error') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'list_dirs', path: '/etc', correlationId: 'cx' }));
    const m = await got;
    expect(m.code).toBe('path_outside_allowlist');
    expect(m.correlationId).toBe('cx');
    sock.close();
    await close();
  });

  it('read_file replies with file_result of the right kind', async () => {
    const fakeFsApi = {
      listDirs: async () => [],
      readFile: async (_path: string, _cap: number) => ({
        kind: 'text' as const,
        content: 'hello',
        bytesRead: 5,
        truncated: false,
      }),
    };
    const { port, close } = await startServer({ fsApi: fakeFsApi });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{ type: string; kind?: string; content?: string; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'file_result') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'read_file', path: '/Users/test/proj/README.md', correlationId: 'cf' }));
    const m = await got;
    expect(m.kind).toBe('text');
    expect(m.content).toBe('hello');
    expect(m.correlationId).toBe('cf');
    sock.close();
    await close();
  });

  it('input with codex session and images replies images_not_supported_for_agent', async () => {
    const fakeImageStore = {
      validate: (_imgs: unknown, agent: string) =>
        agent === 'codex'
          ? { ok: false, error: 'images_not_supported_for_agent' as const }
          : { ok: true as const },
      writeAuditCopy: async () => {},
      cleanup: async () => {},
    };
    const accounts = new Map([
      ['default', { name: 'default', codexHome: '/Users/test/.codex', isDefault: true }],
    ]);
    const { port, mgr, close } = await startServer({ accounts, imageStore: fakeImageStore });
    const session = await mgr.create({ agent: 'codex', projectPath: '/Users/test/proj' });
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message');
    const got = new Promise<{ type: string; code?: string; sessionId?: string; correlationId?: string }>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'error') r(m);
      });
    });
    sock.send(
      JSON.stringify({
        type: 'input',
        sessionId: session.sessionId,
        text: 'hi',
        images: [{ mime: 'image/png', base64: 'AAA=' }],
        correlationId: 'ci',
      }),
    );
    const m = await got;
    expect(m.code).toBe('images_not_supported_for_agent');
    expect(m.sessionId).toBe(session.sessionId);
    expect(m.correlationId).toBe('ci');
    sock.close();
    await close();
  });
```

Update the existing `startServer` helper to accept `fsApi` and `imageStore`:

```ts
async function startServer(opts: {
  accounts?: Map<string, import('../accounts.js').CodexAccount>;
  fsApi?: import('../fs-api.js').FsApi;
  imageStore?: import('../image-store.js').ImageStore;
} = {}) {
  // ...existing setup...
  const accounts = opts.accounts ?? new Map();
  const fsApi =
    opts.fsApi ??
    ({
      listDirs: async () => [],
      readFile: async () => ({ kind: 'text' as const, content: '', bytesRead: 0, truncated: false }),
    } as unknown as import('../fs-api.js').FsApi);
  const imageStore =
    opts.imageStore ??
    ({
      validate: () => ({ ok: true as const }),
      writeAuditCopy: async () => {},
      cleanup: async () => {},
    } as unknown as import('../image-store.js').ImageStore);

  const mgr = new SessionManager({
    /* ...existing... */
    imageStore,
  });
  const server = createServer();
  attachWebSocket({
    server,
    token: TOKEN,
    sessionManager: mgr,
    accounts,
    fsApi,
    imageStore,
    promptStore: undefined,
  });
  /* ...existing return... */
}
```

(The `mgr` constructor call retains all Phase 1/2 fields plus the new `imageStore`.)

- [ ] **Step 2: Run test — expect FAIL on the new ones**

```bash
npm run bridge:test -- websocket
```

- [ ] **Step 3: Update `packages/bridge/src/websocket.ts`**

Add the imports:

```ts
import type { FsApi } from './fs-api.js';
import type { ImageStore } from './image-store.js';
```

Update `AttachWsOpts`:

```ts
export interface AttachWsOpts {
  server: HttpServer;
  token: string;
  sessionManager: SessionManager;
  accounts: Map<string, CodexAccount>;
  promptStore?: PromptStore;
  fsApi: FsApi;
  imageStore: ImageStore;
}
```

Bump the message size constant near the top of the file:

```ts
const MAX_MSG_BYTES = 64 * 1024 * 1024; // bumped from 16 MB to fit 4×10MB image batch (base64 ~= 52 MB)
```

Add `fsApi` and `imageStore` parameters to `handleMessage`. In `attachWebSocket`, plumb through:

```ts
ws.on('message', (raw) => {
  void handleMessage(ws, raw, opts.sessionManager, send, opts.accounts, opts.promptStore, opts.fsApi, opts.imageStore);
});
```

Update `handleMessage`'s signature accordingly. Inside the `switch (msg.type)` block, add three new cases (BEFORE the `default`):

```ts
      case 'list_dirs': {
        try {
          const entries = await fsApi.listDirs(msg.path);
          send({
            type: 'dirs_result',
            path: msg.path,
            entries,
            ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
          });
        } catch (err) {
          const e = err as { code?: 'path_outside_allowlist' | 'path_denied' };
          if (e.code === 'path_outside_allowlist' || e.code === 'path_denied') {
            sendError(send, e.code, (err as Error).message, msg.correlationId);
          } else {
            sendError(send, 'unsupported_message', (err as Error).message, msg.correlationId);
          }
        }
        return;
      }
      case 'read_file': {
        try {
          const result = await fsApi.readFile(msg.path, 5 * 1024 * 1024);
          if (result.kind === 'text') {
            send({
              type: 'file_result',
              kind: 'text',
              path: msg.path,
              content: result.content,
              bytesRead: result.bytesRead,
              truncated: result.truncated,
              ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
            });
          } else if (result.kind === 'binary') {
            send({
              type: 'file_result',
              kind: 'binary',
              path: msg.path,
              size: result.size,
              ...(result.mime ? { mime: result.mime } : {}),
              ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
            });
          } else {
            send({
              type: 'file_result',
              kind: 'too_large',
              path: msg.path,
              size: result.size,
              ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
            });
          }
        } catch (err) {
          const e = err as { code?: 'path_outside_allowlist' | 'path_denied' };
          if (e.code === 'path_outside_allowlist' || e.code === 'path_denied') {
            sendError(send, e.code, (err as Error).message, msg.correlationId);
          } else {
            sendError(send, 'unsupported_message', (err as Error).message, msg.correlationId);
          }
        }
        return;
      }
```

Update the existing `case 'input':` to validate images before forwarding:

```ts
      case 'input': {
        const session = mgr.knowsSession(msg.sessionId)
          ? mgr.listSessions().find((s) => s.sessionId === msg.sessionId)
          : undefined;
        if (msg.images && msg.images.length > 0) {
          const agent = session?.agent;
          if (!agent) {
            sendError(send, 'session_dead', `session ${msg.sessionId} not alive`, msg.correlationId, msg.sessionId);
            return;
          }
          const v = imageStore.validate(msg.images, agent);
          if (!v.ok) {
            sendError(send, v.error, errorMessageFor(v.error), msg.correlationId, msg.sessionId);
            return;
          }
        }
        try {
          mgr.sendInput(msg.sessionId, msg.text, msg.images);
        } catch (err) {
          const e = err as { code?: string; message?: string };
          if (e.code === 'session_dead') {
            sendError(send, 'session_dead', e.message ?? 'session dead', msg.correlationId, msg.sessionId);
            return;
          }
          throw err;
        }
        return;
      }
```

Add the `errorMessageFor` helper near `sendError` at the bottom of the file:

```ts
function errorMessageFor(code: ServerErrorMsg['code']): string {
  switch (code) {
    case 'images_not_supported_for_agent':
      return 'Codex sessions do not accept images.';
    case 'too_many_images':
      return 'At most 4 images per message.';
    case 'image_too_large':
      return 'Each image must be ≤ 10 MB after decoding.';
    case 'image_invalid_mime':
      return 'Allowed image MIME types: image/png, image/jpeg, image/webp, image/gif.';
    default:
      return code;
  }
}
```

- [ ] **Step 4: Update existing tests that break under the new shape**

Two pre-existing tests in `websocket.test.ts` need updating because of Task 4's `AgentDriver.sendUserText(text, images?)` signature change and Task 5's `AttachWsOpts` now requiring `fsApi` + `imageStore`:

(a) The existing test `'routes input → process.sendUserText'` uses `expect(procs[0]!.sendUserText).toHaveBeenCalledWith('hello');`. With the new signature, the route forwards `(text, images)` — the second arg is `undefined` when no images. Update the assertion to accept the new arity:

```ts
expect(procs[0]!.sendUserText).toHaveBeenCalledWith('hello', undefined);
```

(b) The existing test `'list_prompts replies with the PromptStore contents'` constructs its own `attachWebSocket(...)` directly (not through `startServer`). Update that direct call to pass the new required fields:

Find:
```ts
attachWebSocket({ server, token: TOKEN, sessionManager: mgr, accounts: new Map(), promptStore: fakePromptStore });
```

Replace with:
```ts
const fakeFsApi = {
  listDirs: async () => [],
  readFile: async () => ({ kind: 'text' as const, content: '', bytesRead: 0, truncated: false }),
} as unknown as import('../fs-api.js').FsApi;
const fakeImageStore = {
  validate: () => ({ ok: true as const }),
  writeAuditCopy: async () => {},
  cleanup: async () => {},
} as unknown as import('../image-store.js').ImageStore;
attachWebSocket({
  server,
  token: TOKEN,
  sessionManager: mgr,
  accounts: new Map(),
  promptStore: fakePromptStore,
  fsApi: fakeFsApi,
  imageStore: fakeImageStore,
});
```

- [ ] **Step 5: Run tests + typecheck**

```bash
npm run bridge:test
npx tsc --noEmit -p packages/bridge/tsconfig.json
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/bridge/src/websocket.ts packages/bridge/src/__tests__/websocket.test.ts
git commit -m "feat(bridge): add list_dirs/read_file routes and image validation in input"
```

---

## Task 6: CSP polish + maxPayload bump in `http-server.ts`

**Files:**
- Modify: `packages/bridge/src/http-server.ts`
- Modify: `packages/bridge/src/__tests__/http-server.test.ts`

The `MAX_MSG_BYTES` bump in `websocket.ts` happened in Task 5; this task only handles the HTTP-side header polish.

- [ ] **Step 1: Add new test cases to `http-server.test.ts`**

Append inside the `describe('http-server', ...)` block:

```ts
  it('CSP includes connect-src with self + ws/wss, frame-ancestors none, img-src data/blob', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("connect-src 'self' ws: wss:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("img-src 'self' data: blob:");
    await close();
  });

  it('Permissions-Policy locks down camera/microphone/geolocation/payment/usb', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    const pp = res.headers.get('permissions-policy') ?? '';
    expect(pp).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    await close();
  });
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run bridge:test -- http-server
```

- [ ] **Step 3: Update `SECURITY_HEADERS` in `http-server.ts`**

Locate the `SECURITY_HEADERS` constant and replace it with:

```ts
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self' ws: wss:; " +
    "frame-ancestors 'none'",
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run bridge:test -- http-server
```

Expected: 17 passed (15 prior + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/http-server.ts packages/bridge/src/__tests__/http-server.test.ts
git commit -m "feat(bridge): tighten CSP + add Permissions-Policy"
```

---

## Task 7: Boot wiring in `index.ts`

**Files:**
- Modify: `packages/bridge/src/index.ts`

- [ ] **Step 1: Update `index.ts` to construct and wire FsApi + ImageStore**

Add imports near the top:

```ts
import { FsApi } from './fs-api.js';
import { ImageStore } from './image-store.js';
```

Inside `main()`, after the existing `transcriptStore` and `promptStore` instantiations, add:

```ts
const fsApi = new FsApi({ allowedDirs: cfg.allowedDirs });
const imageStore = new ImageStore({ dataDir: cfg.dataDir });
```

Update the `SessionManager` construction to include `imageStore`:

```ts
const sessionManager = new SessionManager({
  allowedDirs: cfg.allowedDirs,
  bufferCap: 1000,
  driverFactory,
  transcriptStore,
  promptStore,
  imageStore,
  accounts,
});
```

Update `attachWebSocket(...)` to include both `fsApi` and `imageStore`:

```ts
attachWebSocket({
  server,
  token: cfg.token,
  sessionManager,
  accounts,
  promptStore,
  fsApi,
  imageStore,
});
```

- [ ] **Step 2: Run typecheck + bridge tests**

```bash
npx tsc --noEmit -p packages/bridge/tsconfig.json
npm run bridge:test
```

Expected: clean + all tests pass.

- [ ] **Step 3: Smoke-boot to confirm wiring works**

```bash
unset BRIDGE_TOKEN
timeout 4 npm run bridge:dev 2>&1 | head -8 || true
```

Expected: error mentioning `BRIDGE_TOKEN` (fail-fast preserved).

```bash
BRIDGE_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))') \
BRIDGE_BIND_HOST=127.0.0.1 \
timeout 4 npm run bridge:dev 2>&1 | head -10 || true
```

Expected: log lines including `[bridge] loaded N codex account(s)` and `[bridge] binding to 127.0.0.1:8765`.

- [ ] **Step 4: Commit**

```bash
git add packages/bridge/src/index.ts
git commit -m "feat(bridge): wire FsApi + ImageStore into boot"
```

---

## Task 8: Web `store/file-explorer.ts`

**Files:**
- Create: `apps/web/src/store/file-explorer.ts`
- Create: `apps/web/src/store/file-explorer.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/src/store/file-explorer.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useFileExplorerStore } from './file-explorer';
import type { ServerDirsResultMsg, ServerFileResultMsg } from '../types/protocol';

beforeEach(() => {
  useFileExplorerStore.setState({
    dirs: {},
    expanded: {},
    loadingPaths: {},
    selectedFile: null,
  });
});

describe('file-explorer store', () => {
  it('applyDirsResult caches entries by path and clears loading', () => {
    useFileExplorerStore.setState({ loadingPaths: { '/p': true } });
    const msg: ServerDirsResultMsg = {
      type: 'dirs_result',
      path: '/p',
      entries: [
        { name: 'src', kind: 'dir' },
        { name: 'a.txt', kind: 'file', size: 12 },
      ],
    };
    useFileExplorerStore.getState().applyDirsResult(msg);
    const s = useFileExplorerStore.getState();
    expect(s.dirs['/p']!.length).toBe(2);
    expect(s.loadingPaths['/p']).toBeUndefined();
    expect(s.expanded['/p']).toBe(true);
  });

  it('toggleExpand collapses an expanded path', () => {
    useFileExplorerStore.setState({ expanded: { '/p': true } });
    useFileExplorerStore.getState().toggleExpand('/p');
    expect(useFileExplorerStore.getState().expanded['/p']).toBeUndefined();
  });

  it('requestDirs calls client.send with list_dirs and tracks loading', () => {
    const client = { send: vi.fn() };
    useFileExplorerStore.getState().requestDirs(client as unknown as { send: (m: unknown) => void }, '/p');
    expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'list_dirs', path: '/p' }));
    expect(useFileExplorerStore.getState().loadingPaths['/p']).toBe(true);
  });

  it('applyFileResult sets selectedFile to text', () => {
    const msg: ServerFileResultMsg = {
      type: 'file_result',
      kind: 'text',
      path: '/p/file.txt',
      content: 'hello',
      bytesRead: 5,
      truncated: false,
    };
    useFileExplorerStore.getState().applyFileResult(msg);
    expect(useFileExplorerStore.getState().selectedFile).toEqual({
      state: 'text',
      path: '/p/file.txt',
      content: 'hello',
      bytesRead: 5,
      truncated: false,
    });
  });

  it('applyFileResult sets selectedFile to binary', () => {
    const msg: ServerFileResultMsg = {
      type: 'file_result',
      kind: 'binary',
      path: '/p/img.png',
      mime: 'image/png',
      size: 1024,
    };
    useFileExplorerStore.getState().applyFileResult(msg);
    expect(useFileExplorerStore.getState().selectedFile).toEqual({
      state: 'binary',
      path: '/p/img.png',
      mime: 'image/png',
      size: 1024,
    });
  });

  it('applyFileResult sets selectedFile to too_large', () => {
    const msg: ServerFileResultMsg = {
      type: 'file_result',
      kind: 'too_large',
      path: '/p/huge.txt',
      size: 1e9,
    };
    useFileExplorerStore.getState().applyFileResult(msg);
    expect(useFileExplorerStore.getState().selectedFile).toEqual({
      state: 'too_large',
      path: '/p/huge.txt',
      size: 1e9,
    });
  });

  it('reset clears all state', () => {
    useFileExplorerStore.setState({
      dirs: { '/p': [] },
      expanded: { '/p': true },
      loadingPaths: { '/p': true },
      selectedFile: { state: 'text', path: '/p/a', content: '', bytesRead: 0, truncated: false },
    });
    useFileExplorerStore.getState().reset();
    const s = useFileExplorerStore.getState();
    expect(s.dirs).toEqual({});
    expect(s.expanded).toEqual({});
    expect(s.loadingPaths).toEqual({});
    expect(s.selectedFile).toBeNull();
  });

  it('refreshOpen clears entries for every expanded path and re-requests them', () => {
    const send = vi.fn();
    const client = { send };
    useFileExplorerStore.setState({
      dirs: {
        '/p': [{ name: 'src', kind: 'dir' }],
        '/p/src': [{ name: 'index.ts', kind: 'file', size: 10 }],
      },
      expanded: { '/p': true, '/p/src': true },
      loadingPaths: {},
      selectedFile: null,
    });
    useFileExplorerStore.getState().refreshOpen(client as unknown as { send: (m: unknown) => void });

    const s = useFileExplorerStore.getState();
    // Cached entries for both expanded paths cleared:
    expect(s.dirs['/p']).toBeUndefined();
    expect(s.dirs['/p/src']).toBeUndefined();
    expect(s.loadingPaths['/p']).toBe(true);
    expect(s.loadingPaths['/p/src']).toBe(true);
    // Two list_dirs sends:
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((c) => (c[0] as { path: string }).path).sort()).toEqual(['/p', '/p/src']);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run web:test -- file-explorer
```

- [ ] **Step 3: Implement `apps/web/src/store/file-explorer.ts`**

```ts
import { create } from 'zustand';
import type { ClientMsg, ServerDirsResultMsg, ServerFileResultMsg } from '../types/protocol';

export interface DirEntry {
  name: string;
  kind: 'dir' | 'file';
  size?: number;
}

export type SelectedFile =
  | { state: 'loading'; path: string }
  | { state: 'text'; path: string; content: string; bytesRead: number; truncated: boolean }
  | { state: 'binary'; path: string; mime?: string; size: number }
  | { state: 'too_large'; path: string; size: number };

interface FileExplorerStore {
  dirs: Record<string, DirEntry[]>;
  expanded: Record<string, true>;
  loadingPaths: Record<string, true>;
  selectedFile: SelectedFile | null;
  requestDirs(client: { send(m: ClientMsg): void }, path: string): void;
  applyDirsResult(m: ServerDirsResultMsg): void;
  toggleExpand(path: string): void;
  requestFile(client: { send(m: ClientMsg): void }, path: string): void;
  applyFileResult(m: ServerFileResultMsg): void;
  /**
   * Refresh the currently-rendered subtree: clear cached entries for every
   * currently-expanded path, then re-request each one. Called from the
   * drawer's refresh button. Spec §6 step 7.
   */
  refreshOpen(client: { send(m: ClientMsg): void }): void;
  reset(): void;
}

function newCorrelationId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const useFileExplorerStore = create<FileExplorerStore>((set, get) => ({
  dirs: {},
  expanded: {},
  loadingPaths: {},
  selectedFile: null,

  requestDirs(client, path) {
    set((s) => ({ loadingPaths: { ...s.loadingPaths, [path]: true } }));
    client.send({ type: 'list_dirs', path, correlationId: newCorrelationId() });
  },

  applyDirsResult(m) {
    set((s) => {
      const { [m.path]: _drop, ...restLoading } = s.loadingPaths;
      return {
        dirs: { ...s.dirs, [m.path]: m.entries.slice() },
        expanded: { ...s.expanded, [m.path]: true },
        loadingPaths: restLoading,
      };
    });
  },

  toggleExpand(path) {
    set((s) => {
      if (s.expanded[path]) {
        const { [path]: _drop, ...rest } = s.expanded;
        return { expanded: rest };
      }
      return { expanded: { ...s.expanded, [path]: true } };
    });
  },

  requestFile(client, path) {
    set({ selectedFile: { state: 'loading', path } });
    client.send({ type: 'read_file', path, correlationId: newCorrelationId() });
  },

  applyFileResult(m) {
    if (m.kind === 'text') {
      set({
        selectedFile: {
          state: 'text',
          path: m.path,
          content: m.content,
          bytesRead: m.bytesRead,
          truncated: m.truncated,
        },
      });
    } else if (m.kind === 'binary') {
      set({
        selectedFile: {
          state: 'binary',
          path: m.path,
          ...(m.mime ? { mime: m.mime } : {}),
          size: m.size,
        },
      });
    } else {
      set({ selectedFile: { state: 'too_large', path: m.path, size: m.size } });
    }
  },

  refreshOpen(client) {
    const openPaths = Object.keys(get().expanded);
    if (openPaths.length === 0) return;
    set((s) => {
      const dirs = { ...s.dirs };
      const loadingPaths = { ...s.loadingPaths };
      for (const p of openPaths) {
        delete dirs[p];
        loadingPaths[p] = true;
      }
      return { dirs, loadingPaths };
    });
    for (const p of openPaths) {
      client.send({ type: 'list_dirs', path: p, correlationId: newCorrelationId() });
    }
  },

  reset() {
    set({ dirs: {}, expanded: {}, loadingPaths: {}, selectedFile: null });
  },
}));
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run web:test -- file-explorer
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/store/file-explorer.ts apps/web/src/store/file-explorer.test.ts
git commit -m "feat(web): add file-explorer Zustand store"
```

---

## Task 9: Web `FileExplorer` + `FilePreview` components and Session.tsx integration

**Files:**
- Create: `apps/web/src/features/file-explorer/FileExplorer.tsx`
- Create: `apps/web/src/features/file-explorer/FilePreview.tsx`
- Create: `apps/web/src/features/file-explorer/FileExplorer.css`
- Modify: `apps/web/src/pages/Session.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Create `FilePreview.tsx`**

```tsx
import type { SelectedFile } from '../../store/file-explorer';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FilePreviewProps {
  file: SelectedFile | null;
}

export function FilePreview({ file }: FilePreviewProps): JSX.Element {
  if (!file) {
    return <div className="file-preview-empty">Select a file</div>;
  }
  if (file.state === 'loading') {
    return <div className="file-preview-loading">Loading {file.path}…</div>;
  }
  if (file.state === 'text') {
    return (
      <div className="file-preview">
        <div className="file-preview-header">
          {file.path} · {humanSize(file.bytesRead)}
        </div>
        <pre className="file-preview-pre">{file.content}</pre>
      </div>
    );
  }
  if (file.state === 'binary') {
    return (
      <div className="file-preview-binary">
        <div className="file-preview-header">{file.path}</div>
        <p>
          binary file ({humanSize(file.size)}
          {file.mime ? `, ${file.mime}` : ''})
        </p>
      </div>
    );
  }
  return (
    <div className="file-preview-binary">
      <div className="file-preview-header">{file.path}</div>
      <p>file too large ({humanSize(file.size)} / 5 MB max)</p>
    </div>
  );
}
```

- [ ] **Step 2: Create `FileExplorer.tsx`**

```tsx
import { useEffect } from 'react';
import { useFileExplorerStore, type DirEntry } from '../../store/file-explorer';
import type { BridgeClient } from '../../services/bridge-client';
import { FilePreview } from './FilePreview';
import './FileExplorer.css';

interface FileExplorerProps {
  client: BridgeClient;
  rootPath: string;
  onClose(): void;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface DirRowsProps {
  client: BridgeClient;
  path: string;
  depth: number;
}

function DirRows({ client, path, depth }: DirRowsProps): JSX.Element {
  const dirs = useFileExplorerStore((s) => s.dirs[path]);
  const expanded = useFileExplorerStore((s) => s.expanded);
  const loadingPaths = useFileExplorerStore((s) => s.loadingPaths);
  const requestDirs = useFileExplorerStore((s) => s.requestDirs);
  const requestFile = useFileExplorerStore((s) => s.requestFile);
  const toggleExpand = useFileExplorerStore((s) => s.toggleExpand);
  const selectedFile = useFileExplorerStore((s) => s.selectedFile);

  if (loadingPaths[path]) {
    return (
      <div className="fe-row fe-row-loading" style={{ paddingLeft: depth * 14 + 12 }}>
        loading…
      </div>
    );
  }
  if (!dirs) return <></>;

  return (
    <>
      {dirs.map((entry) => {
        const childPath = path.endsWith('/') ? `${path}${entry.name}` : `${path}/${entry.name}`;
        const isExpanded = Boolean(expanded[childPath]);
        const isSelected = selectedFile && 'path' in selectedFile && selectedFile.path === childPath;
        return (
          <div key={childPath}>
            <button
              type="button"
              className={`fe-row${isSelected ? ' selected' : ''}`}
              style={{ paddingLeft: depth * 14 + 4 }}
              onClick={() => {
                if (entry.kind === 'dir') {
                  if (isExpanded) {
                    toggleExpand(childPath);
                  } else if (!useFileExplorerStore.getState().dirs[childPath]) {
                    requestDirs(client, childPath);
                  } else {
                    toggleExpand(childPath);
                  }
                } else {
                  requestFile(client, childPath);
                }
              }}
            >
              <span className="fe-caret">{entry.kind === 'dir' ? (isExpanded ? '▼' : '▶') : ' '}</span>
              <span className="fe-name">{entry.name}</span>
              {entry.kind === 'file' && entry.size !== undefined && (
                <span className="fe-size">{humanSize(entry.size)}</span>
              )}
            </button>
            {entry.kind === 'dir' && isExpanded && (
              <DirRows client={client} path={childPath} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </>
  );
}

export function FileExplorer({ client, rootPath, onClose }: FileExplorerProps): JSX.Element {
  const dirs = useFileExplorerStore((s) => s.dirs);
  const requestDirs = useFileExplorerStore((s) => s.requestDirs);
  const selectedFile = useFileExplorerStore((s) => s.selectedFile);

  useEffect(() => {
    if (!dirs[rootPath]) {
      requestDirs(client, rootPath);
    }
  }, [client, rootPath, dirs, requestDirs]);

  return (
    <aside className="file-explorer">
      <div className="fe-header">
        <code className="fe-root">{rootPath}</code>
        <button
          type="button"
          onClick={() => useFileExplorerStore.getState().refreshOpen(client)}
          title="Refresh open subtree"
        >
          ↻
        </button>
        <button type="button" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="fe-tree">
        <DirRows client={client} path={rootPath} depth={0} />
      </div>
      <div className="fe-preview">
        <FilePreview file={selectedFile} />
      </div>
    </aside>
  );
}
```

- [ ] **Step 3: Create `FileExplorer.css`**

```css
.file-explorer {
  width: 360px;
  background: #181818;
  border-left: 1px solid #2a2a2a;
  color: #ccc;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.fe-header { display: flex; align-items: center; gap: 0.4rem; padding: 0.4rem; border-bottom: 1px solid #222; }
.fe-root { flex: 1; font-size: 0.75rem; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fe-header button { background: #2a2a2a; color: #ccc; border: 0; padding: 0.2rem 0.4rem; cursor: pointer; }
.fe-tree { flex: 1; overflow-y: auto; padding: 0.25rem 0; font-size: 0.85rem; }
.fe-row { width: 100%; text-align: left; background: none; border: 0; color: inherit; padding: 0.18rem 0.4rem; cursor: pointer; display: flex; align-items: center; gap: 0.3rem; }
.fe-row:hover { background: #1f1f1f; }
.fe-row.selected { background: #1c2a44; }
.fe-row-loading { color: #777; font-style: italic; padding: 0.2rem 0.4rem; }
.fe-caret { display: inline-block; width: 0.7rem; color: #777; }
.fe-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fe-size { color: #777; font-size: 0.7rem; }
.fe-preview { border-top: 1px solid #2a2a2a; max-height: 50%; overflow: auto; }
.file-preview-empty, .file-preview-loading, .file-preview-binary { padding: 0.6rem; color: #888; font-size: 0.85rem; }
.file-preview-header { padding: 0.4rem 0.6rem; background: #1a1a1a; font-size: 0.75rem; color: #888; border-bottom: 1px solid #222; }
.file-preview-pre { margin: 0; padding: 0.6rem; font-family: ui-monospace, Menlo, monospace; font-size: 0.8rem; color: #ddd; white-space: pre-wrap; word-break: break-word; }
```

- [ ] **Step 4: Update `Session.tsx` to mount the drawer**

Replace the current `pages/Session.tsx` with the version below. The diff: imports `FileExplorer`, adds local `drawerOpen` state, renders the drawer conditionally, resets `useFileExplorerStore` on `id` change, adds a 📁 toggle in the chat header.

```tsx
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSessionsStore } from '../store/sessions';
import { useConnectionStore } from '../store/connection';
import { useFileExplorerStore } from '../store/file-explorer';
import type { BridgeClient } from '../services/bridge-client';
import { SessionList } from '../features/session-list/SessionList';
import { Chat } from '../features/chat/Chat';
import { useNewSession } from '../features/project-picker/useNewSession';
import { streamTranscript } from '../services/transcript-fetcher';
import { FileExplorer } from '../features/file-explorer/FileExplorer';

interface SessionProps {
  client: BridgeClient;
}

export function Session({ client }: SessionProps): JSX.Element {
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

  useEffect(() => {
    if (id) setActive(id);
  }, [id, setActive]);

  // Reset file-explorer state when switching sessions.
  useEffect(() => {
    resetExplorer();
    setDrawerOpen(false);
  }, [id, resetExplorer]);

  const connStatus = useConnectionStore((s) => s.status);
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

  if (!session && !transcriptOnly) {
    return (
      <main className="home-main">
        <p>Session not found.</p>
        <button onClick={() => navigate('/')}>Home</button>
      </main>
    );
  }

  const sessions = order.map((sid) => sessionsMap[sid]!).filter((s) => s !== undefined);

  return (
    <>
      <SessionList
        sessions={sessions}
        activeId={id ?? null}
        onSelect={(nid) => navigate(`/session/${nid}`)}
        onNewSession={newSession.open}
      />
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
                      ? { images, correlationId: newCorrelationId() }
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
          banner={transcriptOnly ? 'transcript-only view (session no longer live)' : null}
          inputDisabled={transcriptOnly}
        />
      )}
      {!session && transcriptOnly && (
        <main className="home-main">
          <p>Loading transcript…</p>
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

- [ ] **Step 5: Update `App.tsx` to route `dirs_result` and `file_result`**

In the message handler inside the `useEffect`, before `apply(m)` (or alongside it):

```tsx
if (m.type === 'dirs_result') {
  useFileExplorerStore.getState().applyDirsResult(m);
  return;
}
if (m.type === 'file_result') {
  useFileExplorerStore.getState().applyFileResult(m);
  return;
}
```

Add the import at the top:

```tsx
import { useFileExplorerStore } from './store/file-explorer';
```

- [ ] **Step 6: Update `Chat.tsx` to expose drawer toggle button + onSend signature passthrough**

Task 9 only adds the file-explorer drawer integration to `Chat.tsx`. The image-attach wiring (drag-drop overlay, useImagePaste, imagePaste prop to InputBox) lands in Task 11 once the hook and the prop-accepting InputBox both exist. The `onSend` signature is widened to accept an optional `images` parameter now so Session.tsx's wire-up compiles without further churn later — Task 9's Chat.tsx never invokes the second arg, but its presence in the type signature is what later tasks rely on.

Replace `Chat.tsx` with:

```tsx
import { useEffect, useRef } from 'react';
import type { SessionView } from '../../store/sessions';
import { MessageBubble } from './MessageBubble';
import { InputBox } from './InputBox';
import './Chat.css';

interface ChatProps {
  session: SessionView;
  onSend(text: string, images?: ReadonlyArray<{ mime: string; base64: string }>): void;
  onStop(): void;
  onToggleDrawer?(): void;
  drawerOpen?: boolean;
  banner?: string | null;
  inputDisabled?: boolean;
}

export function Chat({
  session,
  onSend,
  onStop,
  onToggleDrawer,
  drawerOpen,
  banner,
  inputDisabled,
}: ChatProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.events]);

  return (
    <div className="chat">
      <div className="chat-header">
        <code>{session.projectPath}</code>
        <span className="chat-header-spacer">session {session.sessionId.slice(0, 8)}</span>
        {onToggleDrawer && (
          <button
            type="button"
            className="chat-drawer-toggle"
            onClick={onToggleDrawer}
            aria-label="Toggle file explorer"
          >
            {drawerOpen ? '📂' : '📁'}
          </button>
        )}
      </div>
      {banner && <div className="chat-banner">{banner}</div>}
      <div className="chat-scroll" ref={scrollRef}>
        {session.events.map((e, i) => (
          <MessageBubble
            key={`${i}-${e.type}-${e.type === 'system' ? e.event : (e as { seq: number }).seq}`}
            event={e}
          />
        ))}
      </div>
      <InputBox
        onSend={(text) => onSend(text)}
        onStop={onStop}
        disabled={(!session.alive) || Boolean(inputDisabled)}
        currentProjectPath={session.projectPath}
      />
    </div>
  );
}
```

Append CSS rule for the toggle:

```css
.chat-header-spacer { flex: 1; text-align: right; padding-right: 0.5rem; }
.chat-drawer-toggle { background: #2a2a2a; color: #ccc; border: 0; padding: 0.2rem 0.45rem; cursor: pointer; border-radius: 4px; }
.chat { position: relative; }
```

- [ ] **Step 7: Run web tests + typecheck + build**

```bash
npm run web:test
npx tsc --noEmit -p apps/web/tsconfig.json
npm run web:build
```

Expected: green.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/file-explorer apps/web/src/pages/Session.tsx apps/web/src/App.tsx apps/web/src/features/chat/Chat.tsx apps/web/src/features/chat/Chat.css
git commit -m "feat(web): add FileExplorer drawer with FilePreview, mounted in Session.tsx"
```

---

## Task 10: Web `useImagePaste` hook + `ImageThumbnails`

**Files:**
- Create: `apps/web/src/features/image-attach/ImageThumbnails.tsx`
- Create: `apps/web/src/features/image-attach/useImagePaste.ts`
- Create: `apps/web/src/features/image-attach/ImageAttach.css`
- Create: `apps/web/src/features/image-attach/useImagePaste.test.tsx`

- [ ] **Step 1: Write the failing hook test**

`apps/web/src/features/image-attach/useImagePaste.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useImagePaste } from './useImagePaste';

function makeFile(name: string, type: string, sizeBytes: number): File {
  const data = new Uint8Array(sizeBytes);
  return new File([data], name, { type });
}

describe('useImagePaste', () => {
  beforeEach(() => {
    // FileReader.readAsDataURL needs a global; happy-dom provides it.
  });

  it('addImageFromFile accepts a small PNG and exposes it via images', async () => {
    const { result } = renderHook(() => useImagePaste());
    await act(async () => {
      await result.current.addImageFromFile(makeFile('a.png', 'image/png', 64));
    });
    expect(result.current.images).toHaveLength(1);
    expect(result.current.images[0]!.mime).toBe('image/png');
    expect(result.current.error).toBeNull();
  });

  it('rejects MIME outside the allowlist', async () => {
    const { result } = renderHook(() => useImagePaste());
    await act(async () => {
      await result.current.addImageFromFile(makeFile('a.svg', 'image/svg+xml', 64));
    });
    expect(result.current.images).toHaveLength(0);
    expect(result.current.error).toMatch(/MIME/);
  });

  it('rejects images > 10 MB', async () => {
    const { result } = renderHook(() => useImagePaste());
    await act(async () => {
      await result.current.addImageFromFile(makeFile('a.png', 'image/png', 11 * 1024 * 1024));
    });
    expect(result.current.images).toHaveLength(0);
    expect(result.current.error).toMatch(/10 MB/);
  });

  it('rejects > 4 images', async () => {
    const { result } = renderHook(() => useImagePaste());
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await result.current.addImageFromFile(makeFile(`a${i}.png`, 'image/png', 64));
      });
    }
    await act(async () => {
      await result.current.addImageFromFile(makeFile('a5.png', 'image/png', 64));
    });
    expect(result.current.images).toHaveLength(4);
    expect(result.current.error).toMatch(/4/);
  });

  it('removeImage drops the entry by id', async () => {
    const { result } = renderHook(() => useImagePaste());
    await act(async () => {
      await result.current.addImageFromFile(makeFile('a.png', 'image/png', 64));
    });
    const id = result.current.images[0]!.id;
    act(() => result.current.removeImage(id));
    expect(result.current.images).toHaveLength(0);
  });

  it('clear empties the list', async () => {
    const { result } = renderHook(() => useImagePaste());
    await act(async () => {
      await result.current.addImageFromFile(makeFile('a.png', 'image/png', 64));
    });
    act(() => result.current.clear());
    expect(result.current.images).toHaveLength(0);
  });

  it('rejects the 5th file in a back-to-back batch (no stale-closure race)', async () => {
    // The hook renders once and we call addImageFromFile 5 times in a row
    // without giving React a chance to re-render between calls. The cap MUST
    // be enforced inside the functional setImages updater — not by reading
    // the stale `images.length` from the original render closure.
    const { result } = renderHook(() => useImagePaste());
    await act(async () => {
      await Promise.all(
        [0, 1, 2, 3, 4].map((i) =>
          result.current.addImageFromFile(makeFile(`a${i}.png`, 'image/png', 64)),
        ),
      );
    });
    expect(result.current.images.length).toBe(4);
    expect(result.current.error).toMatch(/4/);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run web:test -- useImagePaste
```

- [ ] **Step 3: Implement `useImagePaste.ts`**

```ts
import { useCallback, useState } from 'react';

export interface PendingImage {
  id: string;
  mime: string;
  base64: string;
  filename: string;
  sizeBytes: number;
  dataUrl: string;
}

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGES = 4;
const MAX_BYTES = 10 * 1024 * 1024;

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

function newId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface UseImagePaste {
  images: PendingImage[];
  error: string | null;
  addImageFromFile(file: File): Promise<void>;
  removeImage(id: string): void;
  clear(): void;
}

export function useImagePaste(): UseImagePaste {
  // Single state object so {images, error} updates are atomic. A separate
  // useState for each could split the cap-rejection across two renders and
  // drop the error message under React 18 batching.
  const [state, setState] = useState<{ images: PendingImage[]; error: string | null }>({
    images: [],
    error: null,
  });
  const { images, error } = state;

  const addImageFromFile = useCallback(async (file: File) => {
    // Validate stable file properties up front. These don't depend on
    // current state, so eager `setError` via the single-state updater is safe.
    if (!ALLOWED_MIMES.has(file.type)) {
      setState((prev) => ({ ...prev, error: `Unsupported MIME ${file.type}; allowed: png/jpeg/webp/gif` }));
      return;
    }
    if (file.size > MAX_BYTES) {
      setState((prev) => ({
        ...prev,
        error: `Image is ${(file.size / 1024 / 1024).toFixed(1)} MB; max 10 MB per image`,
      }));
      return;
    }
    let dataUrl: string;
    try {
      dataUrl = await readAsDataURL(file);
    } catch (err) {
      setState((prev) => ({ ...prev, error: `Could not read file: ${(err as Error).message}` }));
      return;
    }
    const comma = dataUrl.indexOf(',');
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    // Atomic decision: a single functional updater either appends and
    // clears the error, or rejects and sets the error. Both `images` and
    // `error` live in one state object so React batching cannot drop the
    // error update (the prior `let rejected = false` side-channel was
    // racy under React 18 concurrent rendering).
    setState((prev) => {
      if (prev.images.length >= MAX_IMAGES) {
        return { ...prev, error: `At most ${MAX_IMAGES} images per message` };
      }
      return {
        images: [
          ...prev.images,
          {
            id: newId(),
            mime: file.type,
            base64,
            filename: file.name,
            sizeBytes: file.size,
            dataUrl,
          },
        ],
        error: null,
      };
    });
  }, []);

  const removeImage = useCallback((id: string) => {
    setState((prev) => ({ ...prev, images: prev.images.filter((img) => img.id !== id) }));
  }, []);

  const clear = useCallback(() => {
    setState({ images: [], error: null });
  }, []);

  return { images, error, addImageFromFile, removeImage, clear };
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run web:test -- useImagePaste
```

Expected: 7 passed.

- [ ] **Step 5: Implement `ImageThumbnails.tsx`**

```tsx
import type { PendingImage } from './useImagePaste';
import './ImageAttach.css';

interface ImageThumbnailsProps {
  images: PendingImage[];
  onRemove(id: string): void;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ImageThumbnails({ images, onRemove }: ImageThumbnailsProps): JSX.Element | null {
  if (images.length === 0) return null;
  return (
    <ul className="image-thumbs">
      {images.map((img) => (
        <li key={img.id} className="image-thumb">
          <img src={img.dataUrl} alt={img.filename} />
          <button
            type="button"
            className="image-thumb-x"
            onClick={() => onRemove(img.id)}
            aria-label={`Remove ${img.filename}`}
          >
            ×
          </button>
          <div className="image-thumb-meta">
            <span className="image-thumb-name">{img.filename}</span>
            <span className="image-thumb-size">{humanSize(img.sizeBytes)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 6: Create `ImageAttach.css`**

```css
.image-thumbs { display: flex; gap: 0.4rem; padding: 0.4rem 0.5rem 0; list-style: none; margin: 0; flex-wrap: wrap; }
.image-thumb { position: relative; width: 64px; }
.image-thumb img { width: 64px; height: 64px; object-fit: cover; border-radius: 4px; border: 1px solid #2a2a2a; display: block; }
.image-thumb-x { position: absolute; top: -4px; right: -4px; background: #2a2a2a; color: #ddd; border: 1px solid #444; border-radius: 999px; width: 18px; height: 18px; line-height: 14px; padding: 0; cursor: pointer; }
.image-thumb-meta { display: flex; flex-direction: column; font-size: 0.65rem; color: #888; margin-top: 0.15rem; }
.image-thumb-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.image-attach-error { color: #f88; background: #2a1010; border: 1px solid #4a1a1a; padding: 0.3rem 0.5rem; margin: 0.4rem 0.5rem 0; font-size: 0.75rem; border-radius: 4px; }
.image-attach-button { background: #2a2a2a; color: #ddd; border: 0; padding: 0.4rem 0.7rem; cursor: pointer; }
.image-attach-button:disabled { color: #555; cursor: not-allowed; }
.image-attach-drop-overlay { position: absolute; inset: 0; background: rgba(28, 42, 68, 0.5); border: 2px dashed #2d6cdf; pointer-events: none; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 0.9rem; }
```

- [ ] **Step 7: Type-check + run tests**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
npm run web:test
```

Expected: clean + all tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/image-attach
git commit -m "feat(web): add useImagePaste hook + ImageThumbnails"
```

---

## Task 11: Wire image attach into Chat.tsx + InputBox

**Files:**
- Modify: `apps/web/src/features/chat/Chat.tsx`
- Modify: `apps/web/src/features/chat/InputBox.tsx`

This task lands the integration deferred from Task 9: Chat.tsx hosts `useImagePaste` and the chat-area drag-drop overlay; InputBox accepts the `imagePaste` instance via props and wires paste, the 📎 button, and the thumbnail strip.

- [ ] **Step 0: Replace `apps/web/src/features/chat/Chat.tsx`**

```tsx
import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { SessionView } from '../../store/sessions';
import { MessageBubble } from './MessageBubble';
import { InputBox } from './InputBox';
import { useImagePaste } from '../image-attach/useImagePaste';
import './Chat.css';

interface ChatProps {
  session: SessionView;
  onSend(text: string, images?: ReadonlyArray<{ mime: string; base64: string }>): void;
  onStop(): void;
  onToggleDrawer?(): void;
  drawerOpen?: boolean;
  banner?: string | null;
  inputDisabled?: boolean;
}

export function Chat({
  session,
  onSend,
  onStop,
  onToggleDrawer,
  drawerOpen,
  banner,
  inputDisabled,
}: ChatProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  // useImagePaste lives at Chat level so drag-drop on the entire chat area
  // and paste on the textarea inside InputBox feed the same image list.
  // Spec §3 / §5: "drag-drop into the chat area".
  const imagePaste = useImagePaste();
  const imagesEnabled = session.agent === 'claude' && session.alive && !inputDisabled;
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.events]);

  // Reset images when switching sessions.
  useEffect(() => {
    imagePaste.clear();
    setDragOver(false);
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
    <div className="chat" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="chat-header">
        <code>{session.projectPath}</code>
        <span className="chat-header-spacer">session {session.sessionId.slice(0, 8)}</span>
        {onToggleDrawer && (
          <button
            type="button"
            className="chat-drawer-toggle"
            onClick={onToggleDrawer}
            aria-label="Toggle file explorer"
          >
            {drawerOpen ? '📂' : '📁'}
          </button>
        )}
      </div>
      {banner && <div className="chat-banner">{banner}</div>}
      <div className="chat-scroll" ref={scrollRef}>
        {session.events.map((e, i) => (
          <MessageBubble
            key={`${i}-${e.type}-${e.type === 'system' ? e.event : (e as { seq: number }).seq}`}
            event={e}
          />
        ))}
      </div>
      {dragOver && imagesEnabled && (
        <div className="image-attach-drop-overlay">Drop image to attach</div>
      )}
      <InputBox
        onSend={onSend}
        onStop={onStop}
        disabled={(!session.alive) || Boolean(inputDisabled)}
        currentProjectPath={session.projectPath}
        agent={session.agent}
        imagePaste={imagePaste}
      />
    </div>
  );
}
```

- [ ] **Step 1: Replace `apps/web/src/features/chat/InputBox.tsx`**

```tsx
import { useRef, useState, type KeyboardEvent } from 'react';
import { PromptHistoryDropdown } from '../prompt-history/PromptHistoryDropdown';
import { ImageThumbnails } from '../image-attach/ImageThumbnails';
import type { UseImagePaste } from '../image-attach/useImagePaste';
import type { AgentKind } from '../../types/protocol';

interface InputBoxProps {
  onSend(text: string, images?: ReadonlyArray<{ mime: string; base64: string }>): void;
  onStop(): void;
  disabled: boolean;
  currentProjectPath?: string;
  agent: AgentKind;
  // Owned by Chat.tsx so drag-drop on the chat area and paste on the
  // textarea share the same image list.
  imagePaste: UseImagePaste;
}

export function InputBox({
  onSend,
  onStop,
  disabled,
  currentProjectPath,
  agent,
  imagePaste,
}: InputBoxProps): JSX.Element {
  const [text, setText] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesEnabled = agent === 'claude' && !disabled;
  const { images, error, addImageFromFile, removeImage, clear } = imagePaste;

  const submit = (): void => {
    const t = text.trim();
    if (t.length === 0 && images.length === 0) return;
    if (images.length > 0) {
      onSend(
        t,
        images.map((img) => ({ mime: img.mime, base64: img.base64 })),
      );
    } else {
      onSend(t);
    }
    setText('');
    clear();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'ArrowUp' && text.length === 0) {
      e.preventDefault();
      setHistoryOpen(true);
      return;
    }
    if (e.key === 'Escape' && historyOpen) {
      e.preventDefault();
      setHistoryOpen(false);
    }
  };

  const onPaste: React.ClipboardEventHandler<HTMLTextAreaElement> = async (e) => {
    if (!imagesEnabled) return;
    const items = Array.from(e.clipboardData?.items ?? []);
    const files = items
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) await addImageFromFile(f);
  };

  const onAttachClick = (): void => {
    if (!imagesEnabled) return;
    fileInputRef.current?.click();
  };

  const onFileInputChange: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const files = Array.from(e.target.files ?? []);
    for (const f of files) await addImageFromFile(f);
    e.target.value = '';
  };

  return (
    <div className="input-box" style={{ position: 'relative' }}>
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
      {error && <div className="image-attach-error">{error}</div>}
      <textarea
        value={text}
        placeholder={
          disabled
            ? 'Session ended.'
            : agent === 'codex'
              ? 'Type a prompt. Cmd/Ctrl+Enter to send. ↑ on empty input opens history. (Codex: no image input.)'
              : 'Type a prompt. Cmd/Ctrl+Enter to send. ↑ on empty input opens history. Paste/drop/📎 to attach images.'
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        rows={3}
        disabled={disabled}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        style={{ display: 'none' }}
        onChange={onFileInputChange}
      />
      <div className="input-actions">
        <button
          type="button"
          className="image-attach-button"
          onClick={onAttachClick}
          disabled={!imagesEnabled}
          title={
            agent === 'codex'
              ? 'Codex sessions do not accept images'
              : 'Attach image (paste / drop / click)'
          }
          aria-label="Attach image"
        >
          📎
        </button>
        <button
          type="button"
          onClick={() => setHistoryOpen((h) => !h)}
          disabled={disabled}
          aria-label="Toggle prompt history"
        >
          ⌘H
        </button>
        <button type="button" onClick={onStop} disabled={disabled}>
          Stop
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={disabled || (text.trim().length === 0 && images.length === 0)}
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run web tests + typecheck + build**

```bash
npm run web:test
npx tsc --noEmit -p apps/web/tsconfig.json
npm run web:build
```

Expected: all green; bundle ≤ ~200 KB gzipped.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/chat/Chat.tsx apps/web/src/features/chat/InputBox.tsx
git commit -m "feat(web): wire image attach into Chat.tsx + InputBox"
```

---

## Task 12: Manual e2e smoke

This task does not change code. It validates the Phase 3 increment end-to-end against a real bridge.

**Pre-reqs:** `claude` CLI on PATH and authed; existing repo tests + builds green.

- [ ] **Step 1: Build everything**

```bash
cd /Volumes/WDSSD/Code/mac-remote-terminal
npm run build
```

Expected: `apps/web/dist/index.html` and `packages/bridge/dist/index.js` produced.

- [ ] **Step 2: Boot the bridge**

```bash
export BRIDGE_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
node packages/bridge/dist/index.js
```

Expected: log lines for accounts loaded, bind host, static bundle.

- [ ] **Step 3: Open the printed URL in a browser**

Verify cookie set + redirect to `/`.

- [ ] **Step 4: File explorer happy path**

Click `+ New session`, pick `claude`, project path `/Users/<you>/Code/mac-remote-terminal`. In the chat header click the 📁 icon. Drawer opens. Click `package.json`. Preview shows the JSON.

- [ ] **Step 5: File explorer denylist**

Try to navigate up to `~/.ssh` (use a project path of `$HOME` to make this reachable). Verify the `.ssh` row does NOT appear in the listing. The browser console should be free of CSP violations.

- [ ] **Step 6: File explorer too-large + binary**

Click a binary file (e.g. an image in your project, or `node_modules/.../*.node`). Preview shows "binary file (...)". Click a file > 5 MB if available. Preview shows "file too large".

- [ ] **Step 7: Image attach paste**

Take a screenshot (Cmd-Shift-Ctrl-4). Inside the chat textarea, paste (Cmd-V). Thumbnail appears with size + filename + ×. Type "what is in this image?" and Cmd-Enter. Verify Claude streams a response that references the image.

- [ ] **Step 8: Image attach drag-drop**

Drag a PNG from Finder onto the chat area. Verify the drop overlay shows during drag, the thumbnail appears on drop, send works.

- [ ] **Step 9: Image attach 📎 button**

Click 📎. File picker opens. Select 2 PNGs. Both appear as thumbnails. Send.

- [ ] **Step 10: Codex rejects images**

`+ New session`, pick `codex`. The 📎 button is greyed out. Paste does nothing. Drag-drop does nothing. The textarea placeholder mentions "Codex: no image input."

- [ ] **Step 11: Inspect headers**

In DevTools → Network → click `/`. Confirm response headers include:
- `Content-Security-Policy: ... connect-src 'self' ws: wss: ... frame-ancestors 'none' ...`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`

- [ ] **Step 12: Restart bridge → transcript fallback still works**

Stop the bridge (Ctrl-C). Restart. Reload the browser tab. Existing live sessions are gone, but if you open `/session/<old-id>` directly, the transcript-only fallback (Phase 2) still renders the history. (Phase 3 must not regress this.)

- [ ] **Step 13: Tag the slice**

```bash
git tag phase-3-explorer-images-hardening
```

The tag is local-only — push if you've added a remote.

---

## Self-Review (run before declaring Phase 3 done)

1. `npm run typecheck` — both workspaces clean.
2. `npm test` — all bridge + web unit tests pass.
3. `npm run build` — both packages build cleanly.
4. Manual smoke (Task 12) executed end-to-end against real `claude`.
5. File explorer cannot reach `.ssh` / `id_rsa` / `*.pem` even when the project path is `$HOME`.
6. Symlinks to outside the allowlist do NOT appear in `dirs_result` (verify by creating one and reloading).
7. Image attach is rejected for codex sessions both client-side (📎 disabled, paste/drop ignored) and server-side (`images_not_supported_for_agent` error).
8. Browser DevTools → Console has zero CSP violations after 5 minutes of normal use.
9. The transcript JSONL still records `user` events; the optional `imageCount` field in `payload` makes per-bubble `📎 N attachments` rendering possible in a future phase.

If any check fails, fix before tagging.
