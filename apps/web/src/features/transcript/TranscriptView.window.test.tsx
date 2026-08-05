import { afterEach, describe, it, expect } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { TranscriptView, type TranscriptViewHandle } from './TranscriptView';
import type { SessionEvent } from '../../store/sessions';

// vitest runs with globals: false, so RTL's auto-cleanup never registers.
afterEach(cleanup);

/** `n` alternating user/assistant turns, oldest first. */
function history(n: number): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      type: i % 2 === 0 ? 'user' : 'assistant',
      sessionId: 's',
      seq: i + 1,
      payload: { text: `message ${i}` },
    } as SessionEvent);
  }
  return out;
}

function renderedTexts(): string[] {
  return Array.from(document.querySelectorAll('[data-message-id]')).map(
    (el) => el.textContent ?? '',
  );
}

describe('TranscriptView windowing', () => {
  it('renders only the tail of a long history', () => {
    render(<TranscriptView events={history(100)} sessionKey="s1" initialWindow={20} />);

    const shown = renderedTexts();
    expect(shown).toHaveLength(20);
    // The tail, not the head — opening a session should land you at the latest
    // exchange, which is what you were looking at when you left.
    expect(shown.some((t) => t.includes('message 99'))).toBe(true);
    expect(shown.some((t) => t.includes('message 0'))).toBe(false);
  });

  it('renders everything when the history is shorter than the window', () => {
    render(<TranscriptView events={history(5)} sessionKey="s1" initialWindow={20} />);
    expect(renderedTexts()).toHaveLength(5);
    // No affordance to click when nothing is hidden.
    expect(screen.queryByTestId('transcript-show-earlier')).toBeNull();
  });

  it('reveals more in steps, and reports how many are left', () => {
    render(<TranscriptView events={history(100)} sessionKey="s1" initialWindow={20} />);
    expect(screen.getByTestId('transcript-show-earlier').textContent).toContain('50');

    fireEvent.click(screen.getByTestId('transcript-show-earlier'));
    expect(renderedTexts()).toHaveLength(70);

    // 30 left, so the button offers 30 rather than a full step.
    expect(screen.getByTestId('transcript-show-earlier').textContent).toContain('30');
  });

  it('shows the whole history on demand', () => {
    render(<TranscriptView events={history(100)} sessionKey="s1" initialWindow={20} />);
    fireEvent.click(screen.getByTestId('transcript-show-all'));

    expect(renderedTexts()).toHaveLength(100);
    expect(screen.queryByTestId('transcript-show-earlier')).toBeNull();
  });

  it('keeps messages that arrive after opening, rather than sliding the window', () => {
    // The window collapses once. Watching something appear and then vanish as
    // the next message pushed it out would be worse than not collapsing at all.
    const { rerender } = render(
      <TranscriptView events={history(30)} sessionKey="s1" initialWindow={20} />,
    );
    expect(renderedTexts()).toHaveLength(20);

    rerender(<TranscriptView events={history(35)} sessionKey="s1" initialWindow={20} />);
    expect(renderedTexts()).toHaveLength(25);
  });

  it('waits for history to arrive before collapsing', () => {
    // A session opens empty and its backlog lands a moment later; collapsing
    // against the empty list would leave the whole backlog rendered.
    const { rerender } = render(
      <TranscriptView events={[]} sessionKey="s1" initialWindow={20} />,
    );
    expect(renderedTexts()).toHaveLength(0);

    rerender(<TranscriptView events={history(100)} sessionKey="s1" initialWindow={20} />);
    expect(renderedTexts()).toHaveLength(20);
  });

  it('re-collapses when switching sessions', () => {
    const { rerender } = render(
      <TranscriptView events={history(100)} sessionKey="s1" initialWindow={20} />,
    );
    fireEvent.click(screen.getByTestId('transcript-show-all'));
    expect(renderedTexts()).toHaveLength(100);

    // A different session should not inherit how far the previous one was
    // expanded.
    rerender(<TranscriptView events={history(100)} sessionKey="s2" initialWindow={20} />);
    expect(renderedTexts()).toHaveLength(20);
  });

  it('reveals everything through the imperative handle', () => {
    // This is what search and the outline use to reach a collapsed message.
    const ref = createRef<TranscriptViewHandle>();
    render(
      <TranscriptView ref={ref} events={history(100)} sessionKey="s1" initialWindow={20} />,
    );
    expect(renderedTexts()).toHaveLength(20);

    // Called from outside React (a jump handler), so it needs an act boundary
    // before the DOM reflects it.
    act(() => ref.current!.revealAll());
    expect(renderedTexts()).toHaveLength(100);
  });
});
