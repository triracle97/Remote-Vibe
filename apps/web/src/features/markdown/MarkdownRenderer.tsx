import { memo, useCallback, useMemo, type JSX, type MouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { CodeBlock } from './CodeBlock';
import { escapeCurrencyDollars, safeUrlTransform } from './escapeCurrencyDollars';
import { rehypeAutolinkFilePaths } from './rehypeAutolinkFilePaths';

interface MarkdownRendererProps {
  source: string;
  /**
   * Makes bare file paths in prose clickable. Without it they still render as
   * chips but do nothing on click, so the handler is what turns the feature on.
   */
  onOpenFile?: (filePath: string, line?: number) => void;
}

function MarkdownRendererImpl({ source, onOpenFile }: MarkdownRendererProps): JSX.Element {
  // Currency escaping runs before parsing: `$5` would otherwise open an inline
  // math span and swallow the rest of the sentence.
  const prepared = useMemo(() => escapeCurrencyDollars(source), [source]);

  // One delegated listener beats a handler per chip — a long transcript can
  // contain hundreds of them.
  const onClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!onOpenFile) return;
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-file-path]');
      if (!target) return;
      e.preventDefault();
      const path = target.dataset.filePath;
      if (path === undefined) return;
      const rawLine = target.dataset.fileLine;
      const line = rawLine !== undefined ? Number(rawLine) : undefined;
      onOpenFile(path, Number.isFinite(line) ? line : undefined);
    },
    [onOpenFile],
  );

  return (
    <div className="markdown" onClick={onClick}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          // Spec §6: throwOnError: false renders malformed math as red literal
          // text instead of crashing the bubble. errorColor matches the spec.
          [rehypeKatex, { throwOnError: false, errorColor: '#cc0000' }],
          rehypeAutolinkFilePaths,
        ]}
        // Agent output is untrusted markdown; block javascript:/data: hrefs.
        urlTransform={safeUrlTransform}
        components={{
          code: CodeBlock as never,
          table: ({ children }) => (
            <div className="md-table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {prepared}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownRenderer = memo(
  MarkdownRendererImpl,
  (prev, next) => prev.source === next.source && prev.onOpenFile === next.onOpenFile,
);
