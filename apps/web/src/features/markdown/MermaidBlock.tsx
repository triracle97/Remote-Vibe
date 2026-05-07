import { useEffect, useId, useRef, useState } from 'react';
import { renderMermaid } from './mermaid-loader';

interface MermaidBlockProps {
  source: string;
}

export function MermaidBlock({ source }: MermaidBlockProps): JSX.Element {
  const idBase = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const safeId = `mermaid-${idBase.replace(/[^a-zA-Z0-9-]/g, '')}`;
    renderMermaid(safeId, source)
      .then(({ svg }) => {
        if (cancelled) return;
        if (ref.current) ref.current.innerHTML = svg;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [idBase, source]);

  if (error !== null) {
    return (
      <div className="md-mermaid-error">
        <div className="md-mermaid-error-caption">Mermaid parse error: {error}</div>
        <pre>{source}</pre>
      </div>
    );
  }
  return <div className="md-mermaid" ref={ref} />;
}
