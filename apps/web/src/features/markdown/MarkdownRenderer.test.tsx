import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MarkdownRenderer } from './MarkdownRenderer';

vi.mock('./CodeBlock', () => ({
  CodeBlock: (props: { className?: string; children?: React.ReactNode }) => (
    <div
      data-test="code-block"
      data-classname={props.className ?? ''}
    >
      {props.children}
    </div>
  ),
}));

describe('MarkdownRenderer', () => {
  it('renders bold + italic + heading + list + link', () => {
    const { container } = render(
      <MarkdownRenderer
        source={`# Title\n\n**bold** and *italic* and [a](https://example.com)\n\n- one\n- two`}
      />,
    );
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(container.querySelectorAll('ul li').length).toBe(2);
  });

  it('renders inline code via CodeBlock with no className', () => {
    const { container } = render(<MarkdownRenderer source={'use `foo` here'} />);
    const cb = container.querySelector('[data-test="code-block"]');
    // react-markdown 9: inline backticks pass through `code` with no className.
    expect(cb?.getAttribute('data-classname')).toBe('');
    expect(cb?.textContent).toBe('foo');
  });

  it('renders fenced code via CodeBlock with language className', () => {
    const { container } = render(
      <MarkdownRenderer source={'```ts\nconst x = 1;\n```'} />,
    );
    const cb = container.querySelector('[data-test="code-block"]');
    expect(cb?.getAttribute('data-classname')).toContain('language-ts');
  });

  it('renders block math as a .katex element', () => {
    const { container } = render(<MarkdownRenderer source={'$$x^2$$'} />);
    expect(container.querySelector('.katex')).toBeTruthy();
  });

  it('does NOT throw on malformed math (KaTeX throwOnError: false)', () => {
    // Spec §6: malformed math must render as a styled error, not crash.
    expect(() =>
      render(<MarkdownRenderer source={'$$\\frac$$'} />),
    ).not.toThrow();
  });

  it('renders GFM tables', () => {
    const { container } = render(
      <MarkdownRenderer source={'| a | b |\n|---|---|\n| 1 | 2 |'} />,
    );
    expect(container.querySelector('table thead th')?.textContent).toBe('a');
  });

  it('escapes raw <script> in source — no script element materializes', () => {
    const { container } = render(
      <MarkdownRenderer source={`Try <script>alert(1)</script> here`} />,
    );
    expect(container.querySelectorAll('script').length).toBe(0);
    expect(container.innerHTML).toContain('&lt;script&gt;');
  });
});
