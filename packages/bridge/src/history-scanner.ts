import { promises as fsp } from 'node:fs';
import { join, basename } from 'node:path';
import type { HistoryEntry } from './types.js';

interface ScannerOpts {
  homeDir: string;
  allowedDirs: string[];
  /**
   * Phase 3 allowlist + denylist gate. Should return true iff the path is
   * inside `allowedDirs` AND none of the Phase 3 denylist patterns match.
   * Tests can stub this with a simple prefix check; production code wires
   * the real gate from `fs-api.ts`.
   */
  allowlistGate: (cwd: string) => Promise<boolean> | boolean;
}

interface CandidateFile {
  filePath: string;
  mtime: number;
}

const SURFACE_CAP = 50;
const HEAD_BYTES = 4096;
const FORWARD_SCAN_BYTES = 16384;
const PROMPT_TRUNCATE = 80;
const CACHE_TTL_MS = 60_000;

export class HistoryScanner {
  private cache: { value: { claude: HistoryEntry[]; codex: HistoryEntry[] }; expiresAt: number } | null = null;
  /**
   * Side channel from (agent, sessionId) → backing file path. Populated during
   * each scan. Used by findEntry() to re-stat the file at resume time so a
   * deleted-between-scan-and-click case is detected.
   */
  private filePathByKey = new Map<string, string>();

  constructor(private readonly opts: ScannerOpts) {}

  async list(): Promise<{ claude: HistoryEntry[]; codex: HistoryEntry[] }> {
    if (this.cache !== null && Date.now() < this.cache.expiresAt) {
      return this.cache.value;
    }
    const [claude, codex] = await Promise.all([this.scanClaude(), this.scanCodex()]);
    const value = { claude, codex };
    this.cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  }

  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Look up an entry by (agent, sessionId) AND re-validate the backing file
   * still exists on disk. This catches the spec's "JSONL deleted between scan
   * and click" case. Returns undefined if either the cache lookup or the
   * disk-stat fails.
   *
   * Used by SessionManager.resume() Path 2 to verify a native-history session
   * id maps to a real, currently-on-disk file. Re-runs the scan if cache is
   * missing.
   */
  async findEntry(agent: 'claude' | 'codex', sessionId: string): Promise<HistoryEntry | undefined> {
    const list = await this.list();
    const arr = agent === 'claude' ? list.claude : list.codex;
    const entry = arr.find((e) => e.sessionId === sessionId);
    if (!entry) return undefined;
    const filePath = this.filePathByKey.get(`${agent}:${sessionId}`);
    if (!filePath) return undefined;
    try {
      await fsp.access(filePath); // throws ENOENT if deleted
    } catch {
      return undefined;
    }
    return entry;
  }

  private async scanClaude(): Promise<HistoryEntry[]> {
    const projectsRoot = join(this.opts.homeDir, '.claude', 'projects');
    let projectDirs: string[];
    try {
      projectDirs = (await fsp.readdir(projectsRoot, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => join(projectsRoot, d.name));
    } catch {
      return [];
    }

    const candidates: CandidateFile[] = [];
    for (const dir of projectDirs) {
      let entries: { name: string }[];
      try {
        entries = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && d.name.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const entry of entries) {
        const filePath = join(dir, entry.name);
        try {
          const stat = await fsp.stat(filePath);
          candidates.push({ filePath, mtime: stat.mtimeMs });
        } catch {
          // file vanished between readdir and stat; skip
        }
      }
    }

    candidates.sort((a, b) => b.mtime - a.mtime);

    // Walk candidates by mtime desc, parse + allowlist-filter as we go,
    // stop as soon as we have SURFACE_CAP valid entries. NO over-read cap —
    // the loop is bounded by SURFACE_CAP results (early exit) AND by the
    // total candidate set (typically a few hundred). Per-file work is a
    // single 4 KB read; total worst-case I/O ~MB-scale.
    const out: HistoryEntry[] = [];
    for (const c of candidates) {
      if (out.length >= SURFACE_CAP) break;
      const parsed = await this.parseClaudeFile(c.filePath);
      if (parsed === null) continue;
      const allowed = await this.opts.allowlistGate(parsed.cwd);
      if (!allowed) continue;
      const sid = basename(c.filePath, '.jsonl');
      this.filePathByKey.set(`claude:${sid}`, c.filePath);
      out.push({
        agent: 'claude',
        sessionId: sid,
        projectPath: parsed.cwd,
        mtime: c.mtime,
        firstPrompt: parsed.firstPrompt,
      });
    }
    return out;
  }

  private async scanCodex(): Promise<HistoryEntry[]> {
    const sessionsRoot = join(this.opts.homeDir, '.codex', 'sessions');
    const candidates: CandidateFile[] = [];

    try {
      const years = (await fsp.readdir(sessionsRoot, { withFileTypes: true })).filter((d) => d.isDirectory());
      for (const y of years) {
        const yPath = join(sessionsRoot, y.name);
        const months = (await fsp.readdir(yPath, { withFileTypes: true })).filter((d) => d.isDirectory());
        for (const m of months) {
          const mPath = join(yPath, m.name);
          const days = (await fsp.readdir(mPath, { withFileTypes: true })).filter((d) => d.isDirectory());
          for (const d of days) {
            const dPath = join(mPath, d.name);
            const files = (await fsp.readdir(dPath, { withFileTypes: true })).filter(
              (f) => f.isFile() && f.name.endsWith('.jsonl'),
            );
            for (const f of files) {
              const filePath = join(dPath, f.name);
              try {
                const stat = await fsp.stat(filePath);
                candidates.push({ filePath, mtime: stat.mtimeMs });
              } catch {
                // skip
              }
            }
          }
        }
      }
    } catch {
      return [];
    }

    candidates.sort((a, b) => b.mtime - a.mtime);

    const out: HistoryEntry[] = [];
    for (const c of candidates) {
      if (out.length >= SURFACE_CAP) break;
      const parsed = await this.parseCodexFile(c.filePath);
      if (parsed === null) continue;
      const allowed = await this.opts.allowlistGate(parsed.cwd);
      if (!allowed) continue;
      // Track filePath alongside the entry so resume-time validation can
      // re-stat the backing file. Stored in a side-channel map keyed by
      // (agent, sessionId) — see filePathFor() below.
      this.filePathByKey.set(`codex:${parsed.sessionId}`, c.filePath);
      out.push({
        agent: 'codex',
        sessionId: parsed.sessionId,
        projectPath: parsed.cwd,
        mtime: c.mtime,
        firstPrompt: parsed.firstPrompt,
      });
      if (out.length >= SURFACE_CAP) break;
    }
    return out;
  }

  private async parseClaudeFile(filePath: string): Promise<{ cwd: string; firstPrompt: string } | null> {
    let buf: Buffer;
    try {
      const fh = await fsp.open(filePath, 'r');
      try {
        const slice = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await fh.read(slice, 0, HEAD_BYTES, 0);
        buf = slice.slice(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
    const lines = buf.toString('utf-8').split('\n');
    let cwd: string | null = null;
    let firstPrompt = '';
    for (const line of lines) {
      if (line === '') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof obj !== 'object' || obj === null) continue;
      const o = obj as Record<string, unknown>;
      if (o.type === 'user' && typeof o.cwd === 'string') {
        cwd = o.cwd;
        const msg = o.message as { content?: unknown } | undefined;
        if (msg && typeof msg.content === 'string') {
          firstPrompt = msg.content.slice(0, PROMPT_TRUNCATE);
        } else if (Array.isArray(msg?.content)) {
          // Claude sometimes wraps content as [{ type: 'text', text: '...' }]
          const first = msg!.content.find((c: unknown) => typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text');
          if (first && typeof (first as { text?: unknown }).text === 'string') {
            firstPrompt = ((first as { text: string }).text).slice(0, PROMPT_TRUNCATE);
          }
        }
        break;
      }
    }
    if (cwd === null) return null;
    return { cwd, firstPrompt };
  }

  private async parseCodexFile(filePath: string): Promise<{ sessionId: string; cwd: string; firstPrompt: string } | null> {
    let buf: Buffer;
    try {
      const fh = await fsp.open(filePath, 'r');
      try {
        const slice = Buffer.alloc(FORWARD_SCAN_BYTES);
        const { bytesRead } = await fh.read(slice, 0, FORWARD_SCAN_BYTES, 0);
        buf = slice.slice(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
    const lines = buf.toString('utf-8').split('\n');
    let sessionId: string | null = null;
    let cwd: string | null = null;
    let firstPrompt = '';
    for (const line of lines) {
      if (line === '') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof obj !== 'object' || obj === null) continue;
      const o = obj as Record<string, unknown>;
      if (o.type === 'session_meta' && typeof o.payload === 'object' && o.payload !== null) {
        const p = o.payload as Record<string, unknown>;
        if (typeof p.id === 'string') sessionId = p.id;
        if (typeof p.cwd === 'string') cwd = p.cwd;
      }
      if (firstPrompt === '' && o.type === 'event_msg' && typeof o.payload === 'object' && o.payload !== null) {
        const p = o.payload as Record<string, unknown>;
        if (p.type === 'user_message' && typeof p.text === 'string') {
          firstPrompt = p.text.slice(0, PROMPT_TRUNCATE);
        }
      }
      if (sessionId !== null && cwd !== null && firstPrompt !== '') break;
    }
    if (sessionId === null || cwd === null) return null;
    return { sessionId, cwd, firstPrompt };
  }

  // (No internal isAllowed helper — the gate is invoked inline at the two
  // scan-loop sites via `await this.opts.allowlistGate(parsed.cwd)`. Single
  // SSOT for the security check; any future denylist tightening flows
  // through the injected gate from `fs-api.ts`.)
}
