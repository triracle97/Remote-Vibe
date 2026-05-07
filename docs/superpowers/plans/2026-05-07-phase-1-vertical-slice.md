# Phase 1 — Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the smallest end-to-end slice of the web Claude/Codex spawner: a single Claude session spawnable from a browser over Tailscale, with token-bootstrap auth and a plain-text chat that survives a page reload.

**Architecture:** TypeScript ESM monorepo (npm workspaces). `packages/bridge` is a Node 20 process running `node:http` + `ws` that resolves the Tailscale IPv4 at boot, gates traffic with a token-set HttpOnly cookie, validates `Origin`/`Host` on WebSocket upgrades, spawns Claude Code via `child_process.spawn` (separate stdout/stderr), parses its stream-json into a unified event shape, fans those events out to subscribed WS clients, and keeps a per-session in-memory ring buffer for reconnect-replay. `apps/web` is a Vite + React + TypeScript SPA with Zustand stores, a chat view, a session list, and a typed-path project picker.

**Tech Stack:** Node 20 LTS, TypeScript 5 (ESM, NodeNext), `ws@^8`, Vitest 1, React 18, Vite 5, Zustand 4, React Router 6, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-05-07-web-claude-codex-spawner-design.md`

**Out of scope for Phase 1 (deferred to later phases):** multiple parallel sessions, Codex agent, image attachments, file explorer, prompt history persistence, on-disk transcript JSONL, `GET /transcripts/<id>` HTTP endpoint, file browser API (`list_dirs` / `read_tree` / `read_file`), markdown rendering, FS denylist enforcement beyond the project-cwd allowlist, Playwright E2E (added in Phase 5 hardening).

---

## File Structure

### Root

```
mac-remote-terminal/
├── package.json              # npm workspaces root + scripts
├── tsconfig.base.json        # shared TS compiler options
├── .nvmrc                    # Node version pin
├── .gitignore                # already exists
├── packages/bridge/          # bridge server
└── apps/web/                 # React SPA
```

### Bridge (`packages/bridge/`)

```
packages/bridge/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts              # boot entrypoint
│   ├── env.ts                # env loading + validation
│   ├── tailscale.ts          # resolve Tailscale IPv4
│   ├── auth.ts               # token compare, cookie utils, Origin check
│   ├── parser.ts             # Claude stream-json → unified events
│   ├── claude-process.ts     # spawn + IO for one Claude process
│   ├── session.ts            # SessionManager + ring buffer
│   ├── http-server.ts        # HTTP routes (bootstrap, static)
│   ├── websocket.ts          # WS upgrade + protocol routing
│   └── types.ts              # shared protocol types
└── src/__tests__/
    ├── env.test.ts
    ├── tailscale.test.ts
    ├── auth.test.ts
    ├── parser.test.ts
    ├── claude-process.test.ts
    ├── session.test.ts
    ├── http-server.test.ts
    └── websocket.test.ts
└── test/fixtures/
    └── claude-stream.ndjson  # recorded Claude stream-json sample
```

### Web (`apps/web/`)

```
apps/web/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── App.css
    ├── types/
    │   └── protocol.ts       # mirrors bridge/src/types.ts
    ├── services/
    │   └── bridge-client.ts  # WebSocket wrapper
    ├── store/
    │   ├── connection.ts     # Zustand: WS state (NO token)
    │   └── sessions.ts       # Zustand: session list + per-session events
    ├── pages/
    │   ├── Home.tsx
    │   └── Session.tsx
    └── features/
        ├── session-list/
        │   ├── SessionList.tsx
        │   └── SessionList.css
        ├── project-picker/
        │   ├── ProjectPicker.tsx
        │   └── ProjectPicker.css
        └── chat/
            ├── Chat.tsx
            ├── MessageBubble.tsx
            ├── InputBox.tsx
            └── Chat.css
```

---

## Task 1: Root workspace scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.nvmrc`

This task is pure scaffolding — no TDD applies.

- [ ] **Step 1: Write `.nvmrc`**

```
20
```

- [ ] **Step 2: Replace root `package.json`**

The current `package.json` was scaffolded for the deleted single-PTY server. Overwrite with:

```json
{
  "name": "mac-remote-terminal",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": [
    "packages/*",
    "apps/*"
  ],
  "scripts": {
    "bridge:dev": "npm run dev --workspace=packages/bridge",
    "bridge:build": "npm run build --workspace=packages/bridge",
    "bridge:test": "npm run test --workspace=packages/bridge",
    "web:dev": "npm run dev --workspace=apps/web",
    "web:build": "npm run build --workspace=apps/web",
    "web:test": "npm run test --workspace=apps/web",
    "build": "npm run web:build && npm run bridge:build",
    "test": "npm run bridge:test && npm run web:test",
    "typecheck": "tsc --noEmit -p packages/bridge/tsconfig.json && tsc --noEmit -p apps/web/tsconfig.json"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 3: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true
  }
}
```

- [ ] **Step 4: Delete obsolete `package-lock.json`**

The lockfile from the deleted single-PTY server references unused deps.

```bash
rm package-lock.json
rm -rf node_modules
```

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.base.json .nvmrc
git rm package-lock.json
git commit -m "chore: bootstrap npm workspaces + base tsconfig"
```

---

## Task 2: Bridge package skeleton + Vitest

**Files:**
- Create: `packages/bridge/package.json`
- Create: `packages/bridge/tsconfig.json`
- Create: `packages/bridge/vitest.config.ts`
- Create: `packages/bridge/src/index.ts` (placeholder)

- [ ] **Step 1: Create `packages/bridge/package.json`**

```json
{
  "name": "@mac-remote-terminal/bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/ws": "^8.5.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `packages/bridge/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "src/__tests__"]
}
```

- [ ] **Step 3: Create `packages/bridge/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
```

- [ ] **Step 4: Create placeholder `packages/bridge/src/index.ts`**

```ts
export {};
```

- [ ] **Step 5: Install deps from repo root**

```bash
npm install
```

Expected: workspace links resolve, no errors.

- [ ] **Step 6: Verify Vitest runs (with no tests)**

```bash
npm run bridge:test
```

Expected: `No test files found, exiting with code 0` or similar (tolerated). At minimum, no crash.

- [ ] **Step 7: Commit**

```bash
git add packages/bridge/package.json packages/bridge/tsconfig.json packages/bridge/vitest.config.ts packages/bridge/src/index.ts package-lock.json
git commit -m "chore(bridge): scaffold package with vitest"
```

---

## Task 3: `env.ts` — token validation

**Files:**
- Create: `packages/bridge/src/env.ts`
- Create: `packages/bridge/src/__tests__/env.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/env.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadEnv } from '../env.js';

describe('loadEnv', () => {
  it('returns config when BRIDGE_TOKEN is at least 24 chars', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      BRIDGE_PORT: '8765',
      BRIDGE_ALLOWED_DIRS: '/Users/test/code',
    });
    expect(cfg.token).toBe('a'.repeat(24));
    expect(cfg.port).toBe(8765);
    expect(cfg.allowedDirs).toEqual(['/Users/test/code']);
    expect(cfg.bindHost).toBeUndefined();
  });

  it('throws when BRIDGE_TOKEN is missing', () => {
    expect(() => loadEnv({})).toThrow(/BRIDGE_TOKEN/);
  });

  it('throws when BRIDGE_TOKEN is shorter than 24 chars', () => {
    expect(() => loadEnv({ BRIDGE_TOKEN: 'short' })).toThrow(/24/);
  });

  it('defaults port to 8765', () => {
    const cfg = loadEnv({ BRIDGE_TOKEN: 'a'.repeat(24) });
    expect(cfg.port).toBe(8765);
  });

  it('defaults allowedDirs to $HOME', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      HOME: '/Users/test',
    });
    expect(cfg.allowedDirs).toEqual(['/Users/test']);
  });

  it('parses comma-separated allowedDirs', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      BRIDGE_ALLOWED_DIRS: '/a,/b,/c',
    });
    expect(cfg.allowedDirs).toEqual(['/a', '/b', '/c']);
  });

  it('passes through BRIDGE_BIND_HOST override', () => {
    const cfg = loadEnv({
      BRIDGE_TOKEN: 'a'.repeat(24),
      BRIDGE_BIND_HOST: '127.0.0.1',
    });
    expect(cfg.bindHost).toBe('127.0.0.1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run bridge:test -- env
```

Expected: FAIL with "Cannot find module '../env.js'" or similar.

- [ ] **Step 3: Implement `packages/bridge/src/env.ts`**

```ts
export interface BridgeConfig {
  token: string;
  port: number;
  bindHost?: string;
  allowedDirs: string[];
}

const MIN_TOKEN_LEN = 24;

export function loadEnv(env: Record<string, string | undefined>): BridgeConfig {
  const token = env.BRIDGE_TOKEN;
  if (!token) {
    throw new Error(
      'BRIDGE_TOKEN is required. Generate one: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (token.length < MIN_TOKEN_LEN) {
    throw new Error(`BRIDGE_TOKEN must be at least ${MIN_TOKEN_LEN} characters`);
  }

  const port = Number(env.BRIDGE_PORT ?? '8765');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('BRIDGE_PORT must be a positive integer');
  }

  const allowedDirsRaw = env.BRIDGE_ALLOWED_DIRS ?? env.HOME;
  if (!allowedDirsRaw) {
    throw new Error('BRIDGE_ALLOWED_DIRS or HOME must be set');
  }
  const allowedDirs = allowedDirsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const bindHost = env.BRIDGE_BIND_HOST;

  return { token, port, allowedDirs, ...(bindHost ? { bindHost } : {}) };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run bridge:test -- env
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/env.ts packages/bridge/src/__tests__/env.test.ts
git commit -m "feat(bridge): add env loader with token validation"
```

---

## Task 4: `tailscale.ts` — resolve Tailscale IPv4

**Files:**
- Create: `packages/bridge/src/tailscale.ts`
- Create: `packages/bridge/src/__tests__/tailscale.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/tailscale.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { resolveTailscaleIPv4 } from '../tailscale.js';

describe('resolveTailscaleIPv4', () => {
  it('returns the IPv4 from `tailscale ip --4` output', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '100.64.1.5\n', stderr: '' });
    const ip = await resolveTailscaleIPv4({ exec });
    expect(ip).toBe('100.64.1.5');
    expect(exec).toHaveBeenCalledWith('tailscale', ['ip', '--4']);
  });

  it('throws when stdout has no IPv4', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '\n', stderr: '' });
    await expect(resolveTailscaleIPv4({ exec })).rejects.toThrow(/no Tailscale IPv4/i);
  });

  it('throws when the tailscale binary is missing', async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(resolveTailscaleIPv4({ exec })).rejects.toThrow(/tailscale CLI not found/i);
  });

  it('throws when tailscale exits with stderr', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: 'tailscaled is not running' });
    await expect(resolveTailscaleIPv4({ exec })).rejects.toThrow(/tailscaled is not running/);
  });

  it('returns only the first IPv4 if multiple lines', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '100.64.1.5\n100.64.1.6\n', stderr: '' });
    const ip = await resolveTailscaleIPv4({ exec });
    expect(ip).toBe('100.64.1.5');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run bridge:test -- tailscale
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/bridge/src/tailscale.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface ExecRunner {
  (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

const defaultExec: ExecRunner = async (cmd, args) => {
  const { stdout, stderr } = await execFileP(cmd, args);
  return { stdout, stderr };
};

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export async function resolveTailscaleIPv4(
  opts: { exec?: ExecRunner } = {},
): Promise<string> {
  const exec = opts.exec ?? defaultExec;
  let result;
  try {
    result = await exec('tailscale', ['ip', '--4']);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new Error('tailscale CLI not found on PATH. Install Tailscale and retry.');
    }
    throw err;
  }

  if (result.stderr.trim().length > 0 && result.stdout.trim().length === 0) {
    throw new Error(`tailscale ip --4 failed: ${result.stderr.trim()}`);
  }

  const first = result.stdout
    .split('\n')
    .map((s) => s.trim())
    .find((s) => IPV4_RE.test(s));

  if (!first) {
    throw new Error('no Tailscale IPv4 returned by `tailscale ip --4`');
  }

  return first;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run bridge:test -- tailscale
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/tailscale.ts packages/bridge/src/__tests__/tailscale.test.ts
git commit -m "feat(bridge): resolve Tailscale IPv4 for bind host"
```

---

## Task 5: `auth.ts` — token compare, cookie utils, Origin check

**Files:**
- Create: `packages/bridge/src/auth.ts`
- Create: `packages/bridge/src/__tests__/auth.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  tokensMatch,
  parseCookie,
  buildSessionCookie,
  isOriginAllowed,
  extractTokenFromRequest,
} from '../auth.js';
import type { IncomingMessage } from 'node:http';

const T = 'a'.repeat(32);

function fakeReq(headers: Record<string, string>, url = '/'): IncomingMessage {
  return { headers, url } as unknown as IncomingMessage;
}

describe('tokensMatch', () => {
  it('returns true for equal tokens', () => {
    expect(tokensMatch('abc123', 'abc123')).toBe(true);
  });
  it('returns false for different tokens', () => {
    expect(tokensMatch('abc123', 'abc124')).toBe(false);
  });
  it('returns false for different-length tokens', () => {
    expect(tokensMatch('abc', 'abcd')).toBe(false);
  });
});

describe('parseCookie', () => {
  it('returns empty record for undefined header', () => {
    expect(parseCookie(undefined)).toEqual({});
  });
  it('parses a single cookie', () => {
    expect(parseCookie('bridge_session=abc')).toEqual({ bridge_session: 'abc' });
  });
  it('parses multiple cookies', () => {
    expect(parseCookie('a=1; b=2; c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });
  it('ignores malformed entries', () => {
    expect(parseCookie('a=1; broken; b=2')).toEqual({ a: '1', b: '2' });
  });
});

describe('buildSessionCookie', () => {
  it('returns cookie with HttpOnly, SameSite=Strict, Path=/', () => {
    const c = buildSessionCookie(T);
    expect(c).toContain(`bridge_session=${T}`);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Path=/');
    expect(c).not.toContain('Secure');
  });
});

describe('isOriginAllowed', () => {
  it('returns true when Origin is missing', () => {
    expect(isOriginAllowed(undefined, '100.64.1.5:8765')).toBe(true);
  });
  it('returns true when Origin host matches Host', () => {
    expect(isOriginAllowed('http://100.64.1.5:8765', '100.64.1.5:8765')).toBe(true);
  });
  it('returns false when Origin host differs', () => {
    expect(isOriginAllowed('http://evil.com', '100.64.1.5:8765')).toBe(false);
  });
  it('returns false when Origin is malformed', () => {
    expect(isOriginAllowed('not-a-url', '100.64.1.5:8765')).toBe(false);
  });
});

describe('extractTokenFromRequest', () => {
  it('returns query token when present', () => {
    const req = fakeReq({}, '/?token=' + T);
    expect(extractTokenFromRequest(req)).toBe(T);
  });
  it('returns cookie token when present and no query', () => {
    const req = fakeReq({ cookie: `bridge_session=${T}` });
    expect(extractTokenFromRequest(req)).toBe(T);
  });
  it('prefers query over cookie', () => {
    const req = fakeReq({ cookie: 'bridge_session=cookie-tok' }, '/?token=query-tok');
    expect(extractTokenFromRequest(req)).toBe('query-tok');
  });
  it('returns undefined when neither is present', () => {
    const req = fakeReq({});
    expect(extractTokenFromRequest(req)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run bridge:test -- auth
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/bridge/src/auth.ts`**

```ts
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function parseCookie(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k.length > 0) out[k] = v;
  }
  return out;
}

export function buildSessionCookie(token: string): string {
  return `bridge_session=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export function isOriginAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (!host) return false;
  return originUrl.host === host;
}

export function extractTokenFromRequest(req: IncomingMessage): string | undefined {
  if (req.url) {
    const parsed = new URL(req.url, 'http://placeholder');
    const q = parsed.searchParams.get('token');
    if (q) return q;
  }
  const cookies = parseCookie(req.headers.cookie);
  const fromCookie = cookies.bridge_session;
  return fromCookie ?? undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run bridge:test -- auth
```

Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/auth.ts packages/bridge/src/__tests__/auth.test.ts
git commit -m "feat(bridge): add token, cookie, and origin utilities"
```

---

## Task 6: `types.ts` — protocol shapes

**Files:**
- Create: `packages/bridge/src/types.ts`

This is a type-only file with no runtime behavior — no test required. It locks the protocol surface so later tasks can import consistent shapes.

- [ ] **Step 1: Create `packages/bridge/src/types.ts`**

```ts
export type AgentKind = 'claude';

export interface ClientStartMsg {
  type: 'start';
  agent: AgentKind;
  projectPath: string;
  sessionId?: string;
  resume?: boolean;
  correlationId?: string;
}

export interface ClientInputMsg {
  type: 'input';
  sessionId: string;
  text: string;
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

export type ClientMsg =
  | ClientStartMsg
  | ClientInputMsg
  | ClientStopMsg
  | ClientListSessionsMsg
  | ClientGetHistoryMsg;

export type AgentEvent =
  | { kind: 'assistant_text'; text: string }
  | { kind: 'stream_delta'; delta: string }
  | { kind: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; output: unknown }
  | { kind: 'result'; cost?: number; durationMs?: number };

export interface ServerInitMsg {
  type: 'system';
  event: 'init';
}

export interface ServerLifecycleMsg {
  type: 'system';
  event: 'session_created' | 'session_ended';
  sessionId: string;
  seq: number;
  reason?: string;
  exitCode?: number;
}

export interface ServerStreamMsg {
  type: 'assistant' | 'stream_delta' | 'tool_result' | 'result' | 'status';
  sessionId: string;
  seq: number;
  payload: unknown;
}

export interface ServerSessionListMsg {
  type: 'session_list';
  sessions: Array<{ sessionId: string; agent: AgentKind; projectPath: string; createdAt: number }>;
  correlationId?: string;
}

export interface ServerHistoryMsg {
  type: 'history';
  sessionId: string;
  events: Array<ServerLifecycleMsg | ServerStreamMsg>;
  hasMore: boolean;
  correlationId?: string;
}

export type ServerErrorCode =
  | 'not_authorized'
  | 'origin_mismatch'
  | 'path_outside_allowlist'
  | 'session_dead'
  | 'agent_not_installed'
  | 'message_too_large'
  | 'history_truncated'
  | 'unsupported_message';

export interface ServerErrorMsg {
  type: 'error';
  code: ServerErrorCode;
  message: string;
  correlationId?: string;
}

export type ServerMsg =
  | ServerInitMsg
  | ServerLifecycleMsg
  | ServerStreamMsg
  | ServerSessionListMsg
  | ServerHistoryMsg
  | ServerErrorMsg;
```

- [ ] **Step 2: Verify the file type-checks**

```bash
npm run bridge:test -- --run --reporter=verbose 2>&1 | head -20
npx tsc --noEmit -p packages/bridge/tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/bridge/src/types.ts
git commit -m "feat(bridge): define protocol types for Phase 1"
```

---

## Task 7: `parser.ts` — Claude stream-json parser

Phase 1 supports only the subset of Claude stream-json events needed for plain-text chat: `system { subtype: "init" }`, `assistant`, `user` (tool results), `result`, and partial-message stream events for streaming text.

**Files:**
- Create: `packages/bridge/src/parser.ts`
- Create: `packages/bridge/src/__tests__/parser.test.ts`
- Create: `packages/bridge/test/fixtures/claude-stream.ndjson`

- [ ] **Step 1: Create the fixture**

`packages/bridge/test/fixtures/claude-stream.ndjson`:

```
{"type":"system","subtype":"init","session_id":"sess-1","model":"claude-sonnet"}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":", world"}}}
{"type":"assistant","message":{"content":[{"type":"text","text":"Hello, world"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"file.txt\n"}]}}
{"type":"result","subtype":"success","total_cost_usd":0.0042,"duration_ms":1234}
```

- [ ] **Step 2: Write the failing test**

`packages/bridge/src/__tests__/parser.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseClaudeLine } from '../parser.js';

const __filename = fileURLToPath(import.meta.url);
const fixture = readFileSync(
  join(dirname(__filename), '..', '..', 'test', 'fixtures', 'claude-stream.ndjson'),
  'utf8',
);
const lines = fixture.trim().split('\n');

describe('parseClaudeLine', () => {
  it('returns null for the system init line', () => {
    expect(parseClaudeLine(lines[0]!)).toBeNull();
  });

  it('parses a content_block_delta into stream_delta', () => {
    const ev = parseClaudeLine(lines[1]!);
    expect(ev).toEqual({ kind: 'stream_delta', delta: 'Hello' });
  });

  it('parses an assistant text message into assistant_text', () => {
    const ev = parseClaudeLine(lines[3]!);
    expect(ev).toEqual({ kind: 'assistant_text', text: 'Hello, world' });
  });

  it('parses an assistant tool_use message into tool_use', () => {
    const ev = parseClaudeLine(lines[4]!);
    expect(ev).toEqual({
      kind: 'tool_use',
      toolUseId: 'tu_1',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
  });

  it('parses a user tool_result message into tool_result', () => {
    const ev = parseClaudeLine(lines[5]!);
    expect(ev).toEqual({
      kind: 'tool_result',
      toolUseId: 'tu_1',
      output: 'file.txt\n',
    });
  });

  it('parses a result message', () => {
    const ev = parseClaudeLine(lines[6]!);
    expect(ev).toEqual({ kind: 'result', cost: 0.0042, durationMs: 1234 });
  });

  it('returns null for unrecognized JSON', () => {
    expect(parseClaudeLine('{"type":"???"}')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseClaudeLine('not json')).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npm run bridge:test -- parser
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `packages/bridge/src/parser.ts`**

```ts
import type { AgentEvent } from './types.js';

interface RawClaudeMsg {
  type: string;
  subtype?: string;
  message?: {
    content?: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
      | { type: 'tool_result'; tool_use_id: string; content: unknown }
    >;
  };
  event?: {
    type: string;
    delta?: { type: string; text?: string };
  };
  total_cost_usd?: number;
  duration_ms?: number;
}

export function parseClaudeLine(line: string): AgentEvent | null {
  let raw: RawClaudeMsg;
  try {
    raw = JSON.parse(line) as RawClaudeMsg;
  } catch {
    return null;
  }
  if (!raw || typeof raw.type !== 'string') return null;

  switch (raw.type) {
    case 'stream_event': {
      const ev = raw.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
        return { kind: 'stream_delta', delta: ev.delta.text };
      }
      return null;
    }
    case 'assistant': {
      const blocks = raw.message?.content ?? [];
      for (const b of blocks) {
        if (b.type === 'text') {
          return { kind: 'assistant_text', text: b.text };
        }
        if (b.type === 'tool_use') {
          return {
            kind: 'tool_use',
            toolUseId: b.id,
            toolName: b.name,
            input: b.input,
          };
        }
      }
      return null;
    }
    case 'user': {
      const blocks = raw.message?.content ?? [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          return { kind: 'tool_result', toolUseId: b.tool_use_id, output: b.content };
        }
      }
      return null;
    }
    case 'result': {
      const out: AgentEvent = { kind: 'result' };
      if (typeof raw.total_cost_usd === 'number') out.cost = raw.total_cost_usd;
      if (typeof raw.duration_ms === 'number') out.durationMs = raw.duration_ms;
      return out;
    }
    case 'system':
      return null;
    default:
      return null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm run bridge:test -- parser
```

Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add packages/bridge/src/parser.ts packages/bridge/src/__tests__/parser.test.ts packages/bridge/test/fixtures/claude-stream.ndjson
git commit -m "feat(bridge): parse Claude stream-json into unified events"
```

---

## Task 8: `claude-process.ts` — spawn + IO with mocked spawn

Phase 1 spawns Claude in headless print mode via `child_process.spawn`. The spawn function is injected so tests can drive scripted stdout/stderr/exit without launching a real binary.

**Files:**
- Create: `packages/bridge/src/claude-process.ts`
- Create: `packages/bridge/src/__tests__/claude-process.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/claude-process.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { ClaudeProcess } from '../claude-process.js';

function makeFakeChild() {
  const stdoutPushes: string[] = [];
  const stderrPushes: string[] = [];
  const stdinWrites: string[] = [];

  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinWrites.push(chunk.toString());
      cb();
    },
  });

  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    kill: (s: NodeJS.Signals) => boolean;
    pid: number;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.kill = vi.fn().mockReturnValue(true);
  child.pid = 1234;

  return {
    child,
    pushStdout: (s: string) => {
      stdout.push(s);
      stdoutPushes.push(s);
    },
    pushStderr: (s: string) => {
      stderr.push(s);
      stderrPushes.push(s);
    },
    endStdout: () => stdout.push(null),
    endStderr: () => stderr.push(null),
    exit: (code: number) => {
      stdout.push(null);
      stderr.push(null);
      child.emit('exit', code);
    },
    stdinWrites,
  };
}

describe('ClaudeProcess', () => {
  it('passes the right argv to spawn', () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    new ClaudeProcess('/Users/test/proj', { spawn });
    expect(spawn).toHaveBeenCalledWith(
      'zsh',
      [
        '-li',
        '-c',
        "exec claude -p --dangerously-skip-permissions --output-format stream-json --input-format stream-json --include-partial-messages --verbose",
      ],
      expect.objectContaining({ cwd: '/Users/test/proj', stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  it('emits parsed events for each NDJSON line on stdout', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });
    const events: unknown[] = [];
    proc.on('event', (e) => events.push(e));

    fakes.pushStdout('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}\n');
    fakes.pushStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}\n');
    await new Promise((r) => setImmediate(r));

    expect(events).toEqual([
      { kind: 'stream_delta', delta: 'hi' },
      { kind: 'assistant_text', text: 'hello' },
    ]);
  });

  it('handles partial NDJSON lines split across chunks', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });
    const events: unknown[] = [];
    proc.on('event', (e) => events.push(e));

    const json = '{"type":"assistant","message":{"content":[{"type":"text","text":"split"}]}}\n';
    fakes.pushStdout(json.slice(0, 20));
    fakes.pushStdout(json.slice(20));
    await new Promise((r) => setImmediate(r));

    expect(events).toEqual([{ kind: 'assistant_text', text: 'split' }]);
  });

  it('keeps a rolling 4KB stderr tail', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });

    fakes.pushStderr('A'.repeat(5000));
    await new Promise((r) => setImmediate(r));

    expect(proc.stderrTail().length).toBe(4096);
    expect(proc.stderrTail().endsWith('A'.repeat(10))).toBe(true);
  });

  it('writes user input as a single NDJSON line to stdin', () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });

    proc.sendUserText('hello');

    expect(fakes.stdinWrites.length).toBe(1);
    const written = JSON.parse(fakes.stdinWrites[0]!.trimEnd());
    expect(written).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
    expect(fakes.stdinWrites[0]!.endsWith('\n')).toBe(true);
  });

  it('emits "exit" with code on process exit', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });
    const exitSpy = vi.fn();
    proc.on('exit', exitSpy);

    fakes.exit(0);
    await new Promise((r) => setImmediate(r));

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('kill() sends SIGTERM then SIGKILL after grace', async () => {
    vi.useFakeTimers();
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });

    proc.kill();
    expect(fakes.child.kill).toHaveBeenCalledWith('SIGTERM');

    vi.advanceTimersByTime(5000);
    expect(fakes.child.kill).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run bridge:test -- claude-process
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/bridge/src/claude-process.ts`**

```ts
import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcessByStdio, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { parseClaudeLine } from './parser.js';
import type { AgentEvent } from './types.js';

const STDERR_TAIL_BYTES = 4096;
const KILL_GRACE_MS = 5000;

export type SpawnFn = (cmd: string, args: string[], options: SpawnOptions) => ChildProcessByStdio<Writable, Readable, Readable>;

const CLAUDE_FLAGS = [
  '-p',
  '--dangerously-skip-permissions',
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--include-partial-messages',
  '--verbose',
].join(' ');

export interface ClaudeProcessEvents {
  event: (e: AgentEvent) => void;
  exit: (code: number | null) => void;
}

export class ClaudeProcess extends EventEmitter {
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private stdoutBuf = '';
  private stderrBuf = Buffer.alloc(0);
  private killed = false;

  constructor(projectPath: string, opts: { spawn?: SpawnFn } = {}) {
    super();
    const spawnFn = (opts.spawn ?? (nodeSpawn as unknown as SpawnFn));
    const argv = ['-li', '-c', `exec claude ${CLAUDE_FLAGS}`];
    this.child = spawnFn('zsh', argv, {
      cwd: projectPath,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => this.handleStderr(chunk));
    this.child.on('exit', (code) => this.emit('exit', code));
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.length === 0) continue;
      const ev = parseClaudeLine(line);
      if (ev) this.emit('event', ev);
    }
  }

  private handleStderr(chunk: Buffer): void {
    this.stderrBuf = Buffer.concat([this.stderrBuf, chunk]);
    if (this.stderrBuf.length > STDERR_TAIL_BYTES) {
      this.stderrBuf = this.stderrBuf.subarray(this.stderrBuf.length - STDERR_TAIL_BYTES);
    }
  }

  stderrTail(): string {
    return this.stderrBuf.toString('utf8');
  }

  sendUserText(text: string): void {
    const line =
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      }) + '\n';
    this.child.stdin.write(line);
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.child.kill('SIGTERM');
    setTimeout(() => {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }, KILL_GRACE_MS).unref();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run bridge:test -- claude-process
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/claude-process.ts packages/bridge/src/__tests__/claude-process.test.ts
git commit -m "feat(bridge): add ClaudeProcess wrapper with mockable spawn"
```

---

## Task 9: `session.ts` — SessionManager + ring buffer

**Files:**
- Create: `packages/bridge/src/session.ts`
- Create: `packages/bridge/src/__tests__/session.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/session.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionManager } from '../session.js';
import type { AgentEvent, ServerLifecycleMsg, ServerStreamMsg } from '../types.js';

class FakeProc extends EventEmitter {
  killed = false;
  sentText: string[] = [];
  sendUserText(s: string) { this.sentText.push(s); }
  kill() { this.killed = true; this.emit('exit', 0); }
  emitEvent(e: AgentEvent) { this.emit('event', e); }
}

function makeManager(opts: { allowedDirs?: string[] } = {}) {
  const procs: FakeProc[] = [];
  const factory = (_path: string) => {
    const p = new FakeProc();
    procs.push(p);
    return p as unknown as import('../claude-process.js').ClaudeProcess;
  };
  const mgr = new SessionManager({
    allowedDirs: opts.allowedDirs ?? ['/Users/test'],
    bufferCap: 100,
    spawnClaude: factory,
    realpath: async (p) => p,
  });
  return { mgr, procs };
}

describe('SessionManager', () => {
  it('rejects projectPath outside allowedDirs', async () => {
    const { mgr } = makeManager({ allowedDirs: ['/Users/alice'] });
    await expect(mgr.create({ agent: 'claude', projectPath: '/etc' })).rejects.toMatchObject({
      code: 'path_outside_allowlist',
    });
  });

  it('creates a session inside an allowed dir and emits session_created', async () => {
    const { mgr } = makeManager();
    const events: unknown[] = [];
    mgr.on('broadcast', (m) => events.push(m));
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });

    expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(events.length).toBe(1);
    const m = events[0] as ServerLifecycleMsg;
    expect(m.type).toBe('system');
    expect(m.event).toBe('session_created');
    expect(m.sessionId).toBe(s.sessionId);
    expect(m.seq).toBe(1);
  });

  it('forwards process events as protocol messages with monotonic seq', async () => {
    const { mgr, procs } = makeManager();
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    const broadcasts: unknown[] = [];
    mgr.on('broadcast', (m) => broadcasts.push(m));

    procs[0]!.emitEvent({ kind: 'stream_delta', delta: 'hi' });
    procs[0]!.emitEvent({ kind: 'assistant_text', text: 'hello' });

    expect(broadcasts.length).toBe(2);
    const a = broadcasts[0] as ServerStreamMsg;
    const b = broadcasts[1] as ServerStreamMsg;
    expect(a.sessionId).toBe(s.sessionId);
    expect(a.seq).toBe(2);
    expect(a.type).toBe('stream_delta');
    expect(b.seq).toBe(3);
    expect(b.type).toBe('assistant');
  });

  it('keeps events in the ring buffer for replay via getHistory', async () => {
    const { mgr, procs } = makeManager();
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    procs[0]!.emitEvent({ kind: 'stream_delta', delta: 'a' });
    procs[0]!.emitEvent({ kind: 'stream_delta', delta: 'b' });

    const h = mgr.getHistory(s.sessionId, 0);
    expect(h.events.length).toBe(3); // session_created + 2 deltas
    expect(h.hasMore).toBe(false);
  });

  it('returns only events with seq > since', async () => {
    const { mgr, procs } = makeManager();
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    procs[0]!.emitEvent({ kind: 'stream_delta', delta: 'a' });
    procs[0]!.emitEvent({ kind: 'stream_delta', delta: 'b' });

    const h = mgr.getHistory(s.sessionId, 2);
    expect(h.events.length).toBe(1);
    const ev = h.events[0] as ServerStreamMsg;
    expect(ev.seq).toBe(3);
  });

  it('drops oldest events past bufferCap and signals hasMore for older requests', async () => {
    const procs: FakeProc[] = [];
    const mgr = new SessionManager({
      allowedDirs: ['/Users/test'],
      bufferCap: 5,
      spawnClaude: () => {
        const p = new FakeProc();
        procs.push(p);
        return p as unknown as import('../claude-process.js').ClaudeProcess;
      },
      realpath: async (p) => p,
    });
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    for (let i = 0; i < 10; i++) procs[0]!.emitEvent({ kind: 'stream_delta', delta: String(i) });

    const h = mgr.getHistory(s.sessionId, 0);
    expect(h.events.length).toBe(5);
    expect(h.hasMore).toBe(true);
  });

  it('emits session_ended on process exit and removes the session from list_sessions', async () => {
    const { mgr, procs } = makeManager();
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });

    const broadcasts: unknown[] = [];
    mgr.on('broadcast', (m) => broadcasts.push(m));
    procs[0]!.emit('exit', 0);

    const last = broadcasts[broadcasts.length - 1] as ServerLifecycleMsg;
    expect(last.type).toBe('system');
    expect(last.event).toBe('session_ended');
    expect(last.sessionId).toBe(s.sessionId);
    expect(last.exitCode).toBe(0);

    expect(mgr.listSessions()).toHaveLength(0);
  });

  it('stop() kills the underlying process', async () => {
    const { mgr, procs } = makeManager();
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    mgr.stop(s.sessionId);
    expect(procs[0]!.killed).toBe(true);
  });

  it('sendInput forwards text to the process', async () => {
    const { mgr, procs } = makeManager();
    const s = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    mgr.sendInput(s.sessionId, 'hi there');
    expect(procs[0]!.sentText).toEqual(['hi there']);
  });

  it('throws session_dead error when sending input to unknown session', async () => {
    const { mgr } = makeManager();
    expect(() => mgr.sendInput('nope', 'x')).toThrow(/session_dead/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run bridge:test -- session
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/bridge/src/session.ts`**

```ts
import { EventEmitter } from 'node:events';
import { realpath as fsRealpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ClaudeProcess } from './claude-process.js';
import type {
  AgentEvent,
  AgentKind,
  ServerLifecycleMsg,
  ServerStreamMsg,
} from './types.js';

export interface SessionInfo {
  sessionId: string;
  agent: AgentKind;
  projectPath: string;
  createdAt: number;
}

interface InternalSession extends SessionInfo {
  proc: ClaudeProcess;
  buffer: Array<ServerLifecycleMsg | ServerStreamMsg>;
  nextSeq: number;
  alive: boolean;
}

export interface SessionManagerOpts {
  allowedDirs: string[];
  bufferCap: number;
  spawnClaude: (projectPath: string) => ClaudeProcess;
  realpath?: (p: string) => Promise<string>;
}

export class PathOutsideAllowlistError extends Error {
  code = 'path_outside_allowlist' as const;
  constructor(public projectPath: string) {
    super(`projectPath ${projectPath} is not inside any allowed directory`);
  }
}

export class SessionDeadError extends Error {
  code = 'session_dead' as const;
  constructor(public sessionId: string) {
    super(`session ${sessionId} is not alive`);
  }
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly allowedDirs: string[];
  private readonly bufferCap: number;
  private readonly spawnClaude: (projectPath: string) => ClaudeProcess;
  private readonly realpath: (p: string) => Promise<string>;

  constructor(opts: SessionManagerOpts) {
    super();
    this.allowedDirs = opts.allowedDirs;
    this.bufferCap = opts.bufferCap;
    this.spawnClaude = opts.spawnClaude;
    this.realpath = opts.realpath ?? fsRealpath;
  }

  private async validatePath(projectPath: string): Promise<string> {
    let real: string;
    try {
      real = await this.realpath(projectPath);
    } catch {
      throw new PathOutsideAllowlistError(projectPath);
    }
    const inside = this.allowedDirs.some((d) => real === d || real.startsWith(d + '/'));
    if (!inside) throw new PathOutsideAllowlistError(projectPath);
    return real;
  }

  async create(params: { agent: AgentKind; projectPath: string }): Promise<SessionInfo> {
    if (params.agent !== 'claude') {
      throw new Error(`agent ${params.agent} not supported in Phase 1`);
    }
    const real = await this.validatePath(params.projectPath);
    const sessionId = randomUUID();
    const proc = this.spawnClaude(real);

    const internal: InternalSession = {
      sessionId,
      agent: 'claude',
      projectPath: real,
      createdAt: Date.now(),
      proc,
      buffer: [],
      nextSeq: 1,
      alive: true,
    };
    this.sessions.set(sessionId, internal);

    this.appendAndBroadcast(internal, {
      type: 'system',
      event: 'session_created',
      sessionId,
      seq: internal.nextSeq++,
    });

    proc.on('event', (e: AgentEvent) => this.onProcEvent(internal, e));
    proc.on('exit', (code) => this.onProcExit(internal, code));

    return {
      sessionId,
      agent: internal.agent,
      projectPath: internal.projectPath,
      createdAt: internal.createdAt,
    };
  }

  private onProcEvent(s: InternalSession, e: AgentEvent): void {
    if (!s.alive) return;
    const seq = s.nextSeq++;
    let msg: ServerStreamMsg;
    switch (e.kind) {
      case 'assistant_text':
        msg = { type: 'assistant', sessionId: s.sessionId, seq, payload: { text: e.text } };
        break;
      case 'stream_delta':
        msg = { type: 'stream_delta', sessionId: s.sessionId, seq, payload: { delta: e.delta } };
        break;
      case 'tool_use':
        msg = { type: 'assistant', sessionId: s.sessionId, seq, payload: { toolUse: e } };
        break;
      case 'tool_result':
        msg = { type: 'tool_result', sessionId: s.sessionId, seq, payload: e };
        break;
      case 'result':
        msg = { type: 'result', sessionId: s.sessionId, seq, payload: e };
        break;
    }
    this.appendAndBroadcast(s, msg);
  }

  private onProcExit(s: InternalSession, code: number | null): void {
    if (!s.alive) return;
    s.alive = false;
    this.appendAndBroadcast(s, {
      type: 'system',
      event: 'session_ended',
      sessionId: s.sessionId,
      seq: s.nextSeq++,
      exitCode: code ?? -1,
      reason: 'agent_exit',
    });
    this.sessions.delete(s.sessionId);
  }

  private appendAndBroadcast(s: InternalSession, msg: ServerLifecycleMsg | ServerStreamMsg): void {
    s.buffer.push(msg);
    if (s.buffer.length > this.bufferCap) {
      s.buffer.splice(0, s.buffer.length - this.bufferCap);
    }
    this.emit('broadcast', msg);
  }

  listSessions(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      agent: s.agent,
      projectPath: s.projectPath,
      createdAt: s.createdAt,
    }));
  }

  getHistory(sessionId: string, since: number): {
    events: Array<ServerLifecycleMsg | ServerStreamMsg>;
    hasMore: boolean;
  } {
    const s = this.sessions.get(sessionId);
    if (!s) return { events: [], hasMore: false };
    const minSeqInBuffer = s.buffer.length > 0 ? s.buffer[0]!.seq : s.nextSeq;
    const events = s.buffer.filter((e) => e.seq > since);
    const hasMore = since + 1 < minSeqInBuffer;
    return { events, hasMore };
  }

  sendInput(sessionId: string, text: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || !s.alive) throw new SessionDeadError(sessionId);
    s.proc.sendUserText(text);
  }

  stop(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.proc.kill();
  }

  shutdown(): void {
    for (const s of this.sessions.values()) s.proc.kill();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run bridge:test -- session
```

Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/session.ts packages/bridge/src/__tests__/session.test.ts
git commit -m "feat(bridge): add SessionManager with ring buffer and replay"
```

---

## Task 10: `http-server.ts` — bootstrap, redirect, static, security headers

**Files:**
- Create: `packages/bridge/src/http-server.ts`
- Create: `packages/bridge/src/__tests__/http-server.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/http-server.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpHandler } from '../http-server.js';

const TOKEN = 'a'.repeat(32);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-http-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><body>app</body>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("ok")');

  const handler = createHttpHandler({ token: TOKEN, staticDir: dir });
  const server = createServer(handler);
  return new Promise<{ server: import('node:http').Server; baseUrl: string; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no addr');
        resolve({
          server,
          baseUrl: `http://127.0.0.1:${addr.port}`,
          close: () =>
            new Promise<void>((r) => {
              server.close(() => r());
            }),
        });
      });
    },
  );
}

describe('http-server', () => {
  it('redirects /?token=<valid> to / with bridge_session cookie', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/?token=${TOKEN}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const sc = res.headers.get('set-cookie') ?? '';
    expect(sc).toContain(`bridge_session=${TOKEN}`);
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Strict');
    await close();
  });

  it('returns 401 with hint when no cookie and no token query', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toMatch(/Token required/);
    await close();
  });

  it('returns 401 for invalid token query', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/?token=wrong`, { redirect: 'manual' });
    expect(res.status).toBe(401);
    await close();
  });

  it('serves index.html when cookie is valid', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<body>app</body>');
    await close();
  });

  it('serves nested assets when cookie is valid', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/assets/app.js`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log("ok")');
    await close();
  });

  it('rejects cookie-authed request when Origin does not match Host', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/`, {
      headers: { cookie: `bridge_session=${TOKEN}`, origin: 'http://evil.com' },
    });
    expect(res.status).toBe(403);
    await close();
  });

  it('attaches security headers to authed responses', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    await close();
  });

  it('rejects path traversal attempts', async () => {
    const { baseUrl, close } = await setup();
    const res = await fetch(`${baseUrl}/../../etc/passwd`, {
      headers: { cookie: `bridge_session=${TOKEN}` },
    });
    expect([400, 403, 404]).toContain(res.status);
    await close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run bridge:test -- http-server
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/bridge/src/http-server.ts`**

```ts
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, sep, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tokensMatch, parseCookie, buildSessionCookie, isOriginAllowed, extractTokenFromRequest } from './auth.js';

export interface HttpHandlerOpts {
  token: string;
  staticDir: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:",
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function applySecurity(res: ServerResponse): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

function send(res: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  applySecurity(res);
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.end(body);
}

function safeResolveStaticPath(staticDir: string, urlPath: string): string | null {
  const root = resolve(staticDir);
  const target = normalize(join(root, urlPath));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

export function createHttpHandler(opts: HttpHandlerOpts) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method Not Allowed');
      return;
    }

    const parsed = new URL(req.url ?? '/', 'http://placeholder');
    const queryToken = parsed.searchParams.get('token');

    if (queryToken) {
      if (!tokensMatch(queryToken, opts.token)) {
        send(res, 401, 'Invalid token');
        return;
      }
      applySecurity(res);
      res.statusCode = 302;
      res.setHeader('Location', parsed.pathname || '/');
      res.setHeader('Set-Cookie', buildSessionCookie(opts.token));
      res.end();
      return;
    }

    const cookies = parseCookie(req.headers.cookie);
    const cookieToken = cookies.bridge_session;
    if (!cookieToken) {
      send(res, 401, 'Token required. Append ?token=<TOKEN> to the URL.');
      return;
    }
    if (!tokensMatch(cookieToken, opts.token)) {
      send(res, 401, 'Invalid token');
      return;
    }

    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!isOriginAllowed(origin, host)) {
      send(res, 403, 'Origin mismatch');
      return;
    }

    const urlPath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
    const filePath = safeResolveStaticPath(opts.staticDir, urlPath);
    if (!filePath) {
      send(res, 400, 'Bad path');
      return;
    }

    let st;
    try {
      st = await stat(filePath);
    } catch {
      send(res, 404, 'Not found');
      return;
    }
    if (!st.isFile()) {
      send(res, 404, 'Not found');
      return;
    }

    const ext = filePath.slice(filePath.lastIndexOf('.'));
    const ct = MIME[ext] ?? 'application/octet-stream';

    applySecurity(res);
    res.statusCode = 200;
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Length', String(st.size));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run bridge:test -- http-server
```

Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/http-server.ts packages/bridge/src/__tests__/http-server.test.ts
git commit -m "feat(bridge): add HTTP handler with bootstrap, static, and security headers"
```

---

## Task 11: `websocket.ts` — upgrade auth + protocol routing

**Files:**
- Create: `packages/bridge/src/websocket.ts`
- Create: `packages/bridge/src/__tests__/websocket.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/bridge/src/__tests__/websocket.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { attachWebSocket } from '../websocket.js';
import { SessionManager } from '../session.js';
import { EventEmitter } from 'node:events';

const TOKEN = 'a'.repeat(32);

class FakeProc extends EventEmitter {
  sendUserText = vi.fn();
  kill = vi.fn();
}

async function startServer() {
  const procs: FakeProc[] = [];
  const mgr = new SessionManager({
    allowedDirs: ['/Users/test'],
    bufferCap: 100,
    spawnClaude: () => {
      const p = new FakeProc();
      procs.push(p);
      return p as unknown as import('../claude-process.js').ClaudeProcess;
    },
    realpath: async (p) => p,
  });
  const server = createServer();
  attachWebSocket({ server, token: TOKEN, sessionManager: mgr });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no addr');
  return {
    server: server as Server,
    port: addr.port,
    mgr,
    procs,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
}

function ws(url: string, headers: Record<string, string> = {}) {
  return new WebSocket(url, { headers });
}

function once<T>(emitter: EventEmitter, event: string): Promise<T> {
  return new Promise((r) => emitter.once(event, (v) => r(v as T)));
}

describe('websocket', () => {
  it('rejects upgrade without token', async () => {
    const { port, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`);
    const code = await new Promise<number>((r) => sock.on('unexpected-response', (_req, res) => r(res.statusCode ?? 0)));
    expect(code).toBe(401);
    await close();
  });

  it('rejects upgrade with wrong Origin and valid cookie', async () => {
    const { port, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: 'http://evil.com',
    });
    const code = await new Promise<number>((r) => sock.on('unexpected-response', (_req, res) => r(res.statusCode ?? 0)));
    expect(code).toBe(403);
    await close();
  });

  it('accepts upgrade with valid cookie and matching Origin and sends init', async () => {
    const { port, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    const opened = new Promise<void>((r) => sock.on('open', () => r()));
    await opened;
    const msg = await once<Buffer>(sock as unknown as EventEmitter, 'message');
    expect(JSON.parse(msg.toString())).toEqual({ type: 'system', event: 'init' });
    sock.close();
    await close();
  });

  it('routes start → session_created broadcast', async () => {
    const { port, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message'); // init

    const messages: unknown[] = [];
    sock.on('message', (raw) => messages.push(JSON.parse(raw.toString())));

    sock.send(JSON.stringify({ type: 'start', agent: 'claude', projectPath: '/Users/test/proj' }));
    await new Promise((r) => setTimeout(r, 50));

    const created = messages.find(
      (m) => (m as { type: string; event?: string }).type === 'system' && (m as { event?: string }).event === 'session_created',
    );
    expect(created).toBeTruthy();
    sock.close();
    await close();
  });

  it('routes input → process.sendUserText', async () => {
    const { port, mgr, procs, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message'); // init

    const session = await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });
    sock.send(JSON.stringify({ type: 'input', sessionId: session.sessionId, text: 'hello' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(procs[0]!.sendUserText).toHaveBeenCalledWith('hello');
    sock.close();
    await close();
  });

  it('replies session_list to list_sessions', async () => {
    const { port, mgr, close } = await startServer();
    await mgr.create({ agent: 'claude', projectPath: '/Users/test/proj' });

    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message'); // init

    const got = new Promise<unknown>((r) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'session_list') r(m);
      });
    });
    sock.send(JSON.stringify({ type: 'list_sessions', correlationId: 'c1' }));
    const msg = (await got) as { type: string; sessions: unknown[]; correlationId?: string };
    expect(msg.type).toBe('session_list');
    expect(msg.sessions).toHaveLength(1);
    expect(msg.correlationId).toBe('c1');
    sock.close();
    await close();
  });

  it('returns error for malformed JSON input', async () => {
    const { port, close } = await startServer();
    const sock = ws(`ws://127.0.0.1:${port}/ws`, {
      cookie: `bridge_session=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    await new Promise<void>((r) => sock.on('open', () => r()));
    await once(sock as unknown as EventEmitter, 'message'); // init

    const got = new Promise<{ type: string; code?: string }>((r) => {
      sock.on('message', (raw) => r(JSON.parse(raw.toString())));
    });
    sock.send('not json');
    const m = await got;
    expect(m.type).toBe('error');
    expect(m.code).toBe('unsupported_message');
    sock.close();
    await close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run bridge:test -- websocket
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/bridge/src/websocket.ts`**

```ts
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  extractTokenFromRequest,
  isOriginAllowed,
  tokensMatch,
} from './auth.js';
import type { SessionManager } from './session.js';
import type {
  ClientMsg,
  ServerErrorMsg,
  ServerMsg,
} from './types.js';

const MAX_MSG_BYTES = 16 * 1024 * 1024;

export interface AttachWsOpts {
  server: HttpServer;
  token: string;
  sessionManager: SessionManager;
}

export function attachWebSocket(opts: AttachWsOpts): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });

  opts.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const token = extractTokenFromRequest(req);
    if (!token || !tokensMatch(token, opts.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!isOriginAllowed(req.headers.origin, req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const send = (m: ServerMsg) => {
      try {
        ws.send(JSON.stringify(m));
      } catch {
        /* ignore */
      }
    };

    const broadcast = (m: ServerMsg) => send(m);
    opts.sessionManager.on('broadcast', broadcast);
    ws.on('close', () => opts.sessionManager.off('broadcast', broadcast));

    send({ type: 'system', event: 'init' });

    ws.on('message', (raw) => handleMessage(ws, raw, opts.sessionManager, send));
  });

  return wss;
}

async function handleMessage(
  _ws: WebSocket,
  raw: import('ws').RawData,
  mgr: SessionManager,
  send: (m: ServerMsg) => void,
): Promise<void> {
  let msg: ClientMsg;
  try {
    msg = JSON.parse(raw.toString()) as ClientMsg;
  } catch {
    sendError(send, 'unsupported_message', 'malformed JSON');
    return;
  }
  if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
    sendError(send, 'unsupported_message', 'missing type');
    return;
  }

  try {
    switch (msg.type) {
      case 'start': {
        await mgr.create({ agent: msg.agent, projectPath: msg.projectPath });
        return;
      }
      case 'input': {
        mgr.sendInput(msg.sessionId, msg.text);
        return;
      }
      case 'stop_session': {
        mgr.stop(msg.sessionId);
        return;
      }
      case 'list_sessions': {
        send({
          type: 'session_list',
          sessions: mgr.listSessions(),
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
        });
        return;
      }
      case 'get_history': {
        const h = mgr.getHistory(msg.sessionId, msg.since ?? 0);
        send({
          type: 'history',
          sessionId: msg.sessionId,
          events: h.events,
          hasMore: h.hasMore,
          ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
        });
        return;
      }
      default:
        sendError(send, 'unsupported_message', `unknown type ${(msg as { type: string }).type}`, (msg as { correlationId?: string }).correlationId);
    }
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'path_outside_allowlist') {
      sendError(send, 'path_outside_allowlist', e.message ?? 'path outside allowlist', (msg as { correlationId?: string }).correlationId);
      return;
    }
    if (e.code === 'session_dead') {
      sendError(send, 'session_dead', e.message ?? 'session dead', (msg as { correlationId?: string }).correlationId);
      return;
    }
    sendError(send, 'unsupported_message', e.message ?? 'internal error', (msg as { correlationId?: string }).correlationId);
  }
}

function sendError(
  send: (m: ServerMsg) => void,
  code: ServerErrorMsg['code'],
  message: string,
  correlationId?: string,
): void {
  send({ type: 'error', code, message, ...(correlationId ? { correlationId } : {}) });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run bridge:test -- websocket
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/websocket.ts packages/bridge/src/__tests__/websocket.test.ts
git commit -m "feat(bridge): add WebSocket upgrade auth and protocol router"
```

---

## Task 12: `index.ts` — boot entrypoint

**Files:**
- Modify: `packages/bridge/src/index.ts`

This wires everything together. The boot logic is integration-shaped; we verify it by running it manually rather than with Vitest.

- [ ] **Step 1: Replace `packages/bridge/src/index.ts`**

```ts
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ClaudeProcess } from './claude-process.js';
import { loadEnv } from './env.js';
import { resolveTailscaleIPv4 } from './tailscale.js';
import { createHttpHandler } from './http-server.js';
import { attachWebSocket } from './websocket.js';
import { SessionManager } from './session.js';

async function main(): Promise<void> {
  const cfg = loadEnv(process.env);

  const bindHost = cfg.bindHost ?? (await resolveTailscaleIPv4());
  console.log(`[bridge] binding to ${bindHost}:${cfg.port}`);

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../apps/web/dist'),
    resolve(here, '../../apps/web/dist'),
  ];
  const staticDir = candidates.find((p) => existsSync(p));
  if (!staticDir) {
    throw new Error(`web bundle not found. Run \`npm run web:build\`. Looked in:\n  ${candidates.join('\n  ')}`);
  }
  console.log(`[bridge] serving static bundle from ${staticDir}`);

  const sessionManager = new SessionManager({
    allowedDirs: cfg.allowedDirs,
    bufferCap: 1000,
    spawnClaude: (path) => new ClaudeProcess(path),
  });

  const handler = createHttpHandler({ token: cfg.token, staticDir });
  const server = createServer(handler);
  attachWebSocket({ server, token: cfg.token, sessionManager });

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(cfg.port, bindHost, () => res());
  });

  console.log(`[bridge] open: http://${bindHost}:${cfg.port}/?token=<TOKEN>`);

  const shutdown = (): void => {
    console.log('[bridge] shutting down');
    sessionManager.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 6000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[bridge] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify type-check**

```bash
npx tsc --noEmit -p packages/bridge/tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Verify boot fails fast without token**

```bash
unset BRIDGE_TOKEN
npm run bridge:dev 2>&1 | head -5
```

Expected: error mentioning `BRIDGE_TOKEN`. Kill with Ctrl-C if needed.

- [ ] **Step 4: Verify boot fails fast without Tailscale**

```bash
BRIDGE_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))') BRIDGE_BIND_HOST=127.0.0.1 npm run bridge:dev &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8765/"
kill %1
```

Expected: `401` (no cookie / no token). Web bundle missing error is acceptable at this stage if `apps/web/dist` doesn't exist yet — confirm the error message points at the bundle path.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/index.ts
git commit -m "feat(bridge): wire boot entrypoint with env, tailscale, http, ws"
```

---

## Task 13: Web app scaffolding (Vite + React + TS)

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/tsconfig.node.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/App.css`

This task is scaffolding — no TDD.

- [ ] **Step 1: Create `apps/web/package.json`**

```json
{
  "name": "@mac-remote-terminal/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0",
    "zustand": "^4.5.4"
  },
  "devDependencies": {
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "happy-dom": "^14.12.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `apps/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src/**/*"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 3: Create `apps/web/tsconfig.node.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "composite": true,
    "types": ["node"]
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: Create `apps/web/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'happy-dom',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

- [ ] **Step 5: Create `apps/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>mac-remote-terminal</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `apps/web/src/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './App.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

- [ ] **Step 7: Create `apps/web/src/App.tsx` (placeholder)**

```tsx
export function App(): JSX.Element {
  return <div>app</div>;
}
```

- [ ] **Step 8: Create `apps/web/src/App.css`**

```css
:root {
  color-scheme: dark light;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
body { margin: 0; }
#root { min-height: 100vh; display: flex; }
```

- [ ] **Step 9: Install + build smoke**

```bash
npm install
npm run web:build
```

Expected: `apps/web/dist/index.html` produced, no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/web/ package-lock.json
git commit -m "chore(web): scaffold Vite + React + TS app"
```

---

## Task 14: Shared protocol types (web side)

**Files:**
- Create: `apps/web/src/types/protocol.ts`

The web side mirrors the bridge protocol types. Phase 1 keeps the two files in sync by hand; a later phase can extract them to a shared package.

- [ ] **Step 1: Create `apps/web/src/types/protocol.ts`**

Copy the contents of `packages/bridge/src/types.ts` exactly. They have no Node-only imports so they paste as-is.

```ts
export type AgentKind = 'claude';

export interface ClientStartMsg {
  type: 'start';
  agent: AgentKind;
  projectPath: string;
  sessionId?: string;
  resume?: boolean;
  correlationId?: string;
}

export interface ClientInputMsg {
  type: 'input';
  sessionId: string;
  text: string;
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

export type ClientMsg =
  | ClientStartMsg
  | ClientInputMsg
  | ClientStopMsg
  | ClientListSessionsMsg
  | ClientGetHistoryMsg;

export interface ServerInitMsg {
  type: 'system';
  event: 'init';
}

export interface ServerLifecycleMsg {
  type: 'system';
  event: 'session_created' | 'session_ended';
  sessionId: string;
  seq: number;
  reason?: string;
  exitCode?: number;
}

export interface ServerStreamMsg {
  type: 'assistant' | 'stream_delta' | 'tool_result' | 'result' | 'status';
  sessionId: string;
  seq: number;
  payload: unknown;
}

export interface ServerSessionListMsg {
  type: 'session_list';
  sessions: Array<{ sessionId: string; agent: AgentKind; projectPath: string; createdAt: number }>;
  correlationId?: string;
}

export interface ServerHistoryMsg {
  type: 'history';
  sessionId: string;
  events: Array<ServerLifecycleMsg | ServerStreamMsg>;
  hasMore: boolean;
  correlationId?: string;
}

export type ServerErrorCode =
  | 'not_authorized'
  | 'origin_mismatch'
  | 'path_outside_allowlist'
  | 'session_dead'
  | 'agent_not_installed'
  | 'message_too_large'
  | 'history_truncated'
  | 'unsupported_message';

export interface ServerErrorMsg {
  type: 'error';
  code: ServerErrorCode;
  message: string;
  correlationId?: string;
}

export type ServerMsg =
  | ServerInitMsg
  | ServerLifecycleMsg
  | ServerStreamMsg
  | ServerSessionListMsg
  | ServerHistoryMsg
  | ServerErrorMsg;
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/types/protocol.ts
git commit -m "feat(web): mirror bridge protocol types"
```

---

## Task 15: `bridge-client.ts` — WebSocket wrapper with reconnect

**Files:**
- Create: `apps/web/src/services/bridge-client.ts`
- Create: `apps/web/src/services/bridge-client.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/src/services/bridge-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BridgeClient } from './bridge-client';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  url: string;
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(new CloseEvent('close', { code: 1000 })); }
  open() { this.readyState = 1; this.onopen?.(new Event('open')); }
  receive(obj: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(obj) })); }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BridgeClient', () => {
  it('connects to /ws relative to origin', () => {
    const client = new BridgeClient();
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.url.endsWith('/ws')).toBe(true);
  });

  it('emits "open" when underlying socket opens', () => {
    const client = new BridgeClient();
    const onOpen = vi.fn();
    client.on('open', onOpen);
    client.connect();
    FakeWebSocket.instances[0]!.open();
    expect(onOpen).toHaveBeenCalled();
  });

  it('emits "message" with parsed JSON payloads', () => {
    const client = new BridgeClient();
    const onMsg = vi.fn();
    client.on('message', onMsg);
    client.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.receive({ type: 'system', event: 'init' });
    expect(onMsg).toHaveBeenCalledWith({ type: 'system', event: 'init' });
  });

  it('send() serializes outgoing messages to JSON', () => {
    const client = new BridgeClient();
    client.connect();
    FakeWebSocket.instances[0]!.open();
    client.send({ type: 'list_sessions' });
    expect(FakeWebSocket.instances[0]!.sent).toEqual([JSON.stringify({ type: 'list_sessions' })]);
  });

  it('reconnects with backoff after close', () => {
    const client = new BridgeClient();
    client.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.close();

    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('caps backoff at MAX_BACKOFF_MS', () => {
    const client = new BridgeClient();
    client.connect();
    for (let i = 0; i < 20; i++) {
      const sock = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
      sock.open();
      sock.close();
      vi.advanceTimersByTime(60_000);
    }
    expect(FakeWebSocket.instances.length).toBeGreaterThan(15);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run web:test -- bridge-client
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/web/src/services/bridge-client.ts`**

```ts
import type { ClientMsg, ServerMsg } from '../types/protocol';

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

type Listener<T> = (value: T) => void;

interface Listeners {
  open: Set<Listener<void>>;
  close: Set<Listener<void>>;
  message: Set<Listener<ServerMsg>>;
  error: Set<Listener<Error>>;
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer: number | null = null;
  private closedByUser = false;
  private listeners: Listeners = {
    open: new Set(),
    close: new Set(),
    message: new Set(),
    error: new Set(),
  };

  on<K extends keyof Listeners>(event: K, fn: Listeners[K] extends Set<infer L> ? L : never): () => void {
    (this.listeners[event] as Set<unknown>).add(fn);
    return () => (this.listeners[event] as Set<unknown>).delete(fn);
  }

  private emit<K extends keyof Listeners>(event: K, value?: unknown): void {
    for (const fn of this.listeners[event] as Set<(v: unknown) => void>) {
      try {
        fn(value);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  connect(): void {
    this.closedByUser = false;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = INITIAL_BACKOFF_MS;
      this.emit('open');
    };
    ws.onclose = () => {
      this.emit('close');
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.onerror = () => {
      this.emit('error', new Error('websocket error'));
    };
    ws.onmessage = (e) => {
      try {
        const parsed = JSON.parse(typeof e.data === 'string' ? e.data : '') as ServerMsg;
        this.emit('message', parsed);
      } catch {
        /* ignore */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.backoff;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      this.connect();
    }, delay);
  }

  send(msg: ClientMsg): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run web:test -- bridge-client
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/bridge-client.ts apps/web/src/services/bridge-client.test.ts
git commit -m "feat(web): add BridgeClient with reconnect"
```

---

## Task 16: Zustand stores (`connection.ts`, `sessions.ts`)

**Files:**
- Create: `apps/web/src/store/connection.ts`
- Create: `apps/web/src/store/sessions.ts`
- Create: `apps/web/src/store/sessions.test.ts`

The connection store is trivial state and doesn't justify a test. The sessions store has reducer-like logic — test it.

- [ ] **Step 1: Create `apps/web/src/store/connection.ts`**

```ts
import { create } from 'zustand';

export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'error';

interface ConnectionStore {
  status: ConnectionStatus;
  lastError: string | null;
  setStatus(s: ConnectionStatus): void;
  setError(e: string | null): void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  status: 'connecting',
  lastError: null,
  setStatus: (status) => set({ status }),
  setError: (lastError) => set({ lastError }),
}));
```

- [ ] **Step 2: Write the failing test for sessions store**

`apps/web/src/store/sessions.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionsStore } from './sessions';

beforeEach(() => {
  useSessionsStore.setState({ sessions: {}, order: [], activeId: null });
});

describe('sessions store', () => {
  it('appends a session_created lifecycle message', () => {
    useSessionsStore.getState().applyServerMsg({
      type: 'system',
      event: 'session_created',
      sessionId: 's1',
      seq: 1,
    });
    const s = useSessionsStore.getState();
    expect(s.order).toEqual(['s1']);
    expect(s.sessions['s1']?.events).toHaveLength(1);
    expect(s.sessions['s1']?.lastSeq).toBe(1);
    expect(s.sessions['s1']?.alive).toBe(true);
  });

  it('marks the session dead on session_ended', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    store.applyServerMsg({
      type: 'system',
      event: 'session_ended',
      sessionId: 's1',
      seq: 5,
      exitCode: 0,
    });
    const s = useSessionsStore.getState().sessions['s1']!;
    expect(s.alive).toBe(false);
    expect(s.lastSeq).toBe(5);
  });

  it('appends stream events and tracks lastSeq', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    store.applyServerMsg({ type: 'stream_delta', sessionId: 's1', seq: 2, payload: { delta: 'hi' } });
    store.applyServerMsg({ type: 'assistant', sessionId: 's1', seq: 3, payload: { text: 'hello' } });
    const s = useSessionsStore.getState().sessions['s1']!;
    expect(s.events).toHaveLength(3);
    expect(s.lastSeq).toBe(3);
  });

  it('replaces session list from session_list message', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({
      type: 'session_list',
      sessions: [
        { sessionId: 's1', agent: 'claude', projectPath: '/p', createdAt: 1 },
        { sessionId: 's2', agent: 'claude', projectPath: '/q', createdAt: 2 },
      ],
    });
    expect(useSessionsStore.getState().order).toEqual(['s1', 's2']);
  });

  it('setActive() only accepts known sessions', () => {
    const store = useSessionsStore.getState();
    store.applyServerMsg({ type: 'system', event: 'session_created', sessionId: 's1', seq: 1 });
    store.setActive('s1');
    expect(useSessionsStore.getState().activeId).toBe('s1');
    store.setActive('unknown');
    expect(useSessionsStore.getState().activeId).toBe('s1');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npm run web:test -- sessions
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `apps/web/src/store/sessions.ts`**

```ts
import { create } from 'zustand';
import type { AgentKind, ServerLifecycleMsg, ServerMsg, ServerStreamMsg } from '../types/protocol';

export type SessionEvent = ServerLifecycleMsg | ServerStreamMsg;

export interface SessionView {
  sessionId: string;
  agent: AgentKind;
  projectPath: string;
  createdAt: number;
  events: SessionEvent[];
  lastSeq: number;
  alive: boolean;
}

interface SessionsStore {
  sessions: Record<string, SessionView>;
  order: string[];
  activeId: string | null;

  applyServerMsg(m: ServerMsg): void;
  setActive(id: string): void;
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  sessions: {},
  order: [],
  activeId: null,

  applyServerMsg(m) {
    if (m.type === 'system' && m.event === 'init') return;

    if (m.type === 'system' && m.event === 'session_created') {
      const exists = get().sessions[m.sessionId];
      const view: SessionView = exists ?? {
        sessionId: m.sessionId,
        agent: 'claude',
        projectPath: '',
        createdAt: Date.now(),
        events: [],
        lastSeq: 0,
        alive: true,
      };
      view.events = [...view.events, m];
      view.lastSeq = m.seq;
      view.alive = true;
      set((s) => ({
        sessions: { ...s.sessions, [m.sessionId]: view },
        order: s.order.includes(m.sessionId) ? s.order : [...s.order, m.sessionId],
      }));
      return;
    }

    if (m.type === 'system' && m.event === 'session_ended') {
      const exists = get().sessions[m.sessionId];
      if (!exists) return;
      const next: SessionView = {
        ...exists,
        events: [...exists.events, m],
        lastSeq: m.seq,
        alive: false,
      };
      set((s) => ({ sessions: { ...s.sessions, [m.sessionId]: next } }));
      return;
    }

    if (
      m.type === 'assistant' ||
      m.type === 'stream_delta' ||
      m.type === 'tool_result' ||
      m.type === 'result' ||
      m.type === 'status'
    ) {
      const exists = get().sessions[m.sessionId];
      if (!exists) return;
      const next: SessionView = {
        ...exists,
        events: [...exists.events, m],
        lastSeq: m.seq,
      };
      set((s) => ({ sessions: { ...s.sessions, [m.sessionId]: next } }));
      return;
    }

    if (m.type === 'session_list') {
      const sessions: Record<string, SessionView> = {};
      const order: string[] = [];
      for (const summary of m.sessions) {
        const existing = get().sessions[summary.sessionId];
        sessions[summary.sessionId] = existing ?? {
          sessionId: summary.sessionId,
          agent: summary.agent,
          projectPath: summary.projectPath,
          createdAt: summary.createdAt,
          events: [],
          lastSeq: 0,
          alive: true,
        };
        order.push(summary.sessionId);
      }
      set({ sessions, order });
      return;
    }
  },

  setActive(id) {
    if (!get().sessions[id]) return;
    set({ activeId: id });
  },
}));
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm run web:test -- sessions
```

Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/store/connection.ts apps/web/src/store/sessions.ts apps/web/src/store/sessions.test.ts
git commit -m "feat(web): add connection and sessions Zustand stores"
```

---

## Task 17: Project picker + session list components

**Files:**
- Create: `apps/web/src/features/project-picker/ProjectPicker.tsx`
- Create: `apps/web/src/features/project-picker/ProjectPicker.css`
- Create: `apps/web/src/features/session-list/SessionList.tsx`
- Create: `apps/web/src/features/session-list/SessionList.css`

Phase 1 project picker is a typed-path dialog with an in-memory recent list (persisted to `localStorage`). Filesystem browsing is Phase 4.

- [ ] **Step 1: Create `ProjectPicker.tsx`**

```tsx
import { useEffect, useState } from 'react';
import './ProjectPicker.css';

const RECENT_KEY = 'mrt.recentProjects';
const RECENT_MAX = 10;

function loadRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecents(list: string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* ignore */
  }
}

export function rememberRecentProject(path: string): void {
  const current = loadRecents();
  const next = [path, ...current.filter((p) => p !== path)];
  saveRecents(next);
}

interface ProjectPickerProps {
  onPick(path: string): void;
  onCancel(): void;
}

export function ProjectPicker({ onPick, onCancel }: ProjectPickerProps): JSX.Element {
  const [path, setPath] = useState('');
  const [recents, setRecents] = useState<string[]>([]);

  useEffect(() => {
    setRecents(loadRecents());
  }, []);

  const submit = (chosen: string): void => {
    const trimmed = chosen.trim();
    if (trimmed.length === 0) return;
    rememberRecentProject(trimmed);
    onPick(trimmed);
  };

  return (
    <div className="picker-backdrop">
      <div className="picker">
        <h2>Pick a project</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(path);
          }}
        >
          <input
            type="text"
            placeholder="/Users/you/code/some-project"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            autoFocus
          />
          <div className="picker-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit">Open</button>
          </div>
        </form>
        {recents.length > 0 && (
          <>
            <h3>Recent</h3>
            <ul className="picker-recents">
              {recents.map((p) => (
                <li key={p}>
                  <button type="button" onClick={() => submit(p)}>
                    {p}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `ProjectPicker.css`**

```css
.picker-backdrop {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center;
  z-index: 10;
}
.picker {
  background: #1f1f1f; color: #eee;
  padding: 1.5rem; border-radius: 8px;
  width: min(560px, 90vw);
}
.picker h2, .picker h3 { margin: 0 0 0.5rem; }
.picker input { width: 100%; padding: 0.5rem; box-sizing: border-box; }
.picker-actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 0.75rem; }
.picker-recents { list-style: none; padding: 0; max-height: 200px; overflow-y: auto; }
.picker-recents button { background: none; border: 1px solid #333; color: #ccc; width: 100%; text-align: left; padding: 0.4rem; margin-bottom: 0.2rem; cursor: pointer; }
.picker-recents button:hover { background: #2a2a2a; }
```

- [ ] **Step 3: Create `SessionList.tsx`**

```tsx
import type { SessionView } from '../../store/sessions';
import './SessionList.css';

interface SessionListProps {
  sessions: SessionView[];
  activeId: string | null;
  onSelect(id: string): void;
  onNewSession(): void;
}

export function SessionList({ sessions, activeId, onSelect, onNewSession }: SessionListProps): JSX.Element {
  return (
    <aside className="session-list">
      <button className="session-new" type="button" onClick={onNewSession}>
        + New Claude session
      </button>
      <ul>
        {sessions.length === 0 && <li className="session-empty">No active sessions</li>}
        {sessions.map((s) => {
          const label = s.projectPath.split('/').filter(Boolean).pop() ?? s.projectPath;
          return (
            <li
              key={s.sessionId}
              className={`session-row${s.sessionId === activeId ? ' active' : ''}${!s.alive ? ' ended' : ''}`}
            >
              <button type="button" onClick={() => onSelect(s.sessionId)}>
                <div className="session-label">{label}</div>
                <div className="session-path">{s.projectPath}</div>
                {!s.alive && <div className="session-ended">ended</div>}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
```

- [ ] **Step 4: Create `SessionList.css`**

```css
.session-list { width: 240px; background: #181818; color: #ccc; padding: 0.5rem; box-sizing: border-box; }
.session-list ul { list-style: none; padding: 0; margin: 0; }
.session-new { width: 100%; padding: 0.5rem; background: #2d6cdf; color: white; border: none; cursor: pointer; margin-bottom: 0.5rem; }
.session-empty { color: #666; padding: 0.5rem; font-size: 0.9rem; }
.session-row button { width: 100%; text-align: left; background: none; border: 1px solid #2a2a2a; color: inherit; padding: 0.5rem; margin-bottom: 0.25rem; cursor: pointer; }
.session-row.active button { border-color: #2d6cdf; background: #1c2a44; }
.session-row.ended button { opacity: 0.5; }
.session-label { font-weight: 600; }
.session-path { font-size: 0.75rem; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-ended { font-size: 0.7rem; color: #d97; margin-top: 0.25rem; }
```

- [ ] **Step 5: Verify type-check**

```bash
npm run web:typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/project-picker apps/web/src/features/session-list
git commit -m "feat(web): add project picker and session list"
```

---

## Task 18: Chat components (`Chat`, `MessageBubble`, `InputBox`)

**Files:**
- Create: `apps/web/src/features/chat/MessageBubble.tsx`
- Create: `apps/web/src/features/chat/InputBox.tsx`
- Create: `apps/web/src/features/chat/Chat.tsx`
- Create: `apps/web/src/features/chat/Chat.css`

Plain-text rendering only — no markdown. Tool-use blocks render collapsed by default.

- [ ] **Step 1: Create `MessageBubble.tsx`**

```tsx
import { useState } from 'react';
import type { SessionEvent } from '../../store/sessions';

interface MessageBubbleProps {
  event: SessionEvent;
}

export function MessageBubble({ event }: MessageBubbleProps): JSX.Element | null {
  if (event.type === 'system' && event.event === 'session_created') {
    return <div className="bubble system">session started</div>;
  }
  if (event.type === 'system' && event.event === 'session_ended') {
    return <div className="bubble system">session ended (exit {event.exitCode ?? '?'})</div>;
  }
  if (event.type === 'stream_delta') {
    const delta = (event.payload as { delta?: string }).delta ?? '';
    return <span className="bubble-delta">{delta}</span>;
  }
  if (event.type === 'assistant') {
    const payload = event.payload as { text?: string; toolUse?: { toolName: string; input: unknown } };
    if (payload.text) {
      return <div className="bubble assistant">{payload.text}</div>;
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
  if (event.type === 'result') {
    const payload = event.payload as { cost?: number; durationMs?: number };
    const parts: string[] = [];
    if (typeof payload.durationMs === 'number') parts.push(`${payload.durationMs} ms`);
    if (typeof payload.cost === 'number') parts.push(`$${payload.cost.toFixed(4)}`);
    return <div className="bubble system">turn complete{parts.length > 0 ? ` (${parts.join(', ')})` : ''}</div>;
  }
  return null;
}

function ToolUseBubble({ toolName, input }: { toolName: string; input: unknown }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="bubble tool-use">
      <button type="button" onClick={() => setOpen((o) => !o)}>
        {open ? '▼' : '▶'} tool: {toolName}
      </button>
      {open && <pre>{JSON.stringify(input, null, 2)}</pre>}
    </div>
  );
}

function ToolResultBubble({ output }: { output: unknown }): JSX.Element {
  const [open, setOpen] = useState(false);
  const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  return (
    <div className="bubble tool-result">
      <button type="button" onClick={() => setOpen((o) => !o)}>
        {open ? '▼' : '▶'} tool result ({text.length} chars)
      </button>
      {open && <pre>{text}</pre>}
    </div>
  );
}
```

- [ ] **Step 2: Create `InputBox.tsx`**

```tsx
import { useState, type KeyboardEvent } from 'react';

interface InputBoxProps {
  onSend(text: string): void;
  onStop(): void;
  disabled: boolean;
}

export function InputBox({ onSend, onStop, disabled }: InputBoxProps): JSX.Element {
  const [text, setText] = useState('');

  const submit = (): void => {
    const t = text.trim();
    if (t.length === 0) return;
    onSend(t);
    setText('');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="input-box">
      <textarea
        value={text}
        placeholder="Type a prompt. Cmd/Ctrl+Enter to send."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        rows={3}
        disabled={disabled}
      />
      <div className="input-actions">
        <button type="button" onClick={onStop} disabled={disabled}>
          Stop
        </button>
        <button type="button" onClick={submit} disabled={disabled || text.trim().length === 0}>
          Send
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create `Chat.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import type { SessionView } from '../../store/sessions';
import { MessageBubble } from './MessageBubble';
import { InputBox } from './InputBox';
import './Chat.css';

interface ChatProps {
  session: SessionView;
  onSend(text: string): void;
  onStop(): void;
}

export function Chat({ session, onSend, onStop }: ChatProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.events]);

  return (
    <div className="chat">
      <div className="chat-header">
        <code>{session.projectPath}</code>
        <span>session {session.sessionId.slice(0, 8)}</span>
      </div>
      <div className="chat-scroll" ref={scrollRef}>
        {session.events.map((e, i) => (
          <MessageBubble key={`${i}-${e.type}-${e.type === 'system' ? e.event : (e as { seq: number }).seq}`} event={e} />
        ))}
      </div>
      <InputBox onSend={onSend} onStop={onStop} disabled={!session.alive} />
    </div>
  );
}
```

- [ ] **Step 4: Create `Chat.css`**

```css
.chat { flex: 1; display: flex; flex-direction: column; background: #111; color: #ddd; height: 100vh; }
.chat-header { padding: 0.5rem 1rem; background: #181818; display: flex; justify-content: space-between; font-size: 0.85rem; color: #888; border-bottom: 1px solid #222; }
.chat-scroll { flex: 1; overflow-y: auto; padding: 1rem; font-family: ui-monospace, Menlo, monospace; font-size: 0.9rem; line-height: 1.4; }
.bubble { margin-bottom: 0.75rem; padding: 0.5rem 0.75rem; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
.bubble.system { color: #888; font-style: italic; background: transparent; padding-left: 0; }
.bubble.assistant { background: #1c2a44; }
.bubble-delta { background: #1c2a44; padding: 0 0.25rem; }
.bubble.tool-use, .bubble.tool-result { background: #2a2a1c; }
.bubble.tool-use button, .bubble.tool-result button { background: none; border: none; color: inherit; cursor: pointer; padding: 0; }
.bubble pre { background: #000; color: #afa; padding: 0.5rem; overflow-x: auto; font-size: 0.8rem; }
.input-box { padding: 0.5rem; background: #181818; border-top: 1px solid #222; }
.input-box textarea { width: 100%; box-sizing: border-box; background: #111; color: #ddd; border: 1px solid #333; padding: 0.5rem; font-family: inherit; resize: vertical; }
.input-actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 0.5rem; }
.input-actions button { padding: 0.4rem 1rem; cursor: pointer; }
```

- [ ] **Step 5: Verify type-check**

```bash
npm run web:typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/chat
git commit -m "feat(web): add chat components"
```

---

## Task 19: Pages and routing (`Home`, `Session`, `App`)

**Files:**
- Create: `apps/web/src/pages/Home.tsx`
- Create: `apps/web/src/pages/Session.tsx`
- Modify: `apps/web/src/App.tsx`

This task wires the BridgeClient into a singleton, dispatches incoming messages into the sessions store, and routes between the home (session list) and per-session views.

- [ ] **Step 1: Replace `apps/web/src/App.tsx`**

```tsx
import { useEffect, useMemo } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { BridgeClient } from './services/bridge-client';
import { useConnectionStore } from './store/connection';
import { useSessionsStore } from './store/sessions';
import { Home } from './pages/Home';
import { Session } from './pages/Session';

export function App(): JSX.Element {
  const setStatus = useConnectionStore((s) => s.setStatus);
  const setError = useConnectionStore((s) => s.setError);
  const apply = useSessionsStore((s) => s.applyServerMsg);

  const client = useMemo(() => new BridgeClient(), []);

  useEffect(() => {
    const offOpen = client.on('open', () => {
      setStatus('open');
      client.send({ type: 'list_sessions' });
    });
    const offClose = client.on('close', () => setStatus('closed'));
    const offError = client.on('error', (e) => {
      setStatus('error');
      setError(e.message);
    });
    const offMessage = client.on('message', (m) => apply(m));

    client.connect();

    return () => {
      offOpen();
      offClose();
      offError();
      offMessage();
      client.close();
    };
  }, [client, setStatus, setError, apply]);

  return (
    <Routes>
      <Route path="/" element={<Home client={client} />} />
      <Route path="/session/:id" element={<Session client={client} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
```

- [ ] **Step 2: Create `apps/web/src/pages/Home.tsx`**

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionsStore } from '../store/sessions';
import { useConnectionStore } from '../store/connection';
import type { BridgeClient } from '../services/bridge-client';
import { SessionList } from '../features/session-list/SessionList';
import { ProjectPicker } from '../features/project-picker/ProjectPicker';

interface HomeProps {
  client: BridgeClient;
}

export function Home({ client }: HomeProps): JSX.Element {
  const order = useSessionsStore((s) => s.order);
  const sessionsMap = useSessionsStore((s) => s.sessions);
  const status = useConnectionStore((s) => s.status);
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);

  const sessions = order.map((id) => sessionsMap[id]!).filter((s) => s !== undefined);

  return (
    <>
      <SessionList
        sessions={sessions}
        activeId={null}
        onSelect={(id) => navigate(`/session/${id}`)}
        onNewSession={() => setPickerOpen(true)}
      />
      <main className="home-main">
        <h1>mac-remote-terminal</h1>
        <p>connection: {status}</p>
        <p>{sessions.length === 0 ? 'No sessions yet. Click + New Claude session.' : 'Pick a session from the sidebar.'}</p>
      </main>
      {pickerOpen && (
        <ProjectPicker
          onCancel={() => setPickerOpen(false)}
          onPick={(path) => {
            client.send({ type: 'start', agent: 'claude', projectPath: path });
            setPickerOpen(false);
          }}
        />
      )}
    </>
  );
}
```

- [ ] **Step 3: Create `apps/web/src/pages/Session.tsx`**

```tsx
import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSessionsStore } from '../store/sessions';
import type { BridgeClient } from '../services/bridge-client';
import { SessionList } from '../features/session-list/SessionList';
import { Chat } from '../features/chat/Chat';

interface SessionProps {
  client: BridgeClient;
}

export function Session({ client }: SessionProps): JSX.Element {
  const { id } = useParams();
  const navigate = useNavigate();
  const order = useSessionsStore((s) => s.order);
  const sessionsMap = useSessionsStore((s) => s.sessions);
  const setActive = useSessionsStore((s) => s.setActive);
  const session = id ? sessionsMap[id] : undefined;

  useEffect(() => {
    if (id) setActive(id);
  }, [id, setActive]);

  useEffect(() => {
    if (!id || !session) return;
    client.send({ type: 'get_history', sessionId: id, since: session.lastSeq });
  }, [client, id, session]);

  if (!session) {
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
        onNewSession={() => navigate('/')}
      />
      <Chat
        session={session}
        onSend={(text) => client.send({ type: 'input', sessionId: session.sessionId, text })}
        onStop={() => client.send({ type: 'stop_session', sessionId: session.sessionId })}
      />
    </>
  );
}
```

- [ ] **Step 4: Augment `App.css` with home styles**

Append to `apps/web/src/App.css`:

```css
.home-main { flex: 1; padding: 2rem; color: #ccc; }
.home-main h1 { margin-top: 0; }
```

- [ ] **Step 5: Verify build**

```bash
npm run web:build
```

Expected: build succeeds.

- [ ] **Step 6: Auto-navigate to new session when bridge confirms creation**

After a session is created (server emits `session_created`), the user should land in its session view. Add a small effect in `Home.tsx` that watches `order` and pushes to the latest one when the picker has just been used.

Modify `Home.tsx` — replace the `pickerOpen` block with a tracker:

```tsx
import { useEffect, useRef, useState } from 'react';
// ...other imports unchanged...

export function Home({ client }: HomeProps): JSX.Element {
  const order = useSessionsStore((s) => s.order);
  const sessionsMap = useSessionsStore((s) => s.sessions);
  const status = useConnectionStore((s) => s.status);
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);
  const awaitingRef = useRef(false);
  const knownCountRef = useRef(order.length);

  useEffect(() => {
    if (awaitingRef.current && order.length > knownCountRef.current) {
      const last = order[order.length - 1];
      awaitingRef.current = false;
      knownCountRef.current = order.length;
      if (last) navigate(`/session/${last}`);
    } else {
      knownCountRef.current = order.length;
    }
  }, [order, navigate]);

  const sessions = order.map((id) => sessionsMap[id]!).filter((s) => s !== undefined);

  return (
    <>
      <SessionList
        sessions={sessions}
        activeId={null}
        onSelect={(id) => navigate(`/session/${id}`)}
        onNewSession={() => setPickerOpen(true)}
      />
      <main className="home-main">
        <h1>mac-remote-terminal</h1>
        <p>connection: {status}</p>
        <p>{sessions.length === 0 ? 'No sessions yet. Click + New Claude session.' : 'Pick a session from the sidebar.'}</p>
      </main>
      {pickerOpen && (
        <ProjectPicker
          onCancel={() => setPickerOpen(false)}
          onPick={(path) => {
            awaitingRef.current = true;
            client.send({ type: 'start', agent: 'claude', projectPath: path });
            setPickerOpen(false);
          }}
        />
      )}
    </>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/App.css apps/web/src/pages
git commit -m "feat(web): wire pages and routing for Phase 1"
```

---

## Task 20: Manual end-to-end smoke test

This task does not change code. It verifies the full system works against a real Claude binary over Tailscale. Skip steps that don't apply to your dev box (e.g., if you're not on Tailscale yet, set `BRIDGE_BIND_HOST=127.0.0.1`).

**Pre-reqs:** `claude` CLI installed and logged in; `tailscale` running (or accept `BRIDGE_BIND_HOST=127.0.0.1` for local-only smoke).

- [ ] **Step 1: Build everything**

```bash
npm run build
```

Expected: `apps/web/dist/index.html` and `packages/bridge/dist/index.js` produced.

- [ ] **Step 2: Generate a token**

```bash
export BRIDGE_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
echo "token: $BRIDGE_TOKEN"
```

- [ ] **Step 3: Start the bridge**

```bash
node packages/bridge/dist/index.js
```

Expected: log line like `[bridge] open: http://100.x.x.x:8765/?token=<TOKEN>` (or `127.0.0.1` if `BRIDGE_BIND_HOST` is set).

- [ ] **Step 4: Open in a browser**

Open `http://<bind-host>:8765/?token=$BRIDGE_TOKEN` in Safari or Chrome.

Expected:
- Browser is redirected to `/` (no token in the address bar).
- Page renders with sidebar + "No sessions yet" message.
- DevTools → Application → Cookies shows `bridge_session` set with HttpOnly + SameSite=Strict.

- [ ] **Step 5: Spawn a Claude session**

Click `+ New Claude session`. Type a project path inside `BRIDGE_ALLOWED_DIRS` (default `$HOME`). Click Open.

Expected:
- Sidebar gains a new session row.
- Page navigates to `/session/<uuid>`.
- Chat view shows "session started" bubble.

- [ ] **Step 6: Send a turn**

In the chat input, type `say hello`, press Cmd/Ctrl+Enter.

Expected:
- Streaming text bubbles appear as Claude streams.
- Final assistant text bubble after stream completes.
- `turn complete` system bubble at the end.

- [ ] **Step 7: Reload mid-session**

After sending the turn but before completion, hit Cmd-R / Ctrl-R.

Expected:
- Cookie keeps the user authed.
- Bridge connection re-established.
- Session view repopulates from `get_history` replay.
- New events stream in cleanly with no duplicates (matching `lastSeq` boundary).

- [ ] **Step 8: Stop the session**

Click Stop.

Expected:
- Bubble: "session ended (exit ?)".
- Sidebar row dimmed with "ended".
- Chat input disabled.

- [ ] **Step 9: Stop the bridge**

Ctrl-C in the bridge terminal.

Expected: bridge logs `shutting down`, exits cleanly.

- [ ] **Step 10: Tag the slice**

```bash
git tag phase-1-vertical-slice
```

The tag is local-only — push if you've added a remote.

---

## Self-Review (run before declaring done)

Before claiming Phase 1 complete:

1. `npm run typecheck` — no errors in either workspace.
2. `npm run test` — all bridge and web unit tests pass.
3. `npm run build` — both packages build cleanly.
4. The manual smoke test (Task 20) was executed against a real Claude binary, not just unit-tested.
5. The bridge refuses to start when `BRIDGE_TOKEN` is missing or short.
6. The bridge refuses to start when neither Tailscale nor `BRIDGE_BIND_HOST` is available.
7. A `?token=<wrong>` request returns 401, not a redirect.
8. A request with a valid cookie but `Origin: http://evil.com` returns 403.
9. Cookie is `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Secure`.

If any of these fail, fix before moving to Phase 2 — do NOT pile fixes onto Phase 2's plan.
