/**
 * Getting a file's absolute path out of a paste or a drop.
 *
 * The browser will not simply hand it over. A `File` from the clipboard carries
 * a name and bytes and nothing else — `File.path` is an Electron extension, not
 * a web API — so "paste the path like Claude Code does" has to be assembled
 * from what the platform actually exposes, and there are two very different
 * cases:
 *
 * 1. **A `file://` URI is on the clipboard.** Dragging out of Finder, and some
 *    copy sources, put `text/uri-list` (or a bare `file://` in `text/plain`)
 *    alongside the file. That URI contains the real absolute path, so this is
 *    the exact case — no guessing.
 * 2. **Only the file itself is there.** A plain ⌘C in Finder usually lands
 *    here: `clipboardData.files` has the file, but every path component has
 *    been stripped. All that survives is the basename, which the caller has to
 *    resolve elsewhere — first by asking the bridge host what its own
 *    pasteboard says (`clipboardBridge.ts`, exact), then by looking the name up
 *    in the session's file index (a guess, so only an unambiguous hit counts).
 *
 * Nothing here reads file contents; both paths are pure string work on metadata
 * the event already carries.
 */

/** Decode a `file://` URI to a filesystem path, or null if it is not one. */
export function pathFromFileUri(uri: string): string | null {
  const trimmed = uri.trim();
  if (!trimmed.toLowerCase().startsWith('file://')) return null;
  try {
    const url = new URL(trimmed);
    // `file:///Users/me/a.txt` → host empty, pathname `/Users/me/a.txt`.
    // A UNC-style `file://host/share` is not a local path; ignore it.
    if (url.hostname && url.hostname !== 'localhost') return null;
    const decoded = decodeURIComponent(url.pathname);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/** Whether a string is already a usable absolute POSIX path. */
function looksAbsolutePath(value: string): boolean {
  const t = value.trim();
  // Single line, starts at root, and no scheme. Multi-line text is prose the
  // user meant to paste, not a path.
  return t.startsWith('/') && !t.includes('\n') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t);
}

/**
 * Absolute paths the clipboard or drag payload states outright.
 *
 * Empty when the platform only gave us the file itself — see
 * `droppedFileNames` for that case.
 */
export function absolutePathsFromDataTransfer(
  data: DataTransfer | null,
  opts: {
    /**
     * Accept a bare `/…` string in `text/plain` as a path.
     *
     * True for drops, where plain text is the payload being dropped. False for
     * pastes, where it would hijack someone pasting a path into the middle of a
     * sentence — the text would jump to the end of the composer instead of
     * landing at the caret. A `file://` URI is unambiguous and always accepted.
     */
    allowBareText?: boolean;
  } = {},
): string[] {
  if (!data) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (p: string | null): void => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };

  // `text/uri-list` is the standard drag payload: one URI per line, `#` comments.
  let uriList = '';
  try {
    uriList = data.getData('text/uri-list');
  } catch {
    // Some browsers throw when reading types outside a real user gesture.
  }
  for (const line of uriList.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    take(pathFromFileUri(line));
  }

  let plain = '';
  try {
    plain = data.getData('text/plain');
  } catch {
    /* as above */
  }
  if (plain) {
    // A copied file sometimes arrives as a bare file:// URI in text/plain, and
    // sometimes the path is already plain text (dragging from a terminal, say).
    for (const line of plain.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const fromUri = pathFromFileUri(line);
      if (fromUri) take(fromUri);
      else if (opts.allowBareText && looksAbsolutePath(line)) take(line.trim());
    }
  }

  return out;
}

/**
 * Basenames of files the payload carries without any path.
 *
 * The caller resolves these against the session's file index — a name alone is
 * not something to paste into a prompt, but it is enough to look up.
 */
export function fileNamesFromDataTransfer(data: DataTransfer | null): string[] {
  if (!data) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (name: string | undefined): void => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    take(item.getAsFile()?.name);
  }
  for (const file of Array.from(data.files ?? [])) {
    take(file.name);
  }
  return out;
}

/**
 * Pick the one hit that unambiguously *is* the named file.
 *
 * Exact basename matches only, and only when there is exactly one — inserting
 * the wrong `config.ts` out of six is worse than inserting nothing, because the
 * agent will act on it without the user noticing the substitution.
 */
export function resolveUniqueByBasename(
  name: string,
  hits: ReadonlyArray<{ fullPath: string }>,
): string | null {
  const matches = hits.filter((h) => basename(h.fullPath) === name);
  return matches.length === 1 ? matches[0]!.fullPath : null;
}

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * A pasted string that could be nothing but a file's name.
 *
 * The last and least helpful thing a platform can do with a copied item is hand
 * over its name as plain text and no file at all — which is what a ⌘C on a
 * *folder* produces in some browsers, since a directory is not a `File`. There
 * is no way to tell that apart from someone pasting a word, so this only
 * decides "could be a name"; the host clipboard has to confirm it before
 * anything is rewritten.
 *
 * Rejects anything with a separator (already a path, or prose) or a line break.
 */
export function bareNameFromText(text: string): string | null {
  const t = text.trim();
  if (t.length === 0 || t.length > 255) return null;
  if (t.includes('/') || t.includes('\n') || t.includes('\r')) return null;
  return t;
}
