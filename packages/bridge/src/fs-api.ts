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
  private resolvedAllowedDirs: string[] | null = null;

  constructor(opts: FsApiOpts) {
    this.allowedDirs = opts.allowedDirs;
  }

  private async getResolvedAllowedDirs(): Promise<string[]> {
    if (this.resolvedAllowedDirs) return this.resolvedAllowedDirs;
    const resolved = await Promise.all(
      this.allowedDirs.map((d) => fsRealpath(d).catch(() => d)),
    );
    this.resolvedAllowedDirs = resolved;
    return resolved;
  }

  private async resolveAndGate(path: string): Promise<string> {
    let resolved: string;
    try {
      resolved = await fsRealpath(path);
    } catch {
      throw new FsAccessError('path_outside_allowlist', `cannot resolve ${path}`);
    }
    const resolvedAllowed = await this.getResolvedAllowedDirs();
    if (!isInsideAllowed(resolved, resolvedAllowed)) {
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
    const resolvedAllowed = await this.getResolvedAllowedDirs();
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
      if (!isInsideAllowed(childResolved, resolvedAllowed)) continue;
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
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return 0;
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
