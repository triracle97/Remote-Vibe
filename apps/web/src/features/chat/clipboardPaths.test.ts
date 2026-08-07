import { describe, it, expect } from 'vitest';
import {
  absolutePathsFromDataTransfer,
  bareNameFromText,
  fileNamesFromDataTransfer,
  pathFromFileUri,
  resolveUniqueByBasename,
} from './clipboardPaths';

/** Minimal stand-in for the parts of DataTransfer these read. */
function dt(opts: {
  uriList?: string;
  plain?: string;
  files?: Array<{ name: string }>;
}): DataTransfer {
  const data: Record<string, string> = {};
  if (opts.uriList !== undefined) data['text/uri-list'] = opts.uriList;
  if (opts.plain !== undefined) data['text/plain'] = opts.plain;
  const files = opts.files ?? [];
  return {
    getData: (type: string) => data[type] ?? '',
    items: files.map((f) => ({ kind: 'file', type: '', getAsFile: () => f })),
    files,
  } as unknown as DataTransfer;
}

describe('pathFromFileUri', () => {
  it('decodes a local file URI', () => {
    expect(pathFromFileUri('file:///Users/me/notes.md')).toBe('/Users/me/notes.md');
  });

  it('percent-decodes spaces and unicode', () => {
    expect(pathFromFileUri('file:///Users/me/my%20file.txt')).toBe('/Users/me/my file.txt');
    expect(pathFromFileUri('file:///Users/me/%E6%97%A5%E6%9C%AC.md')).toBe('/Users/me/日本.md');
  });

  it('accepts the localhost form', () => {
    expect(pathFromFileUri('file://localhost/Users/me/a.txt')).toBe('/Users/me/a.txt');
  });

  it('rejects anything that is not a local file URI', () => {
    expect(pathFromFileUri('https://example.com/a.txt')).toBeNull();
    // A remote share is not a path we can hand to a local agent.
    expect(pathFromFileUri('file://someserver/share/a.txt')).toBeNull();
    expect(pathFromFileUri('/Users/me/a.txt')).toBeNull();
  });
});

describe('absolutePathsFromDataTransfer', () => {
  it('reads the standard drag payload', () => {
    expect(
      absolutePathsFromDataTransfer(dt({ uriList: 'file:///Users/me/a.txt' })),
    ).toEqual(['/Users/me/a.txt']);
  });

  it('reads several URIs and skips comment lines', () => {
    const list = '# comment\nfile:///Users/me/a.txt\nfile:///Users/me/b.txt\n';
    expect(absolutePathsFromDataTransfer(dt({ uriList: list }))).toEqual([
      '/Users/me/a.txt',
      '/Users/me/b.txt',
    ]);
  });

  it('accepts a file URI that arrives only as plain text', () => {
    expect(absolutePathsFromDataTransfer(dt({ plain: 'file:///Users/me/a.txt' }))).toEqual([
      '/Users/me/a.txt',
    ]);
  });

  it('accepts a bare absolute path only when the caller opts in', () => {
    // Drops opt in; pastes do not, or pasting a path mid-sentence would jump to
    // the end of the composer instead of landing at the caret.
    expect(absolutePathsFromDataTransfer(dt({ plain: '/Users/me/a.txt' }))).toEqual([]);
    expect(
      absolutePathsFromDataTransfer(dt({ plain: '/Users/me/a.txt' }), { allowBareText: true }),
    ).toEqual(['/Users/me/a.txt']);
  });

  it('does not mistake ordinary pasted prose for a path', () => {
    expect(absolutePathsFromDataTransfer(dt({ plain: 'please fix the bug' }))).toEqual([]);
    // Multi-line text is something the user meant to paste as text.
    expect(
      absolutePathsFromDataTransfer(dt({ plain: '/Users/me/a.txt\nand more prose' }), {
        allowBareText: true,
      }),
    ).toEqual(['/Users/me/a.txt']);
    expect(absolutePathsFromDataTransfer(dt({ plain: 'https://example.com/x' }))).toEqual([]);
  });

  it('de-duplicates across uri-list and plain text', () => {
    expect(
      absolutePathsFromDataTransfer(
        dt({ uriList: 'file:///Users/me/a.txt', plain: 'file:///Users/me/a.txt' }),
      ),
    ).toEqual(['/Users/me/a.txt']);
  });

  it('returns nothing for an empty payload', () => {
    expect(absolutePathsFromDataTransfer(null)).toEqual([]);
    expect(absolutePathsFromDataTransfer(dt({}))).toEqual([]);
  });
});

describe('fileNamesFromDataTransfer', () => {
  it('reports basenames when the payload carries only the file', () => {
    // The ⌘C-in-Finder case: the browser strips every path component.
    expect(fileNamesFromDataTransfer(dt({ files: [{ name: 'notes.md' }] }))).toEqual([
      'notes.md',
    ]);
  });

  it('de-duplicates across items and files', () => {
    const f = { name: 'a.txt' };
    const payload = {
      getData: () => '',
      items: [{ kind: 'file', type: '', getAsFile: () => f }],
      files: [f],
    } as unknown as DataTransfer;
    expect(fileNamesFromDataTransfer(payload)).toEqual(['a.txt']);
  });

  it('ignores non-file items', () => {
    const payload = {
      getData: () => '',
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
      files: [],
    } as unknown as DataTransfer;
    expect(fileNamesFromDataTransfer(payload)).toEqual([]);
  });
});

describe('resolveUniqueByBasename', () => {
  it('resolves an unambiguous filename to its absolute path', () => {
    const hits = [{ fullPath: '/repo/src/app.ts' }, { fullPath: '/repo/src/util.ts' }];
    expect(resolveUniqueByBasename('app.ts', hits)).toBe('/repo/src/app.ts');
  });

  it('refuses to guess when several files share the name', () => {
    // Inserting the wrong config.ts is worse than inserting nothing: the agent
    // acts on it and the user never sees the substitution.
    const hits = [{ fullPath: '/repo/a/config.ts' }, { fullPath: '/repo/b/config.ts' }];
    expect(resolveUniqueByBasename('config.ts', hits)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(resolveUniqueByBasename('missing.ts', [{ fullPath: '/repo/app.ts' }])).toBeNull();
  });

  it('matches on the basename, not a path substring', () => {
    const hits = [{ fullPath: '/repo/app.ts.bak' }];
    expect(resolveUniqueByBasename('app.ts', hits)).toBeNull();
  });
});

describe('bareNameFromText', () => {
  it('accepts a plain name, which is all a copied folder may leave behind', () => {
    expect(bareNameFromText('project')).toBe('project');
    expect(bareNameFromText('  My Notes.md \n')).toBe('My Notes.md');
  });

  it('rejects anything that already carries a separator or spans lines', () => {
    expect(bareNameFromText('/Users/me/notes.md')).toBeNull();
    expect(bareNameFromText('src/app.ts')).toBeNull();
    expect(bareNameFromText('two\nlines')).toBeNull();
    expect(bareNameFromText('   ')).toBeNull();
    expect(bareNameFromText('x'.repeat(256))).toBeNull();
  });
});
