import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

function readCss(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('mobile responsive CSS contract', () => {
  it('stacks the root layout and major panels at phone widths', () => {
    const css = [
      readCss('src/App.css'),
      readCss('src/features/session-list/SessionList.css'),
      readCss('src/features/history/history.css'),
      readCss('src/features/chat/Chat.css'),
      readCss('src/features/file-explorer/FileExplorer.css'),
      readCss('src/features/project-picker/ProjectPicker.css'),
    ].join('\n');

    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toMatch(/#root\s*{[^}]*flex-direction:\s*column/s);
    expect(css).toMatch(/\.session-list\s*{[^}]*width:\s*100%/s);
    expect(css).toMatch(/\.history-panel\s*{[^}]*width:\s*100%/s);
    expect(css).toMatch(/\.chat\s*{[^}]*min-height:\s*100dvh/s);
    expect(css).toMatch(/\.file-explorer\s*{[^}]*width:\s*100%/s);
    expect(css).toMatch(/\.picker\s*{[^}]*max-height:\s*calc\(100dvh - 1rem\)/s);
  });

  it('defines the mobile chat shell overlay contract', () => {
    const css = [
      readCss('src/App.css'),
      readCss('src/features/chat/Chat.css'),
      readCss('src/features/file-explorer/FileExplorer.css'),
    ].join('\n');

    expect(css).toMatch(/\.mobile-nav-shell\s*{[^}]*position:\s*fixed/s);
    expect(css).toMatch(/\.mobile-nav-backdrop\s*{[^}]*position:\s*absolute/s);
    expect(css).toMatch(/\.mobile-nav-drawer\s*{[^}]*position:\s*relative/s);
    expect(css).toMatch(/\.chat-mobile-menu\s*{[^}]*display:\s*none/s);
    expect(css).toMatch(/\.chat\s*{[^}]*height:\s*100dvh/s);
    expect(css).toMatch(/\.input-box\s*{[^}]*padding-bottom:\s*calc\(0\.65rem \+ env\(safe-area-inset-bottom\)\)/s);
    expect(css).toMatch(/\.file-explorer\s*{[^}]*position:\s*fixed/s);
  });
});
