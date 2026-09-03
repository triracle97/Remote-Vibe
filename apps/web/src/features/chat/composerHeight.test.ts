import { beforeEach, describe, it, expect } from 'vitest';
import {
  COMPOSER_MIN_HEIGHT,
  clampComposerHeight,
  composerMaxHeight,
  readStoredComposerHeight,
  writeStoredComposerHeight,
} from './composerHeight';

beforeEach(() => {
  localStorage.clear();
});

describe('composerMaxHeight', () => {
  it('is a share of the viewport', () => {
    expect(composerMaxHeight(1000)).toBe(600);
  });

  it('never drops below the minimum, however short the viewport', () => {
    expect(composerMaxHeight(50)).toBe(COMPOSER_MIN_HEIGHT);
  });
});

describe('clampComposerHeight', () => {
  it('keeps a sane height untouched', () => {
    expect(clampComposerHeight(200, 1000)).toBe(200);
  });

  it('floors at the minimum', () => {
    expect(clampComposerHeight(10, 1000)).toBe(COMPOSER_MIN_HEIGHT);
  });

  it('ceils at the viewport share', () => {
    expect(clampComposerHeight(5000, 1000)).toBe(600);
  });

  it('falls back to the minimum for a non-finite measurement', () => {
    expect(clampComposerHeight(Number.NaN, 1000)).toBe(COMPOSER_MIN_HEIGHT);
  });
});

describe('stored height', () => {
  it('round-trips', () => {
    writeStoredComposerHeight(240);
    expect(readStoredComposerHeight()).toBe(240);
  });

  it('reads null when nothing is stored', () => {
    expect(readStoredComposerHeight()).toBeNull();
  });

  it('ignores garbage', () => {
    localStorage.setItem('mrt.composerHeight', 'tall');
    expect(readStoredComposerHeight()).toBeNull();
  });

  it('clears on null', () => {
    writeStoredComposerHeight(240);
    writeStoredComposerHeight(null);
    expect(readStoredComposerHeight()).toBeNull();
  });
});
