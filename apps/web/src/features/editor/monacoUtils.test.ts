import { describe, it, expect } from 'vitest';
import { getMonacoLanguage, getMonacoTheme } from './monacoUtils';

describe('getMonacoLanguage', () => {
  it('maps common source extensions', () => {
    expect(getMonacoLanguage('/p/src/index.ts')).toBe('typescript');
    expect(getMonacoLanguage('/p/src/App.tsx')).toBe('typescript');
    expect(getMonacoLanguage('/p/src/main.js')).toBe('javascript');
    expect(getMonacoLanguage('/p/lib.rs')).toBe('rust');
    expect(getMonacoLanguage('/p/main.go')).toBe('go');
    expect(getMonacoLanguage('/p/script.py')).toBe('python');
  });

  it('is case-insensitive on the extension', () => {
    expect(getMonacoLanguage('/p/README.MD')).toBe('markdown');
    expect(getMonacoLanguage('/p/Style.CSS')).toBe('css');
  });

  it('recognises extensionless files by basename', () => {
    expect(getMonacoLanguage('/p/Dockerfile')).toBe('dockerfile');
    expect(getMonacoLanguage('/p/Makefile')).toBe('makefile');
    expect(getMonacoLanguage('/p/Gemfile')).toBe('ruby');
    expect(getMonacoLanguage('/p/.zshrc')).toBe('shell');
  });

  it('treats dotenv files as plaintext, including suffixed variants', () => {
    expect(getMonacoLanguage('/p/.env')).toBe('plaintext');
    expect(getMonacoLanguage('/p/.env.local')).toBe('plaintext');
    expect(getMonacoLanguage('/p/.env.production')).toBe('plaintext');
  });

  it('falls back to plaintext for unknown and extensionless files', () => {
    expect(getMonacoLanguage('/p/notes.wat')).toBe('plaintext');
    expect(getMonacoLanguage('/p/LICENSE')).toBe('plaintext');
  });

  it('does not read a directory name as the extension', () => {
    // The dot is in the directory, not the file.
    expect(getMonacoLanguage('/p/some.dir/README')).toBe('plaintext');
  });

  it('handles a bare filename with no directory', () => {
    expect(getMonacoLanguage('index.ts')).toBe('typescript');
    expect(getMonacoLanguage('Dockerfile')).toBe('dockerfile');
  });
});

describe('getMonacoTheme', () => {
  it('maps the app themes onto Monaco built-ins', () => {
    expect(getMonacoTheme('dark')).toBe('vs-dark');
    expect(getMonacoTheme('light')).toBe('vs');
  });
});
