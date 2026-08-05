import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Chat } from './Chat';
import type { SessionView } from '../../store/sessions';

vi.mock('./InputBox', () => ({
  InputBox: () => <div data-testid="input-box" />,
}));

vi.mock('./ResumePrompt', () => ({
  ResumePrompt: () => <div data-testid="resume-prompt" />,
}));

vi.mock('../image-attach/useImagePaste', () => ({
  useImagePaste: () => ({
    images: [],
    error: null,
    addImageFromFile: vi.fn(),
    removeImage: vi.fn(),
    clear: vi.fn(),
  }),
}));

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: 's1',
    agent: 'claude',
    projectPath: '/Users/me/project',
    createdAt: 1,
    events: [],
    lastSeq: 0,
    alive: true,
    name: 'Mobile Session',
    ...overrides,
  };
}

/**
 * The header is now two different trees rather than one row with `md:` classes,
 * so a test has to say which viewport it is in. happy-dom reports a 1024px
 * window by default, i.e. desktop.
 */
function stubViewport(desktop: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width: 768px') ? desktop : !desktop,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

// vitest runs with globals: false, so RTL's auto-cleanup never registers.
afterEach(cleanup);

describe('Chat', () => {
  it('renders a mobile navigation trigger when provided', () => {
    const restore = stubViewport(false);
    try {
    const onOpenMobileNav = vi.fn();
    const { getByLabelText } = render(
      <MemoryRouter>
        <Chat
          session={makeSession()}
          onSend={() => {}}
          onStop={() => {}}
          onOpenMobileNav={onOpenMobileNav}
        />
      </MemoryRouter>,
    );

    const trigger = getByLabelText(/open sessions and history/i);
    fireEvent.click(trigger);
    expect(onOpenMobileNav).toHaveBeenCalledTimes(1);
    expect(onOpenMobileNav).toHaveBeenCalledWith(trigger);
    } finally {
      restore();
    }
  });

  it('keeps the phone header to four controls at most', () => {
    const restore = stubViewport(false);
    try {
      const { container } = render(
        <MemoryRouter>
          <Chat
            session={makeSession()}
            onSend={() => {}}
            onStop={() => {}}
            onOpenMobileNav={() => {}}
            onToggleDrawer={() => {}}
          />
        </MemoryRouter>,
      );
      // The bug being prevented: eleven controls in one non-wrapping row ran
      // straight off the side of a phone and the right-hand ones became
      // unreachable. Hamburger, title, overflow — plus a status badge when
      // there is background work.
      const header = container.querySelector('.chat-header')!;
      expect(header.querySelectorAll('button').length).toBeLessThanOrEqual(3);
      expect(header.querySelector('[data-testid="session-overflow-trigger"]')).toBeTruthy();
    } finally {
      restore();
    }
  });

  it('puts the secondary actions behind the overflow sheet on a phone', async () => {
    const restore = stubViewport(false);
    try {
      const { getByLabelText, queryByLabelText, findByLabelText } = render(
        <MemoryRouter>
          <Chat
            session={makeSession()}
            onSend={() => {}}
            onStop={() => {}}
            onOpenMobileNav={() => {}}
            onToggleDrawer={() => {}}
          />
        </MemoryRouter>,
      );
      expect(queryByLabelText('Find in transcript')).toBeNull();

      fireEvent.click(getByLabelText('More session actions'));

      expect(await findByLabelText('Find in transcript')).toBeTruthy();
      expect(getByLabelText('Toggle transcript outline')).toBeTruthy();
      expect(getByLabelText('Toggle file explorer')).toBeTruthy();
      expect(getByLabelText('Rename session')).toBeTruthy();
    } finally {
      restore();
    }
  });

  it('keeps every control inline on a desktop', () => {
    const restore = stubViewport(true);
    try {
      const { getByLabelText, queryByLabelText } = render(
        <MemoryRouter>
          <Chat
            session={makeSession()}
            onSend={() => {}}
            onStop={() => {}}
            onToggleDrawer={() => {}}
          />
        </MemoryRouter>,
      );
      // There is room here, and one click beats two.
      expect(getByLabelText('Find in transcript')).toBeTruthy();
      expect(getByLabelText('Toggle transcript outline')).toBeTruthy();
      expect(getByLabelText('Toggle file explorer')).toBeTruthy();
      expect(queryByLabelText('More session actions')).toBeNull();
    } finally {
      restore();
    }
  });
});
