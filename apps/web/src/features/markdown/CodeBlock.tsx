import { useState, type ReactNode } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { MermaidBlock } from './MermaidBlock';

interface CodeBlockProps {
  className?: string;
  children?: ReactNode;
}

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  node: 'javascript',
  shell: 'bash',
  shellscript: 'bash',
  console: 'bash',
  zsh: 'bash',
  sh: 'bash',
  py: 'python',
  python3: 'python',
  rs: 'rust',
  golang: 'go',
  yml: 'yaml',
  md: 'markdown',
  docker: 'docker',
  dockerfile: 'docker',
  htm: 'html',
  patch: 'diff',
  cpp: 'cpp',
  cxx: 'cpp',
  'c++': 'cpp',
  cs: 'csharp',
  kt: 'kotlin',
  rb: 'ruby',
};

function extractLang(className?: string): string | null {
  if (!className) return null;
  const m = /\blanguage-([a-zA-Z0-9_+-]+)\b/.exec(className);
  if (!m) return null;
  const raw = m[1]!.toLowerCase();
  return LANG_ALIASES[raw] ?? raw;
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
}: {
  lang: string | null;
  source: string;
  body: ReactNode;
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
    </div>
  );
}

const PRISM_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '0.5em 0.7em',
  background: 'transparent',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  lineHeight: 1.45,
};

const PRISM_CODE_STYLE: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 'inherit',
  background: 'transparent',
};

export function CodeBlock({ className, children }: CodeBlockProps): JSX.Element {
  const source = nodeToString(children);

  if (isInline(className, source)) {
    return <code className="md-inline-code">{children}</code>;
  }

  const lang = extractLang(className);

  if (lang === 'mermaid') {
    return <MermaidBlock source={source.trim()} />;
  }

  if (lang !== null) {
    return (
      <CodeFenceWrapper
        lang={lang}
        source={source}
        body={
          <SyntaxHighlighter
            language={lang}
            style={vscDarkPlus}
            PreTag="pre"
            customStyle={PRISM_STYLE}
            codeTagProps={{ style: PRISM_CODE_STYLE }}
          >
            {source.replace(/\n$/, '')}
          </SyntaxHighlighter>
        }
      />
    );
  }

  // Fenced code without a language — plain block.
  return (
    <CodeFenceWrapper
      lang={null}
      source={source}
      body={
        <pre>
          <code>{children}</code>
        </pre>
      }
    />
  );
}
