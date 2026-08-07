import { describe, it, expect } from 'vitest';
import {
  matchClipboardPathsByName,
  parseClipboardPaths,
  readClipboardFilePaths,
} from '../clipboard.js';

describe('parseClipboardPaths', () => {
  it('reads the JSON array osascript prints', () => {
    expect(parseClipboardPaths('["/Users/me/a.txt","/Users/me/dir"]\n')).toEqual([
      '/Users/me/a.txt',
      '/Users/me/dir',
    ]);
  });

  it('treats anything that is not a list of absolute paths as an empty clipboard', () => {
    expect(parseClipboardPaths('')).toEqual([]);
    expect(parseClipboardPaths('execution error: ...')).toEqual([]);
    expect(parseClipboardPaths('{"not":"a list"}')).toEqual([]);
    expect(parseClipboardPaths('["relative/path", 7, null, "/ok"]')).toEqual(['/ok']);
  });
});

describe('matchClipboardPathsByName', () => {
  it('accepts a path the browser also named', () => {
    expect(matchClipboardPathsByName(['a.txt'], ['/Users/me/a.txt'])).toEqual([
      '/Users/me/a.txt',
    ]);
  });

  it('resolves a directory, which no file index lookup would', () => {
    expect(matchClipboardPathsByName(['project'], ['/Users/me/code/project'])).toEqual([
      '/Users/me/code/project',
    ]);
  });

  it('says nothing when the host clipboard holds something else', () => {
    // The browser is on a phone; this Mac's clipboard is unrelated. Answering
    // anyway would paste a path the user never copied.
    expect(matchClipboardPathsByName(['notes.md'], ['/Users/me/screenshot.png'])).toEqual([]);
  });

  it('does not match on a partial name', () => {
    expect(matchClipboardPathsByName(['a.txt'], ['/Users/me/aa.txt'])).toEqual([]);
    expect(matchClipboardPathsByName(['Users'], ['/Users/me/a.txt'])).toEqual([]);
  });

  it('keeps every named file of a multi-file copy, once each', () => {
    expect(
      matchClipboardPathsByName(
        ['a.txt', 'b.txt'],
        ['/x/a.txt', '/x/b.txt', '/x/a.txt', '/x/c.txt'],
      ),
    ).toEqual(['/x/a.txt', '/x/b.txt']);
  });
});

describe('readClipboardFilePaths', () => {
  it('is empty off macOS, where there is no pasteboard to read', async () => {
    expect(await readClipboardFilePaths({ platform: 'linux' })).toEqual([]);
  });
});
