import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Paperclip, History } from 'lucide-react';
import { useHasKeyboard } from '../../shell/useHasKeyboard';
import { isMac } from '../../shell/shortcuts';
import { PromptHistoryDropdown } from '../prompt-history/PromptHistoryDropdown';
import { ImageThumbnails } from '../image-attach/ImageThumbnails';
import { imageFilesFromClipboard } from '../image-attach/clipboardImages';
import {
  absolutePathsFromDataTransfer,
  bareNameFromText,
  basename,
  fileNamesFromDataTransfer,
  resolveUniqueByBasename,
} from './clipboardPaths';
import { requestClipboardPaths } from './clipboardBridge';
import { useFileSearchStore } from './fileSearchStore';
import { hasBridgeClient } from '../../services/bridge-client-singleton';
import type { PendingImage, UseImagePaste } from '../image-attach/useImagePaste';
import type { AgentKind } from '../../types/protocol';
import { SlashAutocomplete, type SlashAutocompleteHandle } from './SlashAutocomplete';
import { AtTagAutocomplete, type AtTagAutocompleteHandle } from './AtTagAutocomplete';

interface InputBoxProps {
  onSend(text: string, images?: ReadonlyArray<{ mime: string; base64: string }>): void;
  onStop(): void;
  /** Stop the turn in flight, leaving the session alive. */
  onInterrupt?(): void;
  /** True while the agent is mid-turn, i.e. while there is something to stop. */
  turnRunning?: boolean;
  /**
   * Orthogonal "input is unavailable" flag (e.g. global error / streaming).
   * Distinct from `alive`: a dead session does NOT disable InputBox here,
   * because the auto-prompt-on-send flow needs the textarea + Send button
   * to remain interactive so we can intercept submit and offer the
   * "Resume + send" CTA.
   */
  disabled: boolean;
  /**
   * Whether the underlying session is alive. When false, submitting does
   * NOT call `onSend` immediately — instead InputBox surfaces an inline
   * "Resume + send" CTA. Clicking that CTA calls `onResume()` and then
   * flushes the captured message via `onSend`.
   */
  alive: boolean;
  /** Resume the session (Chat.tsx wires this to the sessions store). */
  onResume(): Promise<unknown>;
  currentProjectPath?: string;
  agent: AgentKind;
  // Owned by Chat.tsx so drag-drop on the chat area and paste on the
  // textarea share the same image list.
  imagePaste: UseImagePaste;
  /** Session id — drives slash-command + file-search lookups. */
  sessionId: string;
}

export function InputBox({
  onSend,
  onStop,
  onInterrupt,
  turnRunning = false,
  disabled,
  alive,
  onResume,
  currentProjectPath,
  agent,
  imagePaste,
  sessionId,
}: InputBoxProps): JSX.Element {
  const [text, setText] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const hasKeyboard = useHasKeyboard();
  const sendHint = hasKeyboard
    ? 'Enter to send, Shift+Enter for a new line.'
    : 'Cmd/Ctrl+Enter or the send button to send.';
  // Captured at submit-time when the session is dead. Preserves the message
  // even if the user erases or retypes the textarea while the resume is
  // in-flight (or before they click "Resume + send").
  const [queuedMessage, setQueuedMessage] = useState('');
  const [queuedImages, setQueuedImages] = useState<readonly PendingImage[]>([]);
  const [showResumePromptInline, setShowResumePromptInline] = useState(false);
  const [cursor, setCursor] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const slashRef = useRef<SlashAutocompleteHandle>(null);
  const atRef = useRef<AtTagAutocompleteHandle>(null);
  // Image attach is allowed on dead Claude sessions too — the message + images
  // get queued and flush after resume succeeds.
  // Both CLIs take images — Claude inline on stdin, Codex via `codex exec -i`
  // — so the only gate left is whether the composer is usable at all.
  const imagesEnabled = !disabled;
  const { images, error, addImageFromFile, removeImage, clear } = imagePaste;

  const updateCursor = (): void => {
    setCursor(taRef.current?.selectionStart ?? 0);
  };

  const onPick = (newText: string, newCursor: number): void => {
    setText(newText);
    setCursor(newCursor);
    // Restore selection on the textarea after React commits the new value.
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(newCursor, newCursor);
      }
    });
  };

  const submit = (): void => {
    const t = text.trim();
    if (t.length === 0 && images.length === 0) return;
    if (!alive) {
      // Intercept: capture the message-as-of-submit-time + currently-attached
      // images and surface the inline "Resume + send" CTA. Anything the user
      // types AFTER this point stays in the textarea (does NOT auto-send).
      setQueuedMessage(text);
      setQueuedImages(images.slice());
      setShowResumePromptInline(true);
      return;
    }
    if (images.length > 0) {
      onSend(
        t,
        images.map((img) => ({ mime: img.mime, base64: img.base64 })),
      );
    } else {
      onSend(t);
    }
    setText('');
    setCursor(0);
    clear();
  };

  const onResumeAndSend = async (): Promise<void> => {
    // Snapshot the captured payload, then drop the inline CTA before any
    // awaits so a slow resume doesn't strand a stale CTA on screen.
    const captured = queuedMessage;
    const capturedImages = queuedImages;
    setShowResumePromptInline(false);
    setQueuedMessage('');
    setQueuedImages([]);
    // Strip the captured prefix from the live textarea ONLY if it's still
    // there. If the user has erased + retyped during the wait, leave their
    // current text alone — anything they've typed since is the NEXT message.
    if (text.startsWith(captured)) {
      setText(text.slice(captured.length));
    }
    // Also drop the captured images from the live attach list, ONLY if those
    // exact ids still exist. User-added images during the wait survive.
    const capturedIds = new Set(capturedImages.map((i) => i.id));
    if (capturedIds.size > 0) {
      for (const id of capturedIds) {
        if (images.some((i) => i.id === id)) removeImage(id);
      }
    }
    await onResume();
    const t = captured.trim();
    if (capturedImages.length > 0) {
      onSend(
        t,
        capturedImages.map((img) => ({ mime: img.mime, base64: img.base64 })),
      );
    } else {
      onSend(t);
    }
    // Do NOT touch setText/clear here — anything currently in the textarea
    // is the user's NEXT message, queued during resume; they will send it
    // manually with the next click.
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Autocomplete keyboard hijack first: if either popup is open, route
    // ↑↓+Enter+Tab+Esc to the popup instead of the normal handlers.
    const slashOpen = slashRef.current?.isOpen() ?? false;
    const atOpen = atRef.current?.isOpen() ?? false;
    if (slashOpen || atOpen) {
      if (e.key === 'Escape') {
        // Don't close textarea. Easiest dismiss: insert a space at the
        // cursor (breaks the trigger regex). But that mutates user text,
        // which is rude. Alternative: nudge cursor right with no edit —
        // doesn't work either. We instead just suppress until user types
        // something that breaks the trigger. Esc is a no-op besides
        // preventing the upstream history-close behavior.
        return;
      }
      const handler = slashOpen ? slashRef.current : atRef.current;
      if (handler && handler.handleKey(e)) {
        return;
      }
    }
    if (e.key === 'Enter') {
      // Never act mid-composition: on a CJK or predictive keyboard Enter is how
      // you accept the candidate, and sending there would fire off half a word.
      if (e.nativeEvent.isComposing) return;
      // Cmd/Ctrl+Enter always sends, on every device — it was the original
      // binding and stays in muscle memory.
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        submit();
        return;
      }
      if (e.shiftKey || e.altKey) return; // deliberate newline
      // Bare Enter sends only where Shift+Enter can actually be typed. Software
      // keyboards cannot produce it, so on a phone Enter has to stay a newline
      // or there is no way to write a second line at all; the send button is
      // the affordance there.
      if (hasKeyboard) {
        e.preventDefault();
        submit();
      }
      return;
    }
    if (e.key === 'ArrowUp' && text.length === 0) {
      e.preventDefault();
      setHistoryOpen(true);
      return;
    }
    if (e.key === 'Escape' && historyOpen) {
      e.preventDefault();
      setHistoryOpen(false);
    }
  };

  /**
   * ⌘/Ctrl+V anywhere in the app attaches an image from the clipboard.
   *
   * Bound to the document rather than the textarea. It used to be a React
   * `onPaste` on the composer, which meant a screenshot only pasted if you had
   * already clicked into the input — paste right after taking it, with focus
   * still on the transcript or a button, and nothing happened at all.
   *
   * Text pastes are untouched: the handler bails unless the clipboard actually
   * carries image files, so pasting into the rename box or the file editor
   * behaves exactly as before.
   */
  /**
   * Append text at the end of the composer and put the cursor after it.
   *
   * Used for pasted file paths, which arrive from a document-level listener
   * that has no reliable cursor position — the textarea may not even have been
   * focused when the paste happened.
   */
  const appendToComposer = useCallback((insertText: string) => {
    setText((prev) => {
      const sep = prev.length === 0 || /\s$/.test(prev) ? '' : ' ';
      return `${prev}${sep}${insertText} `;
    });
    // Focus and caret placement are deferred out of the event handler. Calling
    // `focus()` inline dispatches a focus event while React is still processing
    // this one, which re-enters the renderer ("Should not already be working").
    // A task boundary also lets the new value commit first, so the caret lands
    // at the end instead of snapping to 0.
    setTimeout(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }, 0);
  }, []);

  /**
   * Swap a bare filename already sitting in the composer for its full path.
   *
   * The *last* occurrence, because the name was appended at the end — an
   * earlier mention of `types.ts` in the prompt is prose, not the paste.
   */
  const upgradeNameInComposer = useCallback((name: string, full: string) => {
    setText((prev) => {
      if (prev.includes(full)) return prev;
      const i = prev.lastIndexOf(name);
      return i < 0 ? prev : `${prev.slice(0, i)}${full}${prev.slice(i + name.length)}`;
    });
  }, []);

  /**
   * Ask the bridge host's pasteboard where these names live, and rewrite the
   * ones it can account for. Returns the names it could not.
   *
   * This is the exact answer when the browser and the bridge share a Mac, which
   * is the case a Finder ⌘C is usually in. It resolves what the file index
   * cannot: directories, files outside the session's dirs, and names that
   * appear more than once in the tree.
   */
  const upgradeFromHostClipboard = useCallback(
    async (names: readonly string[]): Promise<string[]> => {
      const unresolved = new Set(names);
      for (const full of await requestClipboardPaths(names)) {
        const name = basename(full);
        if (!unresolved.delete(name)) continue;
        upgradeNameInComposer(name, full);
      }
      return [...unresolved];
    },
    [upgradeNameInComposer],
  );

  /**
   * Last resort: look the name up in the session's own file index.
   *
   * A guess rather than an answer, so only an unambiguous hit counts —
   * silently pasting the wrong `config.ts` is worse than pasting the name and
   * letting the user fix it.
   */
  const upgradeFromFileIndex = useCallback(
    (names: readonly string[]) => {
      if (!hasBridgeClient()) return;
      for (const name of names) {
        useFileSearchStore.getState().search(sessionId, name);
        // One shot, after the round trip. A miss simply leaves the filename.
        setTimeout(() => {
          const hits = useFileSearchStore.getState().bySession[sessionId]?.hits ?? [];
          const full = resolveUniqueByBasename(name, hits);
          if (full) upgradeNameInComposer(name, full);
        }, 400);
      }
    },
    [sessionId, upgradeNameInComposer],
  );

  /**
   * Turn pasted or dropped files into absolute paths in the composer.
   *
   * Two sources, because the platform gives two different things (see
   * `clipboardPaths.ts`). A `file://` URI is exact and used as-is. A bare
   * filename is not: the name goes in immediately so the paste never feels
   * dropped, then the host clipboard — and failing that the file index —
   * upgrades it in place.
   */
  const insertPaths = useCallback(
    (paths: readonly string[], names: readonly string[]): boolean => {
      if (paths.length > 0) {
        appendToComposer(paths.join(' '));
        return true;
      }
      if (names.length === 0) return false;

      appendToComposer(names.join(' '));
      void upgradeFromHostClipboard(names).then(upgradeFromFileIndex);
      return true;
    },
    [appendToComposer, upgradeFromHostClipboard, upgradeFromFileIndex],
  );

  /**
   * A file dropped anywhere on the chat surface, not just the composer.
   *
   * `Chat` owns the drop zone and extracts the strings there — a `DataTransfer`
   * is only readable inside its own handler, so it cannot be forwarded — then
   * announces them. This mirrors how the file-drawer shortcut is delivered.
   */
  useEffect(() => {
    const onDropped = (e: Event): void => {
      const detail = (e as CustomEvent<{ paths: string[]; names: string[] }>).detail;
      if (!detail) return;
      insertPaths(detail.paths ?? [], detail.names ?? []);
    };
    window.addEventListener('mrt:dropped-files', onDropped);
    return () => window.removeEventListener('mrt:dropped-files', onDropped);
  }, [insertPaths]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      // `DataTransferItem`s are only valid for the synchronous lifetime of the
      // event, so anything read off them has to come out before any await.
      const files = imagesEnabled ? imageFilesFromClipboard(e.clipboardData) : [];
      if (files.length > 0) {
        e.preventDefault();
        void (async () => {
          for (const f of files) await addImageFromFile(f);
        })();
        taRef.current?.focus();
        return;
      }
      // A `file://` URI is unambiguous — claim it wherever it came from.
      const paths = absolutePathsFromDataTransfer(e.clipboardData);
      if (paths.length > 0) {
        e.preventDefault();
        insertPaths(paths, []);
        return;
      }
      // Otherwise only claim it when a real file rode along. A text paste —
      // including one into the rename box or the file editor — falls through
      // untouched.
      const hasFileItem = Array.from(e.clipboardData?.items ?? []).some(
        (i) => i.kind === 'file',
      );
      const names = hasFileItem ? fileNamesFromDataTransfer(e.clipboardData) : [];
      if (names.length > 0 && insertPaths([], names)) {
        e.preventDefault();
        return;
      }
      // A folder copied in Finder can arrive as nothing but its name in
      // `text/plain` — a directory is not a `File`, so no file item rides
      // along and there is nothing to distinguish this from someone pasting a
      // word. So the paste is left alone to land normally, and only the host
      // clipboard, which either does or does not hold a file by that name,
      // decides whether to rewrite it afterwards.
      if (hasFileItem || e.target !== taRef.current) return;
      const bare = bareNameFromText(e.clipboardData?.getData('text/plain') ?? '');
      if (bare) void upgradeFromHostClipboard([bare]);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [imagesEnabled, addImageFromFile, insertPaths, upgradeFromHostClipboard]);

  const onAttachClick = (): void => {
    if (!imagesEnabled) return;
    fileInputRef.current?.click();
  };

  const onFileInputChange: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const files = Array.from(e.target.files ?? []);
    for (const f of files) await addImageFromFile(f);
    e.target.value = '';
  };

  return (
    <div className="input-box relative p-3 bg-[var(--color-surface)] border-t border-[var(--color-border)]" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
      {historyOpen && (
        <PromptHistoryDropdown
          {...(currentProjectPath !== undefined ? { currentProjectPath } : {})}
          onPick={(picked) => {
            setText(picked);
            setHistoryOpen(false);
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      <ImageThumbnails images={images} onRemove={removeImage} />
      {error && <div className="image-attach-error text-xs text-[var(--color-danger)] mb-1">{error}</div>}
      {showResumePromptInline && (
        <div className="resume-prompt flex items-center justify-center gap-2 mb-2 px-3 py-2 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-mute)] text-sm">
          <span>Sending will resume the session —</span>
          <button
            type="button"
            className="resume-prompt-button bg-[var(--color-surface)] text-[var(--color-accent)] border border-[var(--color-border)] px-3 py-1 rounded hover:bg-[var(--color-surface-2)]"
            onClick={() => void onResumeAndSend()}
          >
            Resume + send
          </button>
        </div>
      )}
      <div className="input-textarea-wrap relative bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-xl p-3 flex flex-col gap-3 shadow-inner">
        <SlashAutocomplete
          ref={slashRef}
          sessionId={sessionId}
          agent={agent}
          text={text}
          cursor={cursor}
          onPick={onPick}
        />
        <AtTagAutocomplete
          ref={atRef}
          sessionId={sessionId}
          text={text}
          cursor={cursor}
          onPick={onPick}
        />
        <textarea
          ref={taRef}
          value={text}
          placeholder={
            disabled
              ? 'Session ended.'
              : `Type a prompt. ${sendHint} ↑ on empty input opens history. Paste/drop/📎 to attach images.`
          }
          onChange={(e) => {
            setText(e.target.value);
            setCursor(e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={onKey}
          onKeyUp={updateCursor}
          onSelect={updateCursor}
          onClick={updateCursor}
          rows={3}
          disabled={disabled}
          className="bg-transparent border-0 outline-none ring-0 text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] resize-none min-h-[3rem] text-sm md:text-[15px] focus:ring-0 disabled:opacity-60"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="hidden"
          onChange={onFileInputChange}
        />
        <div className="input-actions flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="image-attach-button p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[color-mix(in_srgb,var(--color-surface)_70%,transparent)] rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={onAttachClick}
              disabled={!imagesEnabled}
              title="Attach image (paste / drop / click)"
              aria-label="Attach image"
            >
              <Paperclip size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setHistoryOpen((h) => !h)}
              disabled={disabled}
              aria-label="Toggle prompt history"
              className="flex items-center gap-1.5 px-3 py-2 min-h-[44px] bg-[var(--color-surface)] text-[var(--color-text-mute)] rounded-lg text-sm font-mono hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <History size={16} aria-hidden="true" />
              <span>⌘H</span>
            </button>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            {/*
              Two different stops, deliberately not merged. While a turn is
              running the prominent action is interrupting it — the session
              survives, which is what people mean by "stop". Ending the session
              is the rarer, heavier action and stays available underneath.
            */}
            {turnRunning && onInterrupt ? (
              <button
                type="button"
                onClick={onInterrupt}
                aria-label="Stop the current turn"
                title={`Stop this turn (Esc${isMac() ? '' : ' / Ctrl+C'})`}
                className="flex items-center gap-2 px-3 py-2 min-h-[44px] rounded-lg text-sm font-medium border border-[var(--color-state-running)] text-[var(--color-state-running)] hover:bg-[color-mix(in_srgb,var(--color-state-running)_12%,transparent)]"
              >
                <span className="w-2.5 h-2.5 bg-[var(--color-state-running)] rounded-sm shrink-0" aria-hidden="true" />
                <span>Stop</span>
                <kbd className="text-[10px] opacity-70 font-mono">esc</kbd>
              </button>
            ) : (
              <button
                type="button"
                onClick={onStop}
                disabled={disabled}
                aria-label="End the session"
                title="End this session"
                className="flex items-center gap-2 px-3 py-2 min-h-[44px] bg-[var(--color-surface)] text-[var(--color-text)] rounded-lg text-sm font-medium hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span className="w-2.5 h-2.5 bg-[var(--color-text)] rounded-sm shrink-0" aria-hidden="true" />
                <span>End</span>
              </button>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={disabled || (text.trim().length === 0 && images.length === 0)}
              className={[
                'flex items-center gap-1 px-5 py-2 min-h-[44px] rounded-lg text-sm font-medium transition',
                disabled || (text.trim().length === 0 && images.length === 0)
                  ? 'bg-[var(--color-surface)] text-[var(--color-text-dim)] cursor-not-allowed'
                  : 'bg-[var(--color-accent)] text-white hover:opacity-90',
              ].join(' ')}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
