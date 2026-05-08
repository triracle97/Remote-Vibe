import { describe, it, expect, beforeEach } from 'vitest';
import { useThemeStore, resolveTheme } from './themeStore';

describe('themeStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useThemeStore.setState({ mode: 'system' });
  });

  it('defaults to system', () => {
    expect(useThemeStore.getState().mode).toBe('system');
  });

  it('setMode updates state and persists', () => {
    useThemeStore.getState().setMode('dark');
    expect(useThemeStore.getState().mode).toBe('dark');
    expect(localStorage.getItem('mrt.theme')).toBe('dark');
  });

  it('resolveTheme returns explicit modes unchanged', () => {
    expect(resolveTheme('dark', () => true)).toBe('dark');
    expect(resolveTheme('light', () => true)).toBe('light');
  });

  it('resolveTheme follows system pref when mode=system', () => {
    expect(resolveTheme('system', () => true)).toBe('light');
    expect(resolveTheme('system', () => false)).toBe('dark');
  });

  it('survives localStorage failure on write', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota');
    };
    try {
      useThemeStore.getState().setMode('light');
      expect(useThemeStore.getState().mode).toBe('light');
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
