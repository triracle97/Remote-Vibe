import { useEffect, useState, type ReactNode } from 'react';
import { getHighlighter, CURATED_LANGUAGES } from './shiki-loader';
import { MermaidBlock } from './MermaidBlock';

interface CodeBlockProps {
  className?: string;
  children?: ReactNode;
}

function extractLang(className?: string): string | null {
  if (!className) return null;
  const m = /\blanguage-([a-zA-Z0-9_+-]+)\b/.exec(className);
  return m ? m[1]! : null;
}

function nodeToString(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(nodeToString).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    const props = (children as { props?: { children?: ReactNode } }).props;
    if (props && 'children' in props) return nodeToString(props.children);
  }
  return '';
}

// react-markdown 9 removed the `inline` prop. Detect inline vs block from
// the props that ARE passed through:
//   - has a `language-*` className → fenced block (always)
//   - no className AND source has no internal newline → inline backtick
//   - no className AND source DOES have internal newlines → fenced block w/o language
function isInline(className: string | undefined, source: string): boolean {
  if (className && /\blanguage-/.test(className)) return false;
  return !source.includes('\n');
}

function CodeFenceWrapper({
  lang,
  source,
  body,
  devCaption,
}: {
  lang: string | null;
  source: string;
  body: ReactNode;
  devCaption?: string;
}): JSX.Element {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const canCopy =
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard !== 'undefined' &&
    typeof navigator.clipboard.writeText === 'function';

  const onCopy = (): void => {
    if (!canCopy) return;
    navigator.clipboard
      .writeText(source)
      .then(() => {
        setCopied('ok');
        setTimeout(() => setCopied('idle'), 1500);
      })
      .catch(() => {
        setCopied('fail');
        setTimeout(() => setCopied('idle'), 1500);
      });
  };

  return (
    <div className="md-code-block">
      {lang && <div className="md-code-lang">{lang}</div>}
      {canCopy && (
        <button
          type="button"
          className="md-code-copy"
          onClick={onCopy}
          aria-label="Copy code to clipboard"
        >
          {copied === 'idle' ? '📋' : copied === 'ok' ? '✓' : '✗'}
        </button>
      )}
      {body}
      {devCaption !== undefined && (
        <div className="md-code-dev-caption">{devCaption}</div>
      )}
    </div>
  );
}

export function CodeBlock({ className, children }: CodeBlockProps): JSX.Element {
  const source = nodeToString(children);

  if (isInline(className, source)) {
    return <code className="md-inline-code">{children}</code>;
  }

  const lang = extractLang(className);

  if (lang === 'mermaid') {
    return <MermaidBlock source={source.trim()} />;
  }

  const supported = lang !== null && (CURATED_LANGUAGES as readonly string[]).includes(lang);

  if (supported) {
    return <ShikiBlock lang={lang!} source={source} />;
  }

  // Non-curated language OR fenced code without a language — plain block wrapper.
  // Per spec §6: dev mode shows a small caption naming the unhighlighted lang.
  const devCaption =
    import.meta.env.DEV && lang !== null ? `language \`${lang}\` not highlighted` : undefined;

  return (
    <CodeFenceWrapper
      lang={lang}
      source={source}
      body={
        <pre>
          <code>{children}</code>
        </pre>
      }
      {...(devCaption !== undefined ? { devCaption } : {})}
    />
  );
}

function ShikiBlock({ lang, source }: { lang: string; source: string }): JSX.Element {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHighlighter().then((h) => {
      if (cancelled) return;
      try {
        setHtml(h.codeToHtml(source, { lang, theme: 'github-dark' }));
      } catch {
        setHtml(null); // fall through to fallback below
      }
    });
    return () => {
      cancelled = true;
    };
  }, [lang, source]);

  if (html !== null) {
    return (
      <CodeFenceWrapper
        lang={lang}
        source={source}
        body={<div dangerouslySetInnerHTML={{ __html: html }} />}
      />
    );
  }
  return (
    <CodeFenceWrapper
      lang={lang}
      source={source}
      body={
        <pre>
          <code>{source}</code>
        </pre>
      }
    />
  );
}
