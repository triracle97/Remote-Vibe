import { promises as fsp } from 'node:fs';
import { join, basename, relative } from 'node:path';
import ignoreLib from 'ignore';
import type { SearchHit } from './types.js';

const SURFACE_CAP = 50;
const FILE_CAP_DEFAULT = 5000;
const CACHE_TTL_MS = 30_000;
const PROMPT_TRUNCATE = 80;

const DENY_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'target',
  '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo', '.vercel',
  '.idea', '.vscode', '__pycache__', '.pytest_cache', '.mypy_cache',
  'coverage', '.nyc_output', 'venv', '.venv', 'env', '.env',
]);

interface WalkedFile {
  fullPath: string;
  dirIndex: number;
  rootDir: string;
  mtime: number;
}

interface FileSearchOpts {
  getDirsForSession: (sessionId: string) => string[];
  fileCap?: number;
}

export class FileSearch {
  private cache = new Map<string, { files: WalkedFile[]; truncated: boolean; expiresAt: number }>();

  constructor(private readonly opts: FileSearchOpts) {}

  invalidate(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  async search(
    sessionId: string,
    query: string,
  ): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    const cached = this.cache.get(sessionId);
    let walked: WalkedFile[];
    let truncated: boolean;
    if (cached && Date.now() < cached.expiresAt) {
      walked = cached.files;
      truncated = cached.truncated;
    } else {
      const dirs = this.opts.getDirsForSession(sessionId);
      const result = await walkAll(dirs, this.opts.fileCap ?? FILE_CAP_DEFAULT);
      walked = result.files;
      truncated = result.truncated;
      this.cache.set(sessionId, {
        files: walked,
        truncated,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }
    const hits = rankAndFormat(walked, query);
    return { hits, truncated };
  }
}

async function walkAll(
  dirs: string[],
  cap: number,
): Promise<{ files: WalkedFile[]; truncated: boolean }> {
  const out: WalkedFile[] = [];
  let truncated = false;
  for (let i = 0; i < dirs.length; i++) {
    const root = dirs[i]!;
    const ig = await loadGitignoreChain(root);
    const walked = await walkDir(root, root, i, ig, cap - out.length);
    out.push(...walked.files);
    if (walked.hitCap) {
      truncated = true;
      break;
    }
  }
  return { files: out, truncated };
}

async function loadGitignoreChain(rootDir: string): Promise<ReturnType<typeof ignoreLib>> {
  const ig = ignoreLib();
  try {
    const content = await fsp.readFile(join(rootDir, '.gitignore'), 'utf-8');
    ig.add(content);
  } catch {
    // No .gitignore at root — that's fine
  }
  return ig;
}

async function walkDir(
  rootDir: string,
  curDir: string,
  dirIndex: number,
  ig: ReturnType<typeof ignoreLib>,
  remaining: number,
): Promise<{ files: WalkedFile[]; hitCap: boolean }> {
  const out: WalkedFile[] = [];
  if (remaining <= 0) return { files: out, hitCap: true };

  let entries;
  try {
    entries = await fsp.readdir(curDir, { withFileTypes: true });
  } catch {
    return { files: out, hitCap: false };
  }

  for (const e of entries) {
    if (out.length >= remaining) return { files: out, hitCap: true };
    if (e.isSymbolicLink()) continue; // never follow

    const fullPath = join(curDir, e.name);
    const rel = relative(rootDir, fullPath);

    if (e.isDirectory()) {
      if (DENY_DIRS.has(e.name)) continue;
      // .gitignore: dirs need trailing slash for matching
      if (ig.ignores(rel + '/')) continue;
      const sub = await walkDir(rootDir, fullPath, dirIndex, ig, remaining - out.length);
      out.push(...sub.files);
      if (sub.hitCap) return { files: out, hitCap: true };
    } else if (e.isFile()) {
      if (ig.ignores(rel)) continue;
      try {
        const stat = await fsp.stat(fullPath);
        out.push({
          fullPath,
          dirIndex,
          rootDir,
          mtime: stat.mtimeMs,
        });
      } catch {
        // skip
      }
    }
  }

  return { files: out, hitCap: false };
}

function rankAndFormat(walked: WalkedFile[], query: string): SearchHit[] {
  const q = query.toLowerCase();
  const scored: Array<{ file: WalkedFile; score: number }> = [];

  for (const f of walked) {
    const name = basename(f.fullPath).toLowerCase();
    const path = f.fullPath.toLowerCase();

    let s: number;
    if (q === '') {
      s = f.mtime;
    } else if (name === q) s = 1000;
    else if (name.startsWith(q)) s = 500;
    else if (name.includes(q)) s = 200;
    else if (path.includes(q)) s = 50;
    else continue;

    if (q !== '') {
      const ageDays = Math.max(0, (Date.now() - f.mtime) / 86_400_000);
      s += Math.max(0, 100 - ageDays * (100 / 30));
    }
    scored.push({ file: f, score: s });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, SURFACE_CAP).map(({ file: f }) => {
    const rel = relative(f.rootDir, f.fullPath);
    const insertText =
      f.dirIndex === 0 ? `@${rel}` : `@${basename(f.rootDir)}/${rel}`;
    return {
      insertText,
      fullPath: f.fullPath,
      dirIndex: f.dirIndex,
      mtime: f.mtime,
    };
  });
}
