import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MessageBubble } from './MessageBubble';
import type { SessionEvent } from '../../store/sessions';

vi.mock('../markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ source }: { source: string }) => (
    <div data-test="md-renderer">{source}</div>
  ),
}));

function ev(partial: Partial<SessionEvent> & { type: SessionEvent['type'] }): SessionEvent {
  return partial as SessionEvent;
}

describe('MessageBubble', () => {
  it('renders assistant text via MarkdownRenderer', () => {
    const { container } = render(
      <MessageBubble
        event={ev({
          type: 'assistant',
          sessionId: 's1',
          seq: 5,
          payload: { text: '**bold**' },
        })}
      />,
    );
    const md = container.querySelector('[data-test="md-renderer"]');
    expect(md).toBeTruthy();
    expect(md?.textContent).toBe('**bold**');
    expect(container.querySelector('.bubble.assistant')).toBeTruthy();
  });

  it('renders user text via MarkdownRenderer', () => {
    const { container } = render(
      <MessageBubble
        event={ev({
          type: 'user',
          sessionId: 's1',
          seq: 6,
          payload: { text: 'hello `world`' },
        })}
      />,
    );
    const md = container.querySelector('[data-test="md-renderer"]');
    expect(md?.textContent).toBe('hello `world`');
    expect(container.querySelector('.bubble.user')).toBeTruthy();
  });

  it('returns null for events flagged superseded', () => {
    // Task 8 augments `SessionEvent` with `superseded?: true`, so this is a
    // first-class typed field — no @ts-expect-error needed.
    const { container } = render(
      <MessageBubble
        event={ev({
          type: 'stream_delta',
          sessionId: 's1',
          seq: 4,
          payload: { delta: 'hel' },
          superseded: true,
        })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('returns null for stream_delta (Chat collapses runs into a ThinkingPill)', () => {
    const { container } = render(
      <MessageBubble
        event={ev({
          type: 'stream_delta',
          sessionId: 's1',
          seq: 4,
          payload: { delta: '**not markdown**' },
        })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders tool_use bubble unchanged (no markdown)', () => {
    const { container } = render(
      <MessageBubble
        event={ev({
          type: 'assistant',
          sessionId: 's1',
          seq: 7,
          payload: { toolUse: { kind: 'tool_use', toolUseId: 'tu1', toolName: 'Bash', input: {} } },
        })}
      />,
    );
    expect(container.querySelector('[data-test="md-renderer"]')).toBeNull();
    expect(container.querySelector('.bubble.tool-use')).toBeTruthy();
  });

  it('renders tool_result bubble unchanged (no markdown)', () => {
    const { container } = render(
      <MessageBubble
        event={ev({
          type: 'tool_result',
          sessionId: 's1',
          seq: 8,
          payload: { toolUseId: 'tu1', output: 'ok' },
        })}
      />,
    );
    expect(container.querySelector('[data-test="md-renderer"]')).toBeNull();
    expect(container.querySelector('.bubble.tool-result')).toBeTruthy();
  });

  it('renders result (turn complete) unchanged (no markdown)', () => {
    const { container } = render(
      <MessageBubble
        event={ev({
          type: 'result',
          sessionId: 's1',
          seq: 9,
          payload: { durationMs: 100 },
        })}
      />,
    );
    expect(container.querySelector('[data-test="md-renderer"]')).toBeNull();
    expect(container.querySelector('.bubble.system')?.textContent).toMatch(/turn complete/);
  });

  it('renders system session_created unchanged (no markdown)', () => {
    const { container } = render(
      <MessageBubble
        event={ev({
          type: 'system',
          event: 'session_created',
          sessionId: 's1',
          seq: 1,
        })}
      />,
    );
    expect(container.querySelector('[data-test="md-renderer"]')).toBeNull();
    expect(container.querySelector('.bubble.system')?.textContent).toBe('session started');
  });
});
