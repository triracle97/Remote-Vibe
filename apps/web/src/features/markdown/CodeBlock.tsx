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

const WRAP_STORAGE_KEY = 'mrt.code.wrap';

/**
 * Whether code blocks soft-wrap. Persisted because it is a reading preference,
 * not per-block state — someone on a phone wants wrapping everywhere, someone
 * reading diffs on a desktop wants it off everywhere. Ported from the wrap
 * toggle in nimbalyst's transcript `MarkdownRenderer.tsx`.
 */
function readWrapPref(): boolean {
  try {
    return localStorage.getItem(WRAP_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeWrapPref(on: boolean): void {
  try {
    localStorage.setItem(WRAP_STORAGE_KEY, on ? '1' : '0');
  } catch {
    // Private mode — the toggle still works for this block.
  }
}

function CodeFenceWrapper({
  lang,
  source,
  body,
}: {
  lang: string | null;
  source: string;
  body: (wrap: boolean) => ReactNode;
}): JSX.Element {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [wrap, setWrap] = useState(readWrapPref);
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

  const toggleWrap = (): void => {
    setWrap((w) => {
      writeWrapPref(!w);
      return !w;
    });
  };

  return (
    <div className={`md-code-block${wrap ? ' md-code-wrap' : ''}`}>
      {lang && <div className="md-code-lang">{lang}</div>}
      <button
        type="button"
        className="md-code-wrap-toggle"
        onClick={toggleWrap}
        aria-label={wrap ? 'Disable line wrapping' : 'Enable line wrapping'}
        aria-pressed={wrap}
        title={wrap ? 'Line wrapping on' : 'Line wrapping off'}
      >
        ↩
      </button>
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
      {body(wrap)}
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

/**
 * Prism sets `white-space: pre` inline, which beats a stylesheet rule — so the
 * wrap toggle has to override it inline too.
 */
const PRISM_WRAP_STYLE: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflowWrap: 'anywhere',
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
        body={(wrap) => (
          <SyntaxHighlighter
            language={lang}
            style={vscDarkPlus}
            PreTag="pre"
            customStyle={wrap ? { ...PRISM_STYLE, ...PRISM_WRAP_STYLE } : PRISM_STYLE}
            codeTagProps={{
              style: wrap ? { ...PRISM_CODE_STYLE, ...PRISM_WRAP_STYLE } : PRISM_CODE_STYLE,
            }}
            wrapLongLines={wrap}
          >
            {source.replace(/\n$/, '')}
          </SyntaxHighlighter>
        )}
      />
    );
  }

  // Fenced code without a language — plain block.
  return (
    <CodeFenceWrapper
      lang={null}
      source={source}
      body={() => (
        <pre>
          <code>{children}</code>
        </pre>
      )}
    />
  );
}
