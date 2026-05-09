import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CodeBlock } from './CodeBlock';

vi.mock('./MermaidBlock', () => ({
  MermaidBlock: ({ source }: { source: string }) => (
    <div data-testid="mermaid-mock">{source}</div>
  ),
}));

// Stub react-syntax-highlighter so tests don't pull the full Prism bundle
// and so we can assert the highlight path was taken.
vi.mock('react-syntax-highlighter', () => ({
  Prism: ({ children, language }: { children: string; language: string }) => (
    <pre data-test="rsh" data-lang={language}>
      <code>{children}</code>
    </pre>
  ),
}));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
  vscDarkPlus: {},
}));

describe('CodeBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

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

  it('routes a fenced lang through SyntaxHighlighter (Prism)', () => {
    const { container } = render(
      <CodeBlock className="language-ts">{'const x = 1;\n'}</CodeBlock>,
    );
    const pre = container.querySelector('pre[data-test="rsh"]');
    expect(pre).toBeTruthy();
    // alias: ts → typescript
    expect(pre?.getAttribute('data-lang')).toBe('typescript');
    expect(pre?.textContent).toBe('const x = 1;');
  });

  it('routes uncommon langs through SyntaxHighlighter too (Prism falls back gracefully)', () => {
    const { container } = render(
      <CodeBlock className="language-fortran">{'program hi\n'}</CodeBlock>,
    );
    const pre = container.querySelector('pre[data-test="rsh"]');
    expect(pre).toBeTruthy();
    expect(pre?.getAttribute('data-lang')).toBe('fortran');
  });

  it('renders block <pre> wrapper for fenced code WITHOUT a language (multi-line, no className)', () => {
    const { container } = render(<CodeBlock>{'line one\nline two\n'}</CodeBlock>);
    // multi-line + no className → block path, plain wrapper, no Prism
    expect(container.querySelector('pre[data-test="rsh"]')).toBeNull();
    expect(container.querySelector('.md-code-block pre code')?.textContent).toBe(
      'line one\nline two\n',
    );
    expect(container.querySelector('.md-inline-code')).toBeNull();
  });

  it('copy button writes the original source to navigator.clipboard', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      <CodeBlock className="language-ts">{'const x = 1;\n'}</CodeBlock>,
    );
    const copy = container.querySelector('button.md-code-copy') as HTMLButtonElement;
    expect(copy).toBeTruthy();
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith('const x = 1;\n');
  });

  it('hides copy button when navigator.clipboard is undefined', () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const { container } = render(
      <CodeBlock className="language-ts">{'const x = 1;\n'}</CodeBlock>,
    );
    expect(container.querySelector('button.md-code-copy')).toBeNull();
  });
});
