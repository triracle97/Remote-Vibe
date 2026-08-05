import { visit } from 'unist-util-visit';
import type { Root, Element, Text, ElementContent } from 'hast';

/**
 * Turn bare file paths in agent prose into clickable chips.
 *
 * Ported from nimbalyst's
 * `packages/runtime/src/ui/AgentTranscript/markdown/rehypeAutolinkFilePaths.ts`.
 * Agents refer to code by writing `packages/bridge/src/session.ts:869` in
 * ordinary sentences; without this every one of those is dead text.
 *
 * Emits `<button data-file-path data-file-line>` rather than an anchor, because
 * the target is an in-app file preview, not a URL.
 */

/**
 * A path-like run: at least one `dir/` segment then a `name.ext`, optionally
 * followed by `:line`. Requiring the separator and extension is what keeps this
 * from matching ordinary prose like `and/or` or version strings.
 */
const FILE_PATH_RE =
  /(?:^|(?<=[\s(['"`]))((?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z][\w]{0,9})(?::(\d+))?(?=[\s)\]'"`,.;:!?]|$)/g;

/** Never linkify inside these — the text there is already literal or is a link. */
const SKIP_TAGS = new Set(['code', 'pre', 'a', 'button', 'script', 'style']);

export function rehypeAutolinkFilePaths() {
  return (tree: Root): void => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (parent === undefined || index === undefined) return;
      const parentEl = parent as Element;
      if (parentEl.type === 'element' && SKIP_TAGS.has(parentEl.tagName)) return;

      const replacement = splitTextNode(node.value);
      if (replacement === null) return;
      parentEl.children.splice(index, 1, ...replacement);
      // Skip the nodes we just inserted so their text isn't re-scanned.
      return index + replacement.length;
    });
  };
}

function splitTextNode(value: string): ElementContent[] | null {
  FILE_PATH_RE.lastIndex = 0;
  let match = FILE_PATH_RE.exec(value);
  if (match === null) return null;

  const out: ElementContent[] = [];
  let cursor = 0;

  while (match !== null) {
    const path = match[1]!;
    const line = match[2];
    const start = match.index + match[0].length - path.length - (line ? line.length + 1 : 0);

    if (start > cursor) out.push({ type: 'text', value: value.slice(cursor, start) });
    out.push(chip(path, line));
    cursor = start + path.length + (line ? line.length + 1 : 0);
    match = FILE_PATH_RE.exec(value);
  }

  if (cursor < value.length) out.push({ type: 'text', value: value.slice(cursor) });
  return out;
}

function chip(path: string, line: string | undefined): Element {
  return {
    type: 'element',
    tagName: 'button',
    properties: {
      type: 'button',
      className: ['md-file-chip'],
      'data-file-path': path,
      ...(line !== undefined ? { 'data-file-line': line } : {}),
    },
    children: [{ type: 'text', value: line !== undefined ? `${path}:${line}` : path }],
  };
}
