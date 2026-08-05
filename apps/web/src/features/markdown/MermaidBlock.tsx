import { useCallback, useEffect, useId, useRef, useState, type JSX } from 'react';
import { Maximize2, RefreshCw } from 'lucide-react';
import { renderMermaid } from './mermaid-loader';
import { useResolvedTheme } from '../../shell/useResolvedTheme';
import { FullscreenModal } from './FullscreenModal';

interface MermaidBlockProps {
  source: string;
}

/** Diagrams stream in token by token; re-rendering each keystroke thrashes. */
const RENDER_DEBOUNCE_MS = 500;

/**
 * Mermaid diagram.
 *
 * Ported from nimbalyst's
 * `packages/runtime/src/editor/plugins/MermaidPlugin/MermaidComponent.tsx`,
 * which solves three problems the naive version has:
 *
 *  - **Debounce.** Agent output arrives incrementally, so a diagram is
 *    syntactically invalid for most of its life. Rendering every change floods
 *    the console with parse errors and burns CPU.
 *  - **Cache defeat.** Mermaid caches by element id. A stable id (`useId`
 *    alone) means an edited diagram re-renders its *previous* SVG, so the id
 *    carries a per-render counter.
 *  - **Theme re-init.** Colours are baked into the SVG at render time, so a
 *    theme switch has to re-render rather than restyle.
 */
export function MermaidBlock({ source }: MermaidBlockProps): JSX.Element {
  const idBase = useId().replace(/[^a-zA-Z0-9-]/g, '');
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renderCountRef = useRef(0);
  const theme = useResolvedTheme();

  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /** Bumped by the retry button to force a re-render of unchanged source. */
  const [renderKey, setRenderKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (timerRef.current !== null) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      renderCountRef.current += 1;
      const elementId = `mermaid-${idBase}-${renderCountRef.current}`;
      renderMermaid(elementId, source, theme)
        .then(({ svg: rendered, bindFunctions }) => {
          if (cancelled) return;
          setError(null);
          setSvg(rendered);
          // Applied after React commits the SVG, so the nodes exist.
          queueMicrotask(() => {
            if (!cancelled && containerRef.current && bindFunctions) {
              bindFunctions(containerRef.current);
            }
          });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
        });
    }, RENDER_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [idBase, source, theme, renderKey]);

  const retry = useCallback(() => setRenderKey((k) => k + 1), []);

  if (error !== null) {
    return (
      <div className="md-mermaid-error">
        <div className="md-mermaid-error-caption flex items-center gap-2">
          <span className="flex-1">Mermaid parse error: {error}</span>
          <button
            type="button"
            onClick={retry}
            aria-label="Re-render diagram"
            className="shrink-0 p-1 rounded hover:bg-[var(--color-surface-2)]"
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        </div>
        <pre>{source}</pre>
      </div>
    );
  }

  // Nothing rendered yet — the debounce has not fired, or this is the first
  // pass of a diagram still streaming in.
  if (svg === null) {
    return (
      <div className="md-mermaid md-mermaid-pending text-xs text-[var(--color-text-dim)] italic px-2 py-3">
        rendering diagram…
      </div>
    );
  }

  return (
    <>
      <div className="md-mermaid group relative">
        <button
          type="button"
          onClick={() => setFullscreen(true)}
          aria-label="View diagram fullscreen"
          className="absolute top-1 right-1 z-10 p-1 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
        >
          <Maximize2 size={13} aria-hidden />
        </button>
        <div ref={containerRef} dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
      {fullscreen && (
        <FullscreenModal onClose={() => setFullscreen(false)} ariaLabel="Diagram">
          <ZoomableSvg svg={svg} />
        </FullscreenModal>
      )}
    </>
  );
}

/**
 * Scroll/button zoom for a rendered diagram. Matters on a phone, where a
 * complex diagram is unreadable at fit-to-width.
 */
function ZoomableSvg({ svg }: { svg: string }): JSX.Element {
  const [scale, setScale] = useState(1);
  return (
    <div className="w-full h-full overflow-auto flex items-start justify-center p-4">
      <div
        className="origin-top"
        style={{ transform: `scale(${scale})` }}
        onWheel={(e) => {
          // Plain scroll should still pan a large diagram.
          if (!e.ctrlKey && !e.metaKey) return;
          setScale((s) => Math.min(5, Math.max(0.25, s - e.deltaY * 0.002)));
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
        <ZoomButton label="Zoom out" onClick={() => setScale((s) => Math.max(0.25, s - 0.25))}>
          −
        </ZoomButton>
        <span className="text-xs tabular-nums text-[var(--color-text-dim)] w-12 text-center">
          {Math.round(scale * 100)}%
        </span>
        <ZoomButton label="Zoom in" onClick={() => setScale((s) => Math.min(5, s + 0.25))}>
          +
        </ZoomButton>
        <ZoomButton label="Reset zoom" onClick={() => setScale(1)}>
          reset
        </ZoomButton>
      </div>
    </div>
  );
}

function ZoomButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="px-2 py-0.5 text-xs rounded text-[var(--color-text-mute)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
    >
      {children}
    </button>
  );
}
