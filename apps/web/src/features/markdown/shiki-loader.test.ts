import { describe, it, expect } from 'vitest';
import { getHighlighter, CURATED_LANGUAGES } from './shiki-loader';

describe('shiki-loader', () => {
  it('returns the same promise on repeated calls', () => {
    const a = getHighlighter();
    const b = getHighlighter();
    expect(a).toBe(b);
  });

  it('CURATED_LANGUAGES contains the expected set', () => {
    expect(CURATED_LANGUAGES).toContain('ts');
    expect(CURATED_LANGUAGES).toContain('python');
    expect(CURATED_LANGUAGES).toContain('json');
    expect(CURATED_LANGUAGES).toContain('diff');
    expect(CURATED_LANGUAGES.length).toBeGreaterThanOrEqual(15);
  });

  it('highlights ts code with the github-dark theme (HTML contains color spans)', async () => {
    const h = await getHighlighter();
    const html = h.codeToHtml('const x: number = 1;', { lang: 'ts', theme: 'github-dark' });
    expect(html).toContain('<pre');
    expect(html).toMatch(/<span style="color:#[0-9a-fA-F]{3,8}/);
  });

  it('hostile fence content does not produce executable HTML elements', async () => {
    const h = await getHighlighter();
    const hostile = '</span><img src=x onerror=alert(1)>';
    const html = h.codeToHtml(hostile, { lang: 'ts', theme: 'github-dark' });
    const dom = new DOMParser().parseFromString(`<!doctype html><div>${html}</div>`, 'text/html');
    // Primary security assertions: no executable / image elements materialize.
    expect(dom.querySelectorAll('img').length).toBe(0);
    expect(dom.querySelectorAll('script').length).toBe(0);
    expect(dom.querySelectorAll('iframe').length).toBe(0);
    // The source `<` survives as an HTML-entity escape. Shiki may emit either
    // the named (`&lt;`) or hex-numeric (`&#x3C;`) form; both are valid HTML5
    // escapes and prevent tag interpretation. The test is encoding-agnostic
    // so it survives Shiki minor-version output changes. (`>` is not escaped
    // by Shiki because `>` alone cannot open a tag in HTML5 — only `<` does.)
    expect(html).toMatch(/&lt;|&#x3C;|&#60;/i);
    // Defense-in-depth: hostile substring must NOT appear as raw markup.
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
  });
});
