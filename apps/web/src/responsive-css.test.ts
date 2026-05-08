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
      readCss('src/features/file-explorer/FileExplorer.css'),
      // ProjectPicker.css deleted — picker now uses Modal primitive with Tailwind
      // Chat.css deleted — chat shell now uses Tailwind; base rules moved to App.css
    ].join('\n');

    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toMatch(/#root\s*{[^}]*flex-direction:\s*column/s);
    // .session-list width:100% is now handled by Tailwind (w-full md:w-60)
    // .history-panel width:100% is now handled by Tailwind (max-md:w-full)
    expect(css).toMatch(/\.chat\s*{[^}]*min-height:\s*100dvh/s);
    expect(css).toMatch(/\.file-explorer\s*{[^}]*width:\s*100%/s);
    // .picker max-height is now handled by Modal primitive (overflow-hidden + mobile-safe sizing)
  });

  it('defines the mobile chat shell overlay contract', () => {
    const appCss = readCss('src/App.css');
    const css = [
      appCss,
      // Chat.css deleted — chat shell now uses Tailwind; base rules moved to App.css
      readCss('src/features/file-explorer/FileExplorer.css'),
    ].join('\n');

    expect(css).toMatch(/\.mobile-nav-shell\s*{[^}]*position:\s*fixed/s);
    expect(css).toMatch(/\.mobile-nav-backdrop\s*{[^}]*position:\s*absolute/s);
    expect(css).toMatch(/\.mobile-nav-drawer\s*{[^}]*position:\s*relative/s);
    expect(css).toMatch(/\.chat-mobile-menu\s*{[^}]*display:\s*none/s);
    expect(css).toMatch(/\.chat\s*{[^}]*height:\s*100dvh/s);
    expect(css).toMatch(/\.input-box\s*{[^}]*padding-bottom:\s*calc\(0\.65rem \+ env\(safe-area-inset-bottom\)\)/s);
    expect(css).toMatch(/\.file-explorer\s*{[^}]*position:\s*fixed/s);
    expect(appCss).not.toMatch(/#root\s*>\s*\.session-list\s*,\s*#root\s*>\s*\.history-panel\s*{[^}]*display:\s*none/s);
    expect(css).toMatch(/#root:has\(\s*>\s*\.chat\s*\)\s*>\s*\.session-list\s*,\s*#root:has\(\s*>\s*\.chat\s*\)\s*>\s*\.history-panel\s*{[^}]*display:\s*none/s);
    expect(css).toMatch(/\.mobile-nav-content\s+\.session-list\s*,\s*\.mobile-nav-content\s+\.history-panel\s*{[^}]*display:\s*block/s);
    expect(css).toMatch(/\.mobile-nav-content\s+\.history-list\s*{[^}]*max-height:\s*none/s);
    expect(css).toMatch(/\.fe-tree\s*{[^}]*flex:\s*1[^}]*max-height:\s*none[^}]*min-height:\s*0/s);
    expect(css).toMatch(/\.fe-preview\s*{[^}]*flex:\s*1[^}]*max-height:\s*none[^}]*min-height:\s*0/s);
  });

  it('orders mobile nav shell display rules so the mobile override wins', () => {
    const css = readCss('src/App.css');
    const baseHiddenIndex = css.search(/\.mobile-nav-shell\s*{[^}]*display:\s*none/s);
    const mobileVisibleIndex = css.search(/@media\s*\(max-width:\s*720px\)[\s\S]*?\.mobile-nav-shell\s*{[^}]*display:\s*block/s);

    expect(baseHiddenIndex).toBeGreaterThanOrEqual(0);
    expect(mobileVisibleIndex).toBeGreaterThanOrEqual(0);
    expect(baseHiddenIndex).toBeLessThan(mobileVisibleIndex);
  });

  it('defines polished markdown and mobile file-tag contracts', () => {
    const appCss = readCss('src/App.css');
    const markdownCss = readCss('src/features/markdown/markdown.css');

    expect(markdownCss).toMatch(/\.md-rendered\s*{[^}]*font-family:\s*ui-sans-serif/s);
    expect(markdownCss).toMatch(/\.md-table-wrap\s*{[^}]*overflow-x:\s*auto/s);
    expect(markdownCss).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*?\.md-rendered\s*{[^}]*font-size:\s*0\.95rem/s);
    expect(appCss).toMatch(/@media\s*\(max-width:\s*640px\)[\s\S]*?\.at-tag-autocomplete\s*{[^}]*bottom:\s*calc\(8rem \+ env\(safe-area-inset-bottom\)\)/s);
    expect(appCss).toMatch(/\.autocomplete-row-title\s*{[^}]*text-overflow:\s*ellipsis/s);
    expect(appCss).toMatch(/\.autocomplete-row-path\s*{[^}]*text-overflow:\s*ellipsis/s);
  });
});
