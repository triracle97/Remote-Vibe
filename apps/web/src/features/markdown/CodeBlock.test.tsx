import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { CodeBlock } from './CodeBlock';

vi.mock('./MermaidBlock', () => ({
  MermaidBlock: ({ source }: { source: string }) => (
    <div data-testid="mermaid-mock">{source}</div>
  ),
}));

vi.mock('./shiki-loader', () => ({
  getHighlighter: vi.fn(),
  CURATED_LANGUAGES: ['ts', 'js'],
}));

import { getHighlighter } from './shiki-loader';

describe('CodeBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  // react-markdown 9 does NOT pass an `inline` prop. The CodeBlock detects
  // inline vs block from props alone:
  //   - no className AND single-line text  → inline
  //   - has language-* className OR multi-line text → block
  // This matches react-markdown 9's actual `code` component prop shape.

  it('renders inline code (no className, single-line) as <code className="md-inline-code">', () => {
    const { container } = render(<CodeBlock>{'hello'}</CodeBlock>);
    const code = container.querySelector('code.md-inline-code');
    expect(code?.textContent).toBe('hello');
    expect(container.querySelector('.md-code-block')).toBeNull();
  });

  it('delegates language-mermaid to MermaidBlock', () => {
    const { getByTestId, container } = render(
      <CodeBlock className="language-mermaid">{'graph TD; A-->B;\n'}</CodeBlock>,
    );
    expect(getByTestId('mermaid-mock').textContent).toBe('graph TD; A-->B;');
    expect(container.querySelector('.md-inline-code')).toBeNull();
  });

  it('renders Shiki HTML for a curated language once highlighter resolves', async () => {
    (getHighlighter as ReturnType<typeof vi.fn>).mockResolvedValue({
      codeToHtml: (src: string, _opts: unknown) => `<pre data-test="shiki">${src}</pre>`,
    });
    const { container } = render(
      <CodeBlock className="language-ts">{'const x = 1;\n'}</CodeBlock>,
    );
    await waitFor(() => {
      expect(container.querySelector('pre[data-test="shiki"]')).toBeTruthy();
    });
    expect(getHighlighter).toHaveBeenCalled();
  });

  it('falls through to plain <pre> wrapper for non-curated language', () => {
    const { container } = render(
      <CodeBlock className="language-fortran">{'program hi\n'}</CodeBlock>,
    );
    expect(container.querySelector('.md-code-block pre code')?.textContent).toBe('program hi\n');
    expect(getHighlighter).not.toHaveBeenCalled();
  });

  it('renders block <pre> wrapper for fenced code WITHOUT a language (multi-line, no className)', () => {
    const { container } = render(<CodeBlock>{'line one\nline two\n'}</CodeBlock>);
    // multi-line + no className → block path, plain wrapper, no Shiki
    expect(container.querySelector('.md-code-block pre code')?.textContent).toBe(
      'line one\nline two\n',
    );
    expect(container.querySelector('.md-inline-code')).toBeNull();
    expect(getHighlighter).not.toHaveBeenCalled();
  });

  it('shows a dev-only "language X not highlighted" caption for non-curated lang in DEV', () => {
    // import.meta.env.DEV is true by default under Vitest (dev-mode module).
    const { container } = render(
      <CodeBlock className="language-fortran">{'program hi\n'}</CodeBlock>,
    );
    const caption = container.querySelector('.md-code-dev-caption');
    expect(caption?.textContent).toMatch(/language\s+`?fortran`?\s+not highlighted/);
  });

  it('copy button writes the original source to navigator.clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      <CodeBlock className="language-fortran">{'program hi\n'}</CodeBlock>,
    );
    const copy = container.querySelector('button.md-code-copy') as HTMLButtonElement;
    expect(copy).toBeTruthy();
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith('program hi\n');
  });

  it('hides copy button when navigator.clipboard is undefined', () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const { container } = render(
      <CodeBlock className="language-fortran">{'program hi\n'}</CodeBlock>,
    );
    expect(container.querySelector('button.md-code-copy')).toBeNull();
  });
});
