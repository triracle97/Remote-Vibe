import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SessionView } from '../../store/sessions';
import { useSessionsStore } from '../../store/sessions';
import { MessageBubble } from './MessageBubble';
import { InputBox } from './InputBox';
import { ResumePrompt } from './ResumePrompt';
import { SessionRenameInline } from '../session-list/SessionRenameInline';
import { useImagePaste } from '../image-attach/useImagePaste';
import './Chat.css';

interface ChatProps {
  session: SessionView;
  onSend(text: string, images?: ReadonlyArray<{ mime: string; base64: string }>): void;
  onStop(): void;
  onOpenMobileNav?(): void;
  onToggleDrawer?(): void;
  drawerOpen?: boolean;
  banner?: string | null;
  errorBanner?: string | null;
  inputDisabled?: boolean;
}

export function Chat({
  session,
  onSend,
  onStop,
  onOpenMobileNav,
  onToggleDrawer,
  drawerOpen,
  banner,
  errorBanner,
  inputDisabled,
}: ChatProps): JSX.Element {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  // useImagePaste lives at Chat level so drag-drop on the entire chat area
  // and paste on the textarea inside InputBox feed the same image list.
  // Spec §3 / §5: "drag-drop into the chat area".
  const imagePaste = useImagePaste();
  const imagesEnabled = session.agent === 'claude' && session.alive && !inputDisabled;
  const [dragOver, setDragOver] = useState(false);
  const [renamingHeader, setRenamingHeader] = useState(false);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.events]);

  // Reset images and rename state when switching sessions.
  useEffect(() => {
    imagePaste.clear();
    setDragOver(false);
    setRenamingHeader(false);
  }, [session.sessionId]);

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!imagesEnabled) return;
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    if (e.currentTarget === e.target) setDragOver(false);
  };
  const onDrop = async (e: DragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault();
    setDragOver(false);
    if (!imagesEnabled) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    for (const f of files) await imagePaste.addImageFromFile(f);
  };

  return (
    <div className="chat" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="chat-header">
        {onOpenMobileNav && (
          <button
            type="button"
            className="chat-mobile-menu"
            onClick={onOpenMobileNav}
            aria-label="Open sessions and history"
          >
            ☰
          </button>
        )}
        <code>{session.projectPath}</code>
        {renamingHeader ? (
          <SessionRenameInline
            sessionId={session.sessionId}
            initialName={session.name ?? ''}
            onClose={() => setRenamingHeader(false)}
          />
        ) : (
          <>
            <span className="session-header-name">
              {session.name ?? session.sessionId.slice(0, 8)}
            </span>
            <button
              type="button"
              className="session-rename-pencil session-header-pencil"
              onClick={(e) => { e.stopPropagation(); setRenamingHeader(true); }}
              aria-label="Rename session"
            >
              ✏️
            </button>
          </>
        )}
        <span className="chat-header-spacer" />
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
      {errorBanner && <div className="chat-error-banner">{errorBanner}</div>}
      <div className="chat-scroll" ref={scrollRef}>
        {session.events.map((e, i) => (
          <MessageBubble
            key={`${i}-${e.type}-${e.type === 'system' ? e.event : (e as { seq: number }).seq}`}
            event={e}
          />
        ))}
      </div>
      {dragOver && imagesEnabled && (
        <div className="image-attach-drop-overlay">Drop image to attach</div>
      )}
      {!session.alive && (
        session.events.length > 0 ? (
          <ResumePrompt
            webSessionId={session.sessionId}
            alive={session.alive}
            onResume={() => void useSessionsStore.getState().resume(session.sessionId)}
          />
        ) : (
          <div className="resume-prompt">
            <span>session ended; transcript unavailable — </span>
            <button type="button" onClick={() => navigate('/')}>New session</button>
          </div>
        )
      )}
      <InputBox
        onSend={onSend}
        onStop={onStop}
        // T13: Do NOT disable on dead sessions — InputBox stays interactive so
        // submit can be intercepted and surface the inline "Resume + send" CTA.
        // Only orthogonal disablers (e.g. global error banner via inputDisabled)
        // gate the textarea here.
        disabled={Boolean(inputDisabled)}
        alive={session.alive}
        onResume={async () => useSessionsStore.getState().resume(session.sessionId)}
        currentProjectPath={session.projectPath}
        agent={session.agent}
        imagePaste={imagePaste}
        sessionId={session.sessionId}
      />
    </div>
  );
}
