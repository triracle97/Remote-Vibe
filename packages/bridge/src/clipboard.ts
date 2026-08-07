import { execFile } from 'node:child_process';
import { basename } from 'node:path';

/**
 * The absolute paths behind a Finder copy.
 *
 * The browser cannot supply these. A `File` pulled off a paste event carries a
 * name and bytes and nothing else — every path component is stripped before JS
 * ever sees it — so a ⌘C in Finder arrives in the composer as `notes.md` with
 * no way to reconstruct where it came from. The macOS pasteboard, meanwhile,
 * has held the real `file://` URL the whole time; it is only the browser
 * sandbox in the way.
 *
 * The bridge runs outside that sandbox, on the same Mac, so it can just ask.
 * `NSPasteboard` reads need no entitlement and no user prompt.
 *
 * Two limits worth stating plainly:
 *
 * - **This is the *bridge host's* clipboard**, which is the browser's only when
 *   the two are the same machine. Over Tailscale from a phone they are not, so
 *   a caller must never paste one of these paths on the strength of this call
 *   alone — match it against the basename the browser did see, and drop
 *   anything that does not line up. `matchClipboardPathsByName` is that gate.
 * - **macOS only.** Elsewhere there is no `osascript` and the answer is empty,
 *   which callers already have to handle for "nothing was copied".
 */

const READ_TIMEOUT_MS = 2000;

/**
 * JXA, run through `osascript`, because Node has no pasteboard binding and the
 * alternative is a native module. The last expression is the process's stdout,
 * so the JSON comes back without `console.log` (which JXA sends to stderr).
 */
const PASTEBOARD_SCRIPT = [
  'ObjC.import("AppKit");',
  'const pb = $.NSPasteboard.generalPasteboard;',
  'const objs = pb.readObjectsForClassesOptions($([$.NSURL.class]), $({}));',
  'const out = [];',
  'for (let i = 0; i < objs.count; i++) {',
  '  const u = objs.objectAtIndex(i);',
  '  if (u.isFileURL) out.push(ObjC.unwrap(u.path));',
  '}',
  'JSON.stringify(out);',
].join('\n');

export function readClipboardFilePaths(
  opts: { platform?: NodeJS.Platform } = {},
): Promise<string[]> {
  if ((opts.platform ?? process.platform) !== 'darwin') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', PASTEBOARD_SCRIPT],
      { timeout: READ_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        // A clipboard holding no files is the common case, not an error worth
        // logging; neither is osascript being absent.
        if (err) {
          resolve([]);
          return;
        }
        resolve(parseClipboardPaths(stdout));
      },
    );
  });
}

/** Exported for tests: the JSON array osascript prints, defensively parsed. */
export function parseClipboardPaths(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((p): p is string => typeof p === 'string' && p.startsWith('/'));
}

/**
 * Keep only clipboard paths whose basename the browser also reported.
 *
 * The check is what makes reading the host's clipboard safe to act on. If the
 * browser saw `notes.md` and the Mac's clipboard holds `/Users/me/notes.md`,
 * they are the same copy; if the browser is on a phone whose clipboard has
 * something else entirely, no name lines up and nothing is inserted. Names are
 * compared exactly — a near-miss is a different file.
 */
export function matchClipboardPathsByName(
  names: ReadonlyArray<string>,
  paths: ReadonlyArray<string>,
): string[] {
  const wanted = new Set(names);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (!wanted.has(basename(p)) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
