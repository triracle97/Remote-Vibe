import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, Folder } from 'lucide-react';
import type { SessionView } from '../../store/sessions';
import { useSessionsStore } from '../../store/sessions';
import { MessageBubble } from './MessageBubble';
import { InputBox } from './InputBox';
import { ResumePrompt } from './ResumePrompt';
import { SessionRenameInline } from '../session-list/SessionRenameInline';
import { useImagePaste } from '../image-attach/useImagePaste';

interface ChatProps {
  session: SessionView;
  onSend(text: string, images?: ReadonlyArray<{ mime: string; base64: string }>): void;
  onStop(): void;
  onOpenMobileNav?(opener?: HTMLElement): void;
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
  const imagePaste = useImagePaste();
  const imagesEnabled = session.agent === 'claude' && session.alive && !inputDisabled;
  const [dragOver, setDragOver] = useState(false);
  const [renamingHeader, setRenamingHeader] = useState(false);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.events]);

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
    <div
      className="chat flex-1 min-h-0 flex flex-col bg-[var(--color-bg)] text-[var(--color-text)] relative"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="chat-header flex items-center gap-2 px-3 py-2 min-h-[3rem] bg-[var(--color-surface)] border-b border-[var(--color-border)]">
        {onOpenMobileNav && (
          <button
            type="button"
            className="chat-mobile-menu md:hidden inline-flex items-center justify-center min-w-[44px] min-h-[44px] text-[var(--color-text-dim)] hover:text-[var(--color-text)] rounded"
            onClick={(event) => onOpenMobileNav(event.currentTarget)}
            aria-label="Open sessions and history"
          >
            <Menu size={20} aria-hidden="true" />
          </button>
        )}
        <code className="text-xs text-[var(--color-text-dim)] font-mono truncate min-w-0 flex-1">
          {session.projectPath}
        </code>
        {renamingHeader ? (
          <SessionRenameInline
            sessionId={session.sessionId}
            initialName={session.name ?? ''}
            onClose={() => setRenamingHeader(false)}
          />
        ) : (
          <>
            <span className="session-header-name text-[var(--color-text-mute)] text-xs whitespace-nowrap overflow-hidden text-ellipsis max-w-[14rem]">
              {session.name ?? session.sessionId.slice(0, 8)}
            </span>
            <button
              type="button"
              className="session-rename-pencil session-header-pencil min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] rounded"
              onClick={(e) => { e.stopPropagation(); setRenamingHeader(true); }}
              aria-label="Rename session"
            >
              ✏️
            </button>
          </>
        )}
        {onToggleDrawer && (
          <button
            type="button"
            className="chat-drawer-toggle min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] rounded"
            onClick={onToggleDrawer}
            aria-label="Toggle file explorer"
            aria-pressed={drawerOpen ? 'true' : 'false'}
          >
            <Folder size={18} aria-hidden="true" />
          </button>
        )}
      </header>

      {banner && (
        <div className="chat-banner bg-[color-mix(in_srgb,var(--color-warn)_18%,var(--color-surface))] text-[var(--color-warn)] px-3 py-2 text-sm border-b border-[color-mix(in_srgb,var(--color-warn)_30%,var(--color-border))]">
          {banner}
        </div>
      )}
      {errorBanner && (
        <div className="chat-error-banner bg-[color-mix(in_srgb,var(--color-danger)_18%,var(--color-surface))] text-[var(--color-danger)] px-3 py-2 text-sm border-b border-[color-mix(in_srgb,var(--color-danger)_30%,var(--color-border))]">
          {errorBanner}
        </div>
      )}

      <div className="chat-scroll flex-1 min-h-0 overflow-y-auto px-3 py-3 font-mono text-sm leading-relaxed" ref={scrollRef}>
        {session.events.map((e, i) => (
          <MessageBubble
            key={`${i}-${e.type}-${e.type === 'system' ? e.event : (e as { seq: number }).seq}`}
            event={e}
          />
        ))}
        {session.events.some((e) => e.type === 'stream_delta' && !e.superseded) && (
          <ThinkingPill />
        )}
      </div>

      {dragOver && imagesEnabled && (
        <div className="image-attach-drop-overlay absolute inset-0 flex items-center justify-center bg-black/60 text-[var(--color-text)] text-lg pointer-events-none z-30">
          Drop image to attach
        </div>
      )}

      {!session.alive && (
        session.events.length > 0 ? (
          <ResumePrompt
            webSessionId={session.sessionId}
            alive={session.alive}
            onResume={() => void useSessionsStore.getState().resume(session.sessionId)}
          />
        ) : (
          <div className="resume-prompt flex items-center justify-center gap-2 px-3 py-2 my-2 mx-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-mute)] text-sm">
            <span>session ended; transcript unavailable —</span>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="bg-[var(--color-surface-2)] text-[var(--color-accent)] border border-[var(--color-border)] px-3 py-1 rounded hover:bg-[var(--color-surface)]"
            >
              New session
            </button>
          </div>
        )
      )}

      <InputBox
        onSend={onSend}
        onStop={onStop}
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

function ThinkingPill(): JSX.Element {
  return (
    <div className="bubble-thinking" role="status" aria-live="polite">
      <span className="dot" />
      <span className="dot" />
      <span className="dot" />
      <span>Thinking…</span>
    </div>
  );
}
