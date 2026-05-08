import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRef } from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import {
  AtTagAutocomplete,
  findAtTrigger,
  type AtTagAutocompleteHandle,
} from './AtTagAutocomplete';
import { useFileSearchStore } from './fileSearchStore';
import type { SearchHit } from '../../types/protocol';

vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: vi.fn(() => ({ send: vi.fn() })),
}));

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  insertText: '@src/foo.ts',
  fullPath: '/repo/src/foo.ts',
  dirIndex: 0,
  mtime: Date.now() - 5000,
  ...over,
});

function seed(sessionId: string, hits: SearchHit[], opts: { truncated?: boolean; query?: string } = {}): void {
  useFileSearchStore.setState({
    bySession: {
      [sessionId]: {
        hits,
        truncated: opts.truncated ?? false,
        query: opts.query ?? '',
      },
    },
  });
}

describe('findAtTrigger', () => {
  it('detects "@" at start of string', () => {
    expect(findAtTrigger('@foo', 4)).toEqual({ start: 0, query: 'foo' });
  });

  it('detects "@" preceded by whitespace', () => {
    expect(findAtTrigger('hi @foo', 7)).toEqual({ start: 3, query: 'foo' });
  });

  it('detects "@" after a newline', () => {
    expect(findAtTrigger('hi\n@bar', 7)).toEqual({ start: 3, query: 'bar' });
  });

  it('returns null when "@" is glued to a non-whitespace char (e.g. emails)', () => {
    expect(findAtTrigger('user@example.com', 16)).toBeNull();
  });

  it('handles empty query (just "@")', () => {
    expect(findAtTrigger(' @', 2)).toEqual({ start: 1, query: '' });
  });
});

describe('AtTagAutocomplete', () => {
  beforeEach(() => {
    useFileSearchStore.setState({ bySession: {} });
  });

  it('does NOT render when no @ trigger active', () => {
    seed('s1', [hit()]);
    const { container } = render(
      <AtTagAutocomplete sessionId="s1" text="hello" cursor={5} onPick={vi.fn()} />,
    );
    expect(container.querySelector('.autocomplete-popup')).toBeNull();
  });

  it('renders hits when "@" trigger active', () => {
    seed('s1', [
      hit({ insertText: '@src/foo.ts', fullPath: '/repo/src/foo.ts' }),
      hit({ insertText: '@src/bar.ts', fullPath: '/repo/src/bar.ts' }),
    ]);
    const { container } = render(
      <AtTagAutocomplete sessionId="s1" text="@s" cursor={2} onPick={vi.fn()} />,
    );
    const rows = container.querySelectorAll('.autocomplete-row');
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain('@src/foo.ts');
  });

  it('renders file suggestions with readable filename and full path spans', () => {
    seed('s1', [
      hit({
        insertText: '@src/deeply/nested/VeryLongComponent.tsx',
        fullPath: '/repo/src/deeply/nested/VeryLongComponent.tsx',
      }),
    ]);
    const { container } = render(
      <AtTagAutocomplete sessionId="s1" text="@V" cursor={2} onPick={vi.fn()} />,
    );
    expect(container.querySelector('.autocomplete-row-title')?.textContent).toBe(
      'VeryLongComponent.tsx',
    );
    expect(container.querySelector('.autocomplete-row-path')?.textContent).toBe(
      '/repo/src/deeply/nested/VeryLongComponent.tsx',
    );
  });

  it('clicking a row inserts the hit insertText with trailing space, replacing the trigger', () => {
    seed('s1', [hit({ insertText: '@src/foo.ts', fullPath: '/repo/src/foo.ts' })]);
    const onPick = vi.fn();
    const { container } = render(
      <AtTagAutocomplete sessionId="s1" text="see @s" cursor={6} onPick={onPick} />,
    );
    const row = container.querySelector('.autocomplete-row') as HTMLButtonElement;
    fireEvent.mouseDown(row);
    expect(onPick).toHaveBeenCalledWith('see @src/foo.ts ', 16);
  });

  it('truncated indicator renders when result is truncated', () => {
    seed('s1', [hit()], { truncated: true });
    const { container } = render(
      <AtTagAutocomplete sessionId="s1" text="@" cursor={1} onPick={vi.fn()} />,
    );
    expect(container.querySelector('.autocomplete-truncated')).not.toBeNull();
  });

  it('imperative handle: ArrowDown + Enter inserts active hit', () => {
    seed('s1', [
      hit({ insertText: '@a', fullPath: '/a' }),
      hit({ insertText: '@b', fullPath: '/b' }),
    ]);
    const onPick = vi.fn();
    const ref = createRef<AtTagAutocompleteHandle>();
    render(
      <AtTagAutocomplete ref={ref} sessionId="s1" text="@" cursor={1} onPick={onPick} />,
    );
    expect(ref.current?.isOpen()).toBe(true);
    act(() => {
      ref.current?.handleKey({ key: 'ArrowDown' });
    });
    act(() => {
      ref.current?.handleKey({ key: 'Enter' });
    });
    expect(onPick).toHaveBeenCalledWith('@b ', 3);
  });
});
