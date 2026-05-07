import { useEffect, useRef } from 'react';
import type { SessionView } from '../../store/sessions';
import { MessageBubble } from './MessageBubble';
import { InputBox } from './InputBox';
import './Chat.css';

interface ChatProps {
  session: SessionView;
  onSend(text: string): void;
  onStop(): void;
  banner?: string | null;
  inputDisabled?: boolean;
}

export function Chat({ session, onSend, onStop, banner, inputDisabled }: ChatProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.events]);

  return (
    <div className="chat">
      <div className="chat-header">
        <code>{session.projectPath}</code>
        <span>session {session.sessionId.slice(0, 8)}</span>
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
        onSend={onSend}
        onStop={onStop}
        disabled={(!session.alive) || Boolean(inputDisabled)}
        currentProjectPath={session.projectPath}
      />
    </div>
  );
}
