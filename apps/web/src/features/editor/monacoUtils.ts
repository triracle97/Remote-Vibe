/**
 * Monaco Editor utilities.
 *
 * Ported from nimbalyst (`packages/runtime/src/editors/monacoUtils.ts`). The
 * extension-theme registry lookup is dropped — this app has exactly two
 * themes, driven by the `data-theme` attribute — but the extension→language
 * map is carried over verbatim, because it is the part that took the tuning.
 *
 * Pure and dependency-free on purpose: importing this must never pull Monaco
 * itself into the bundle. See `monaco-loader.ts` for the heavy half.
 */

export type EditorTheme = 'light' | 'dark';

/**
 * Map an app theme to a Monaco built-in theme name.
 *
 * Monaco built-ins: `vs` (light), `vs-dark`, `hc-black`, `hc-light`.
 */
export function getMonacoTheme(theme: EditorTheme): string {
  return theme === 'dark' ? 'vs-dark' : 'vs';
}

/** Read the theme the shell put on `<html data-theme>`. */
export function currentEditorTheme(): EditorTheme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Browser-compatible `path.extname`. */
function getExtname(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastDot > lastSlash && lastDot > 0) {
    return filePath.substring(lastDot);
  }
  return '';
}

/** Browser-compatible `path.basename`. */
function getBasename(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSlash >= 0 ? filePath.substring(lastSlash + 1) : filePath;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  // JavaScript/TypeScript
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',

  // Web
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.svg': 'xml',

  // Data formats
  '.json': 'json',
  '.jsonc': 'json',
  '.json5': 'json',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.conf': 'ini',

  // Python
  '.py': 'python',
  '.pyw': 'python',
  '.pyi': 'python',

  // Shell
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',

  // C/C++
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',

  // Other compiled languages
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.cs': 'csharp',
  '.m': 'objective-c',
  '.mm': 'objective-c',

  // Scripting
  '.rb': 'ruby',
  '.php': 'php',
  '.pl': 'perl',
  '.lua': 'lua',
  '.r': 'r',

  // Functional
  '.hs': 'haskell',
  '.scala': 'scala',
  '.clj': 'clojure',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.fs': 'fsharp',
  '.fsx': 'fsharp',

  // Markup/Config
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'markdown',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.dockerfile': 'dockerfile',
  '.dockerignore': 'plaintext',
  '.gitignore': 'plaintext',
  '.env': 'plaintext',

  // Text
  '.txt': 'plaintext',
  '.log': 'plaintext',
};

/**
 * Files whose whole name carries the language, so an extension lookup finds
 * nothing useful. Keyed lowercase; `.env.local` and friends are handled by the
 * prefix check in `getMonacoLanguage`.
 */
const LANGUAGE_BY_BASENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  brewfile: 'ruby',
  procfile: 'plaintext',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.profile': 'shell',
  '.gitignore': 'plaintext',
  '.gitattributes': 'plaintext',
  '.npmrc': 'ini',
  '.editorconfig': 'ini',
};

/** Map a file path to a Monaco language id. */
export function getMonacoLanguage(filePath: string): string {
  const basename = getBasename(filePath);
  const lowerBase = basename.toLowerCase();

  const byName = LANGUAGE_BY_BASENAME[lowerBase];
  if (byName) return byName;

  // `.env`, `.env.local`, `.env.production` — the extension lookup would read
  // `.local` / `.production` and miss.
  if (lowerBase === '.env' || lowerBase.startsWith('.env.')) return 'plaintext';

  const ext = getExtname(basename).toLowerCase();
  if (!ext) return 'plaintext';

  return LANGUAGE_BY_EXT[ext] ?? 'plaintext';
}
