import { describe, it, expect } from 'vitest';
import { imageFilesFromClipboard } from './clipboardImages';

function file(name: string, type: string, size = 10): File {
  const f = new File([new Uint8Array(size)], name, { type });
  return f;
}

/** Minimal stand-in for the parts of DataTransfer this reads. */
function clipboard(opts: {
  items?: Array<{ kind: string; file: File | null }>;
  files?: File[];
}): DataTransfer {
  return {
    items: (opts.items ?? []).map((i) => ({
      kind: i.kind,
      type: i.file?.type ?? '',
      getAsFile: () => i.file,
    })),
    files: opts.files ?? [],
  } as unknown as DataTransfer;
}

describe('imageFilesFromClipboard', () => {
  it('returns nothing for an empty or absent clipboard', () => {
    expect(imageFilesFromClipboard(null)).toEqual([]);
    expect(imageFilesFromClipboard(clipboard({}))).toEqual([]);
  });

  it('picks a screenshot out of items, which is how Chrome and Safari deliver it', () => {
    const png = file('screenshot.png', 'image/png');
    const out = imageFilesFromClipboard(clipboard({ items: [{ kind: 'file', file: png }] }));
    expect(out).toEqual([png]);
  });

  it('falls back to files, which is how Firefox delivers it', () => {
    const png = file('shot.png', 'image/png');
    expect(imageFilesFromClipboard(clipboard({ files: [png] }))).toEqual([png]);
  });

  it('does not report the same image twice when both lists carry it', () => {
    const png = file('shot.png', 'image/png');
    const out = imageFilesFromClipboard(
      clipboard({ items: [{ kind: 'file', file: png }], files: [png] }),
    );
    expect(out).toHaveLength(1);
  });

  it('ignores pasted text', () => {
    // The whole point: a normal text paste must fall through untouched.
    const out = imageFilesFromClipboard(clipboard({ items: [{ kind: 'string', file: null }] }));
    expect(out).toEqual([]);
  });

  it('ignores non-image files', () => {
    const doc = file('notes.txt', 'text/plain');
    expect(imageFilesFromClipboard(clipboard({ files: [doc] }))).toEqual([]);
  });

  it('survives an item that yields no file', () => {
    expect(imageFilesFromClipboard(clipboard({ items: [{ kind: 'file', file: null }] }))).toEqual([]);
  });

  it('returns several images in order', () => {
    const a = file('a.png', 'image/png');
    const b = file('b.jpg', 'image/jpeg');
    const out = imageFilesFromClipboard(clipboard({ files: [a, b] }));
    expect(out.map((f) => f.name)).toEqual(['a.png', 'b.jpg']);
  });
});
