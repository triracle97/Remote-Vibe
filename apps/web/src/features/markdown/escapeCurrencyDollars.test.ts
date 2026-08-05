import { describe, it, expect } from 'vitest';
import { escapeCurrencyDollars, safeUrlTransform } from './escapeCurrencyDollars';

describe('escapeCurrencyDollars', () => {
  it('escapes a dollar amount so remark-math leaves it alone', () => {
    // Unescaped, `$5 or $10` opens an inline-math span and eats the sentence.
    expect(escapeCurrencyDollars('it costs $5 or $10')).toBe('it costs \\$5 or \\$10');
  });

  it('leaves real inline math alone', () => {
    expect(escapeCurrencyDollars('$x^2$ and $\\alpha$')).toBe('$x^2$ and $\\alpha$');
  });

  it('leaves display math alone, digits included', () => {
    expect(escapeCurrencyDollars('$$\n5 + 5\n$$')).toBe('$$\n5 + 5\n$$');
  });

  it('does not touch dollars inside a fenced code block', () => {
    const src = 'text\n```sh\necho $1 costs $5\n```\nafter $3';
    expect(escapeCurrencyDollars(src)).toBe('text\n```sh\necho $1 costs $5\n```\nafter \\$3');
  });

  it('does not touch dollars inside an inline code span', () => {
    expect(escapeCurrencyDollars('use `$1` here, pay $2')).toBe('use `$1` here, pay \\$2');
  });

  it('leaves an already-escaped dollar alone', () => {
    expect(escapeCurrencyDollars('\\$5')).toBe('\\$5');
  });

  it('leaves a dollar not followed by a digit alone', () => {
    expect(escapeCurrencyDollars('$HOME and $ alone')).toBe('$HOME and $ alone');
  });

  it('handles an unterminated fence without dropping content', () => {
    expect(escapeCurrencyDollars('```\n$5 unterminated')).toBe('```\n$5 unterminated');
  });

  it('is a no-op on text with no dollars', () => {
    expect(escapeCurrencyDollars('nothing here')).toBe('nothing here');
  });
});

describe('safeUrlTransform', () => {
  it('allows ordinary link targets', () => {
    for (const u of [
      'https://example.com',
      'http://example.com',
      'mailto:a@b.c',
      '#anchor',
      '/abs/path',
      './rel',
      '../up',
      'src/a.ts',
    ]) {
      expect(safeUrlTransform(u)).toBe(u);
    }
  });

  it('blocks script-bearing schemes', () => {
    // Agent output is untrusted markdown; these are execution vectors.
    expect(safeUrlTransform('javascript:alert(1)')).toBe('');
    expect(safeUrlTransform('  JavaScript:alert(1)')).toBe('');
    expect(safeUrlTransform('data:text/html,<script>')).toBe('');
    expect(safeUrlTransform('vbscript:msgbox')).toBe('');
  });
});
