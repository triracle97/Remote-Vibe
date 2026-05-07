import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock mermaid: the unit test does NOT exercise real Mermaid SVG generation
// (Mermaid 11 depends on browser SVG/font/DOMPurify behavior that happy-dom
// does not fully emulate, and would either flake or pull in heavy deps).
// Real-rendering verification belongs in the manual e2e smoke (Task 10).
vi.mock('mermaid', () => {
  const initialize = vi.fn();
  const render = vi.fn();
  return { default: { initialize, render } };
});

import mermaid from 'mermaid';
import { renderMermaid } from './mermaid-loader';

describe('renderMermaid', () => {
  beforeEach(() => {
    (mermaid.initialize as ReturnType<typeof vi.fn>).mockClear();
    (mermaid.render as ReturnType<typeof vi.fn>).mockClear();
  });

  it('initializes mermaid with strict security + dark theme exactly once across calls', async () => {
    (mermaid.render as ReturnType<typeof vi.fn>).mockResolvedValue({ svg: '<svg/>' });
    await renderMermaid('m1', 'graph TD; A-->B;');
    await renderMermaid('m2', 'graph TD; C-->D;');
    expect(mermaid.initialize).toHaveBeenCalledTimes(1);
    expect(mermaid.initialize).toHaveBeenCalledWith({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
    });
  });

  it('resolves to {svg} when mermaid.render succeeds', async () => {
    (mermaid.render as ReturnType<typeof vi.fn>).mockResolvedValue({
      svg: '<svg data-test="ok"/>',
    });
    const result = await renderMermaid('m3', 'graph TD; A-->B;');
    expect(result.svg).toBe('<svg data-test="ok"/>');
    expect(mermaid.render).toHaveBeenCalledWith('m3', 'graph TD; A-->B;');
  });

  it('rejects when mermaid.render rejects', async () => {
    (mermaid.render as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('parse failed'));
    await expect(renderMermaid('m4', 'bad source {{{')).rejects.toThrow('parse failed');
  });
});
