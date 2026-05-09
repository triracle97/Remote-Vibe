import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TerminalHelperBar } from '../TerminalHelperBar';

afterEach(() => cleanup());

describe('TerminalHelperBar', () => {
  it('Esc sends \\x1b', () => {
    const onSend = vi.fn();
    render(<TerminalHelperBar onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: /esc/i }));
    expect(onSend).toHaveBeenCalledWith('\x1b');
  });

  it('Tab sends \\t', () => {
    const onSend = vi.fn();
    render(<TerminalHelperBar onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: /^tab$/i }));
    expect(onSend).toHaveBeenCalledWith('\t');
  });

  it('arrows send CSI sequences', () => {
    const onSend = vi.fn();
    render(<TerminalHelperBar onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: /up/i }));
    fireEvent.click(screen.getByRole('button', { name: /down/i }));
    fireEvent.click(screen.getByRole('button', { name: /left/i }));
    fireEvent.click(screen.getByRole('button', { name: /right/i }));
    expect(onSend.mock.calls.map((c) => c[0])).toEqual(['\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C']);
  });

  it('Ctrl-C button sends \\x03', () => {
    const onSend = vi.fn();
    render(<TerminalHelperBar onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: /ctrl-c/i }));
    expect(onSend).toHaveBeenCalledWith('\x03');
  });

  it('Ctrl modifier toggles + composes with the next alpha key', () => {
    const onSend = vi.fn();
    render(<TerminalHelperBar onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: /^ctrl$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^a$/i }));
    expect(onSend).toHaveBeenLastCalledWith('\x01');
    // Modifier resets after one use.
    fireEvent.click(screen.getByRole('button', { name: /^a$/i }));
    expect(onSend).toHaveBeenLastCalledWith('a');
  });

  it('tapping Ctrl twice clears the modifier without sending', () => {
    const onSend = vi.fn();
    render(<TerminalHelperBar onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: /^ctrl$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^ctrl$/i }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('every button is at least 44x44 CSS pixels (mobile-friendly)', () => {
    const { container } = render(<TerminalHelperBar onSend={() => {}} />);
    const buttons = container.querySelectorAll('button');
    for (const b of buttons) {
      const style = window.getComputedStyle(b);
      // happy-dom returns the computed style we set inline / via className.
      // We assert min-height/min-width via the class names.
      expect(b.className).toMatch(/min-h-\[44px\]/);
      expect(b.className).toMatch(/min-w-\[44px\]/);
    }
  });
});
