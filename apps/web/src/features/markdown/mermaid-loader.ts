import mermaid from 'mermaid';

/**
 * Mermaid is lazily imported by its only caller (`MermaidBlock`), which keeps
 * it and its diagram chunks out of the main bundle. Everything here assumes
 * that and stays side-effect free at module scope.
 */

export type MermaidTheme = 'light' | 'dark';

/**
 * Mermaid's `initialize` is global and cannot be scoped per render, so the
 * theme it was last configured with is tracked here. Re-initializing on every
 * render would discard its parser cache; re-initializing on theme change is
 * required, because diagram colours are baked in at render time.
 */
let lastInitTheme: MermaidTheme | null = null;

function init(theme: MermaidTheme): void {
  if (lastInitTheme === theme) return;
  lastInitTheme = theme;
  mermaid.initialize({
    startOnLoad: false,
    // `default` is mermaid's light theme; there is no `light`.
    theme: theme === 'dark' ? 'dark' : 'default',
    securityLevel: 'strict',
  });
}

export interface MermaidRender {
  svg: string;
  /** Attaches click handlers declared by `click` directives, if any. */
  bindFunctions?: ((element: Element) => void) | undefined;
}

/**
 * Render one diagram.
 *
 * `id` must be unique *per render*, not per component: mermaid caches by
 * element id internally, so reusing a stable id makes edited diagrams render
 * their previous SVG. Callers pass a counter (see `MermaidBlock`'s renderKey).
 */
export async function renderMermaid(
  id: string,
  source: string,
  theme: MermaidTheme = 'dark',
): Promise<MermaidRender> {
  init(theme);
  const { svg, bindFunctions } = await mermaid.render(id, source);
  return { svg, bindFunctions };
}

/** Test seam: forget the initialized theme so the next render re-initializes. */
export function resetMermaidForTests(): void {
  lastInitTheme = null;
}
