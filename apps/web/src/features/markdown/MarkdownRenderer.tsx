import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { CodeBlock } from './CodeBlock';

interface MarkdownRendererProps {
  source: string;
}

function MarkdownRendererImpl({ source }: MarkdownRendererProps): JSX.Element {
  return (
    <div className="md-rendered">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          // Spec §6: throwOnError: false renders malformed math as red literal
          // text instead of crashing the bubble. errorColor matches the spec.
          [rehypeKatex, { throwOnError: false, errorColor: '#cc0000' }],
        ]}
        components={{
          code: CodeBlock as never,
          table: ({ children }) => (
            <div className="md-table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownRenderer = memo(
  MarkdownRendererImpl,
  (prev, next) => prev.source === next.source,
);
