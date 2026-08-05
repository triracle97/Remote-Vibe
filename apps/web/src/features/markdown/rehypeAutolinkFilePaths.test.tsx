import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MarkdownRenderer } from './MarkdownRenderer';

// vitest runs with `globals: false`, so RTL auto-cleanup never registers.
afterEach(cleanup);

// The real MermaidBlock lazily pulls in mermaid; irrelevant to these tests.
vi.mock('./MermaidBlock', () => ({ MermaidBlock: () => <div /> }));

function chips(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-file-path]')];
}

describe('rehypeAutolinkFilePaths', () => {
  it('linkifies a bare path in prose', () => {
    render(<MarkdownRenderer source="see packages/bridge/src/session.ts for details" />);
    const found = chips();
    expect(found).toHaveLength(1);
    expect(found[0]!.dataset.filePath).toBe('packages/bridge/src/session.ts');
  });

  it('captures a trailing line number', () => {
    render(<MarkdownRenderer source="the bug is at src/parser.ts:45 exactly" />);
    const chip = chips()[0]!;
    expect(chip.dataset.filePath).toBe('src/parser.ts');
    expect(chip.dataset.fileLine).toBe('45');
    expect(chip.textContent).toBe('src/parser.ts:45');
  });

  it('linkifies several paths in one sentence', () => {
    render(<MarkdownRenderer source="compare a/b.ts and c/d/e.tsx now" />);
    expect(chips().map((c) => c.dataset.filePath)).toEqual(['a/b.ts', 'c/d/e.tsx']);
  });

  it('preserves the surrounding text', () => {
    const { container } = render(<MarkdownRenderer source="open src/a.ts now" />);
    expect(container.textContent).toBe('open src/a.ts now');
  });

  it('leaves paths inside code spans alone', () => {
    render(<MarkdownRenderer source="run `src/a.ts` please" />);
    expect(chips()).toHaveLength(0);
  });

  it('leaves paths inside fenced code alone', () => {
    render(<MarkdownRenderer source={'```\nsrc/a.ts\n```'} />);
    expect(chips()).toHaveLength(0);
  });

  it('does not linkify an existing markdown link', () => {
    render(<MarkdownRenderer source="[src/a.ts](https://example.com)" />);
    expect(chips()).toHaveLength(0);
  });

  it('does not mistake ordinary prose for a path', () => {
    render(<MarkdownRenderer source="and/or is fine, so is 1.2.3 and a/b without extension" />);
    expect(chips()).toHaveLength(0);
  });

  it('handles a path in parentheses', () => {
    render(<MarkdownRenderer source="fixed it (see src/a.ts) already" />);
    expect(chips()[0]!.dataset.filePath).toBe('src/a.ts');
  });

  it('calls onOpenFile with path and line when clicked', () => {
    const onOpenFile = vi.fn();
    render(<MarkdownRenderer source="see src/a.ts:12 there" onOpenFile={onOpenFile} />);
    fireEvent.click(chips()[0]!);
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts', 12);
  });

  it('passes undefined for the line when there is none', () => {
    const onOpenFile = vi.fn();
    render(<MarkdownRenderer source="see src/a.ts there" onOpenFile={onOpenFile} />);
    fireEvent.click(chips()[0]!);
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts', undefined);
  });

  it('renders inert chips when no handler is supplied', () => {
    render(<MarkdownRenderer source="see src/a.ts there" />);
    // Should not throw on click.
    fireEvent.click(chips()[0]!);
    expect(chips()).toHaveLength(1);
  });
});

describe('MarkdownRenderer safety', () => {
  it('strips a javascript: href', () => {
    render(<MarkdownRenderer source="[click](javascript:alert(1))" />);
    const link = screen.getByText('click').closest('a');
    expect(link?.getAttribute('href')).toBeFalsy();
  });

  it('renders a currency amount literally rather than as math', () => {
    const { container } = render(<MarkdownRenderer source="costs $5 or $10 total" />);
    expect(container.textContent).toContain('$5');
    expect(container.textContent).toContain('$10');
  });
});
