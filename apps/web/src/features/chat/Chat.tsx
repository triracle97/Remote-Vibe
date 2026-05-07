import { useEffect, useRef } from 'react';
import type { SessionView } from '../../store/sessions';
import { MessageBubble } from './MessageBubble';
import { InputBox } from './InputBox';
import './Chat.css';

interface ChatProps {
  session: SessionView;
  onSend(text: string, images?: ReadonlyArray<{ mime: string; base64: string }>): void;
  onStop(): void;
  onToggleDrawer?(): void;
  drawerOpen?: boolean;
  banner?: string | null;
  inputDisabled?: boolean;
}

export function Chat({
  session,
  onSend,
  onStop,
  onToggleDrawer,
  drawerOpen,
  banner,
  inputDisabled,
}: ChatProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.events]);

  return (
    <div className="chat">
      <div className="chat-header">
        <code>{session.projectPath}</code>
        <span className="chat-header-spacer">session {session.sessionId.slice(0, 8)}</span>
        {onToggleDrawer && (
          <button
            type="button"
            className="chat-drawer-toggle"
            onClick={onToggleDrawer}
            aria-label="Toggle file explorer"
          >
            {drawerOpen ? '📂' : '📁'}
          </button>
        )}
      </div>
      {banner && <div className="chat-banner">{banner}</div>}
      <div className="chat-scroll" ref={scrollRef}>
        {session.events.map((e, i) => (
          <MessageBubble
            key={`${i}-${e.type}-${e.type === 'system' ? e.event : (e as { seq: number }).seq}`}
            event={e}
          />
        ))}
      </div>
      <InputBox
        onSend={(text) => onSend(text)}
        onStop={onStop}
        disabled={(!session.alive) || Boolean(inputDisabled)}
        currentProjectPath={session.projectPath}
      />
    </div>
  );
}
