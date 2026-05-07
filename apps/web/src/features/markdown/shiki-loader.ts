import { createHighlighter, type Highlighter } from 'shiki';

export const CURATED_LANGUAGES = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'bash',
  'sh',
  'zsh',
  'python',
  'rust',
  'go',
  'yaml',
  'toml',
  'dockerfile',
  'markdown',
  'html',
  'css',
  'sql',
  'diff',
] as const;

let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (highlighterPromise === null) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark'],
      langs: [...CURATED_LANGUAGES],
    });
  }
  return highlighterPromise;
}
