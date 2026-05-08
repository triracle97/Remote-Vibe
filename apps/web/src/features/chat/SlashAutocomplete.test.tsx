import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRef } from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import {
  SlashAutocomplete,
  findSlashTrigger,
  type SlashAutocompleteHandle,
} from './SlashAutocomplete';
import { useSlashCommandStore } from './slashCommandStore';
import type { SlashCommand } from '../../types/protocol';

vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: vi.fn(() => ({ send: vi.fn() })),
}));

const cmd = (over: Partial<SlashCommand> = {}): SlashCommand => ({
  name: '/help',
  description: '',
  source: 'builtin',
  agent: 'both',
  ...over,
});

function seed(sessionId: string, commands: SlashCommand[]): void {
  useSlashCommandStore.setState({
    bySession: { [sessionId]: { commands, lastFetched: Date.now() } },
  });
}

describe('findSlashTrigger', () => {
  it('detects "/" at start of string', () => {
    expect(findSlashTrigger('/he', 3)).toEqual({ start: 0, query: 'he' });
  });

  it('detects "/" right after a newline', () => {
    expect(findSlashTrigger('hi\n/run', 7)).toEqual({ start: 3, query: 'run' });
  });

  it('returns null when "/" is mid-line (not at line-start)', () => {
    expect(findSlashTrigger('hello /run', 10)).toBeNull();
  });

  it('returns null with no slash in line', () => {
    expect(findSlashTrigger('hello', 5)).toBeNull();
  });

  it('handles empty query (just "/")', () => {
    expect(findSlashTrigger('/', 1)).toEqual({ start: 0, query: '' });
  });
});

describe('SlashAutocomplete', () => {
  beforeEach(() => {
    useSlashCommandStore.setState({ bySession: {} });
  });

  it('does NOT render when text has no leading-slash trigger', () => {
    seed('s1', [cmd({ name: '/help' })]);
    const { container } = render(
      <SlashAutocomplete
        sessionId="s1"
        agent="claude"
        text="hello world"
        cursor={11}
        onPick={vi.fn()}
      />,
    );
    expect(container.querySelector('.autocomplete-popup')).toBeNull();
  });

  it('renders matching commands when "/" at line-start', () => {
    seed('s1', [
      cmd({ name: '/help', description: 'Show help' }),
      cmd({ name: '/run' }),
      cmd({ name: '/clear', agent: 'claude' }),
    ]);
    const { container } = render(
      <SlashAutocomplete
        sessionId="s1"
        agent="claude"
        text="/h"
        cursor={2}
        onPick={vi.fn()}
      />,
    );
    const rows = container.querySelectorAll('.autocomplete-row');
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain('/help');
  });

  it('filters out commands not matching the active agent', () => {
    seed('s1', [
      cmd({ name: '/claude-only', agent: 'claude' }),
      cmd({ name: '/codex-only', agent: 'codex' }),
      cmd({ name: '/shared', agent: 'both' }),
    ]);
    const { container } = render(
      <SlashAutocomplete
        sessionId="s1"
        agent="codex"
        text="/"
        cursor={1}
        onPick={vi.fn()}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('/codex-only');
    expect(text).toContain('/shared');
    expect(text).not.toContain('/claude-only');
  });

  it('imperative handle: ArrowDown + Enter inserts the active command', () => {
    seed('s1', [cmd({ name: '/help' }), cmd({ name: '/halt' })]);
    const onPick = vi.fn();
    const ref = createRef<SlashAutocompleteHandle>();
    render(
      <SlashAutocomplete
        ref={ref}
        sessionId="s1"
        agent="claude"
        text="/h"
        cursor={2}
        onPick={onPick}
      />,
    );
    expect(ref.current?.isOpen()).toBe(true);
    // Move to second entry, then Enter.
    act(() => {
      ref.current?.handleKey({ key: 'ArrowDown' });
    });
    act(() => {
      ref.current?.handleKey({ key: 'Enter' });
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('/halt ', 6);
  });

  it('clicking a row inserts that command (replaces the trigger)', () => {
    seed('s1', [cmd({ name: '/help' })]);
    const onPick = vi.fn();
    const text = 'hello\n/h';
    const { container } = render(
      <SlashAutocomplete
        sessionId="s1"
        agent="claude"
        text={text}
        cursor={text.length}
        onPick={onPick}
      />,
    );
    const row = container.querySelector('.autocomplete-row') as HTMLButtonElement | null;
    expect(row).not.toBeNull();
    fireEvent.mouseDown(row!);
    expect(onPick).toHaveBeenCalledWith('hello\n/help ', 12);
  });

  it('isOpen() is false when there are no matches', () => {
    seed('s1', [cmd({ name: '/help' })]);
    const ref = createRef<SlashAutocompleteHandle>();
    render(
      <SlashAutocomplete
        ref={ref}
        sessionId="s1"
        agent="claude"
        text="/zzzzz"
        cursor={6}
        onPick={vi.fn()}
      />,
    );
    expect(ref.current?.isOpen()).toBe(false);
    expect(ref.current?.handleKey({ key: 'Enter' })).toBe(false);
  });
});
