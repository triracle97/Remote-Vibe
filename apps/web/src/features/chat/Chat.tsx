import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, Folder, Search, PanelRight } from 'lucide-react';
import type { SessionView } from '../../store/sessions';
import { useSessionsStore } from '../../store/sessions';
import { InputBox } from './InputBox';
import { ResumePrompt } from './ResumePrompt';
import { SessionHeader } from './SessionHeader';
import { useImagePaste } from '../image-attach/useImagePaste';
import {
  TranscriptView,
  DEFAULT_TRANSCRIPT_SETTINGS,
  type TranscriptViewHandle,
} from '../transcript/TranscriptView';
import { TranscriptSearchBar } from '../transcript/TranscriptSearchBar';
import { TranscriptSidebar } from '../transcript/TranscriptSidebar';
import { projectEvents } from '../transcript/projection';
import { runningWork } from '../transcript/runningWork';
import { isTurnRunning } from '../transcript/turnState';
import { imageFilesFromClipboard } from '../image-attach/clipboardImages';
import {
  absolutePathsFromDataTransfer,
  fileNamesFromDataTransfer,
} from './clipboardPaths';
import { RunningWorkBadge } from '../transcript/RunningWorkBadge';
import { SessionUsageBadge } from '../usage/SessionUsageBadge';
import { SpawnedSessionsBadge } from '../board/SpawnedSessionsBadge';
import { SessionModelSwitch } from '../model-picker/SessionModelSwitch';
import { useFileExplorerStore } from '../../store/file-explorer';
import { getBridgeClient } from '../../services/bridge-client-singleton';
import { BottomSheet } from '../../shell/BottomSheet';
import { useIsDesktop } from '../../shell/useIsDesktop';

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
  const pinnedToBottomRef = useRef(true);
  const imagePaste = useImagePaste();
  // Codex gained image input via `codex exec -i`, so this is no longer
  // agent-specific — only whether the session can take input at all.
  const imagesEnabled = session.alive && !inputDisabled;
  const [dragOver, setDragOver] = useState(false);
  const [renamingHeader, setRenamingHeader] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isDesktop = useIsDesktop();

  // Projected once here and shared with the search bar and sidebar, so the
  // three views agree on message identity (they key off the same ids).
  const messages = useMemo(() => projectEvents(session.events), [session.events]);

  // Derived from the same projection the transcript renders, so the badge and
  // the visible tool calls can never disagree about what is still open.
  const background = useMemo(() => runningWork(messages), [messages]);

  // Whether there is a turn to interrupt. Drives both the composer button and
  // the Esc / ⌃C bindings — they must agree, or the key does nothing while the
  // button says otherwise.
  const turnRunning = useMemo(() => isTurnRunning(session.events), [session.events]);

  const interrupt = useCallback(() => {
    if (!turnRunning || !session.alive) return;
    useSessionsStore.getState().interruptSession(session.sessionId);
  }, [turnRunning, session.alive, session.sessionId]);

  /**
   * Esc and ⌃C stop the turn, matching the CLI.
   *
   * Bound here rather than in the global shortcut table because both keys are
   * heavily overloaded and the guards are specific: Esc must yield to any open
   * dialog or autocomplete, and ⌃C must yield to an actual text selection or it
   * breaks copy. Neither guard makes sense outside a session.
   */
  useEffect(() => {
    if (!turnRunning) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        // A popover, sheet, or autocomplete owns Escape while it is open.
        if (document.querySelector('[role="dialog"], [role="listbox"]')) return;
      } else if (e.key === 'c' && e.ctrlKey && !e.metaKey && !e.altKey) {
        // Ctrl+C is copy when there is something selected. Only claim it when
        // there is not.
        if ((window.getSelection()?.toString() ?? '').length > 0) return;
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      interrupt();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [turnRunning, interrupt]);

  /**
   * Open a file referenced from the transcript — a diff header, or a bare path
   * the markdown autolinker turned into a chip. Relative paths resolve against
   * the session's primary cwd, which is how the agent writes them.
   */
  const openFile = useCallback(
    (filePath: string) => {
      const abs = filePath.startsWith('/')
        ? filePath
        : `${session.projectPath.replace(/\/$/, '')}/${filePath.replace(/^\.\//, '')}`;
      useFileExplorerStore.getState().requestFile(getBridgeClient(), abs);
      if (onToggleDrawer && !drawerOpen) onToggleDrawer();
    },
    [session.projectPath, onToggleDrawer, drawerOpen],
  );

  const transcriptRef = useRef<TranscriptViewHandle>(null);

  const jumpTo = useCallback((messageId: string) => {
    // Jumping means the user has left the tail; stop yanking them back down.
    pinnedToBottomRef.current = false;
    const find = (): Element | null | undefined =>
      scrollRef.current?.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);

    const el = find();
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    // Search and the outline index the whole transcript, so a target can sit
    // above the collapsed window. Render the rest, then jump once it exists.
    transcriptRef.current?.revealAll();
    requestAnimationFrame(() => {
      find()?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, []);

  const onChatScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  useEffect(() => {
    if (!pinnedToBottomRef.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.events]);

  useEffect(() => {
    imagePaste.clear();
    setDragOver(false);
    setRenamingHeader(false);
    pinnedToBottomRef.current = true;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.sessionId]);

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!imagesEnabled) return;
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    if (e.currentTarget === e.target) setDragOver(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragOver(false);
    const dt = e.dataTransfer;
    const images = imagesEnabled ? imageFilesFromClipboard(dt) : [];
    if (images.length > 0) {
      void (async () => {
        for (const f of images) await imagePaste.addImageFromFile(f);
      })();
      return;
    }
    // Not an image — treat it as "paste this file's path". The strings have to
    // come out here: a DataTransfer is only readable inside its own handler.
    const paths = absolutePathsFromDataTransfer(dt, { allowBareText: true });
    const names = fileNamesFromDataTransfer(dt);
    if (paths.length === 0 && names.length === 0) return;
    window.dispatchEvent(new CustomEvent('mrt:dropped-files', { detail: { paths, names } }));
  };

  return (
    <div
      className="chat flex-1 min-h-0 flex flex-col bg-[var(--color-bg)] text-[var(--color-text)] relative"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <SessionHeader
        session={session}
        background={background}
        searchOpen={searchOpen}
        onToggleSearch={() => setSearchOpen((o) => !o)}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        drawerOpen={drawerOpen}
        onToggleDrawer={onToggleDrawer}
        onOpenMobileNav={onOpenMobileNav}
      />

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

      {searchOpen && (
        <TranscriptSearchBar
          messages={messages}
          onClose={() => {
            setSearchOpen(false);
            setSearchQuery('');
          }}
          onJump={jumpTo}
          onQueryChange={setSearchQuery}
        />
      )}

      <div className="flex-1 min-h-0 flex">
        <div
          className="chat-scroll flex-1 min-h-0 overflow-y-auto px-3 py-3 text-sm leading-relaxed"
          ref={scrollRef}
          onScroll={onChatScroll}
        >
          <TranscriptView
            ref={transcriptRef}
            sessionKey={session.sessionId}
            events={session.events}
            projectPath={session.projectPath}
            settings={DEFAULT_TRANSCRIPT_SETTINGS}
            searchQuery={searchQuery}
            onOpenFile={openFile}
            footer={
              session.events.some((e) => e.type === 'stream_delta' && !e.superseded) ? (
                <ThinkingPill />
              ) : null
            }
          />
        </div>
        {sidebarOpen && isDesktop && (
          <div className="flex">
            <TranscriptSidebar messages={messages} onJump={jumpTo} />
          </div>
        )}
      </div>

      {/*
        Same outline, different container. A docked 15rem panel has nowhere to
        go on a phone, so the mobile presentation is a sheet — which is a
        different tree, not a restyle, hence the JS branch rather than `md:`.
        Jumping closes it, or the outline would cover the line you jumped to.
      */}
      {!isDesktop && (
        <BottomSheet
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          ariaLabel="Transcript outline"
          maxHeight="70dvh"
        >
          <TranscriptSidebar
            messages={messages}
            onJump={(id) => {
              jumpTo(id);
              setSidebarOpen(false);
            }}
          />
        </BottomSheet>
      )}

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
        onInterrupt={interrupt}
        turnRunning={turnRunning}
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
