import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Chat } from './Chat';
import type { SessionView } from '../../store/sessions';

vi.mock('./InputBox', () => ({
  InputBox: () => <div data-testid="input-box" />,
}));

vi.mock('./MessageBubble', () => ({
  MessageBubble: () => <div data-testid="message-bubble" />,
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

describe('Chat', () => {
  it('renders a mobile navigation trigger when provided', () => {
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

    fireEvent.click(getByLabelText(/open sessions and history/i));
    expect(onOpenMobileNav).toHaveBeenCalledTimes(1);
  });
});
