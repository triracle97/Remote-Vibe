import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MermaidBlock } from './MermaidBlock';

vi.mock('./mermaid-loader', () => ({
  renderMermaid: vi.fn(),
}));

import { renderMermaid } from './mermaid-loader';

describe('MermaidBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('injects the rendered SVG when render succeeds', async () => {
    (renderMermaid as ReturnType<typeof vi.fn>).mockResolvedValue({
      svg: '<svg data-test="ok"><g/></svg>',
    });
    const { container } = render(<MermaidBlock source="graph TD; A-->B;" />);
    await waitFor(() => {
      expect(container.querySelector('svg[data-test="ok"]')).toBeTruthy();
    });
  });

  it('renders fallback <pre> + error caption when render rejects', async () => {
    (renderMermaid as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('parse failed'));
    const { container, findByText } = render(<MermaidBlock source="bad source" />);
    await findByText(/Mermaid parse error: parse failed/);
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toBe('bad source');
  });
});
