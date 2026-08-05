import {
  realpath as fsRealpath,
  readdir,
  readFile as fsReadFile,
  stat,
  open,
  writeFile as fsWriteFile,
  rename,
  unlink,
  chmod,
} from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
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
  /** Cap for `readFile`. Callers may still pass a smaller per-call cap. */
  readMaxBytes?: number;
  /** Cap for `writeFile`, checked before anything touches the disk. */
  writeMaxBytes?: number;
}

const FALLBACK_MAX_BYTES = 5 * 1024 * 1024;

export interface DirEntry {
  name: string;
  kind: 'dir' | 'file';
  size?: number;
}

export type FileResult =
  | { kind: 'text'; content: string; bytesRead: number; truncated: boolean; hash: string }
  | { kind: 'binary'; mime?: string; size: number }
  | { kind: 'too_large'; size: number };

export interface WriteResult {
  bytesWritten: number;
  /** Hash of the newly-written content, so the client can keep editing. */
  hash: string;
}

export type FsErrorCode =
  | 'path_outside_allowlist'
  | 'path_denied'
  | 'file_too_large'
  | 'file_conflict'
  | 'file_write_failed';

export class FsAccessError extends Error {
  constructor(public code: FsErrorCode, message: string) {
    super(message);
  }
}

/** Content hash used for optimistic-concurrency checks on write. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
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
    if (DENIED_PATH_SEGMENTS.has(s.toLowerCase())) return true;
  }
  for (const run of DENIED_SEGMENT_RUNS) {
    for (let i = 0; i + run.length <= segs.length; i++) {
      let match = true;
      for (let j = 0; j < run.length; j++) {
        const segLower = (segs[i + j] ?? '').toLowerCase();
        const runLower = run[j]!.toLowerCase();
        if (segLower !== runLower) {
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
  readonly readMaxBytes: number;
  readonly writeMaxBytes: number;

  constructor(opts: FsApiOpts) {
    this.allowedDirs = opts.allowedDirs;
    this.readMaxBytes = opts.readMaxBytes ?? FALLBACK_MAX_BYTES;
    this.writeMaxBytes = opts.writeMaxBytes ?? FALLBACK_MAX_BYTES;
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

  async readFile(path: string, sizeCap: number = this.readMaxBytes): Promise<FileResult> {
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
    return {
      kind: 'text',
      content,
      bytesRead: Buffer.byteLength(content, 'utf8'),
      truncated: false,
      hash: hashContent(content),
    };
  }

  /**
   * Overwrite an existing text file, atomically.
   *
   * Deliberately cannot create files. `resolveAndGate` is built on `realpath`,
   * which only resolves paths that already exist, and that is the property this
   * whole surface leans on: every write lands on a path the allowlist and
   * denylist have already vetted as a real file. Supporting creation would mean
   * gating a *parent* directory and re-deriving the child path by hand — a
   * second, subtly different check next to the audited one. Not worth it for a
   * file drawer whose job is editing what the agent already produced.
   *
   * `baseHash` is an optimistic-concurrency token: pass the hash the client
   * originally read and the write is refused with `file_conflict` if anything
   * (the agent, a build step, another tab) changed the file in the meantime.
   * Omit it to force the write.
   */
  async writeFile(path: string, content: string, baseHash?: string): Promise<WriteResult> {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.writeMaxBytes) {
      throw new FsAccessError(
        'file_too_large',
        `${bytes} bytes exceeds the ${this.writeMaxBytes}-byte write cap`,
      );
    }

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

    if (baseHash !== undefined) {
      let onDisk: string;
      try {
        onDisk = await fsReadFile(resolved, 'utf8');
      } catch (err) {
        throw new FsAccessError('file_write_failed', `cannot read ${resolved}: ${(err as Error).message}`);
      }
      if (hashContent(onDisk) !== baseHash) {
        throw new FsAccessError(
          'file_conflict',
          `${resolved} changed on disk since it was loaded`,
        );
      }
    }

    // tmpfile + rename, so a crash mid-write can never leave a half-file
    // behind. The tmpfile is a sibling, keeping the rename on one filesystem
    // (where it is atomic) and inside the directory the gate already cleared.
    const dir = resolved.slice(0, resolved.lastIndexOf(sep)) || sep;
    const tmp = `${dir}${sep}.${basenameOf(resolved)}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fsWriteFile(tmp, content, 'utf8');
      // Carry the original mode across, or an executable script silently
      // loses its +x bit the first time it is edited from the browser.
      await chmod(tmp, st.mode & 0o7777).catch(() => undefined);
      await rename(tmp, resolved);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw new FsAccessError('file_write_failed', `cannot write ${resolved}: ${(err as Error).message}`);
    }

    return { bytesWritten: bytes, hash: hashContent(content) };
  }
}

async function safeIsDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
