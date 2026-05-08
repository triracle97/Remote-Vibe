import { useRef, useState, type KeyboardEvent } from 'react';
import { Paperclip, History } from 'lucide-react';
import { PromptHistoryDropdown } from '../prompt-history/PromptHistoryDropdown';
import { ImageThumbnails } from '../image-attach/ImageThumbnails';
import type { PendingImage, UseImagePaste } from '../image-attach/useImagePaste';
import type { AgentKind } from '../../types/protocol';
import { SlashAutocomplete, type SlashAutocompleteHandle } from './SlashAutocomplete';
import { AtTagAutocomplete, type AtTagAutocompleteHandle } from './AtTagAutocomplete';

interface InputBoxProps {
  onSend(text: string, images?: ReadonlyArray<{ mime: string; base64: string }>): void;
  onStop(): void;
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
  const imagesEnabled = agent === 'claude' && !disabled;
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
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
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

  const onPaste: React.ClipboardEventHandler<HTMLTextAreaElement> = async (e) => {
    if (!imagesEnabled) return;
    const items = Array.from(e.clipboardData?.items ?? []);
    const files = items
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) await addImageFromFile(f);
  };

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
              : agent === 'codex'
                ? 'Type a prompt. Cmd/Ctrl+Enter to send. ↑ on empty input opens history. (Codex: no image input.)'
                : 'Type a prompt. Cmd/Ctrl+Enter to send. ↑ on empty input opens history. Paste/drop/📎 to attach images.'
          }
          onChange={(e) => {
            setText(e.target.value);
            setCursor(e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={onKey}
          onKeyUp={updateCursor}
          onSelect={updateCursor}
          onClick={updateCursor}
          onPaste={onPaste}
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
              title={agent === 'codex' ? 'Codex sessions do not accept images' : 'Attach image (paste / drop / click)'}
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
            <button
              type="button"
              onClick={onStop}
              disabled={disabled}
              className="flex items-center gap-2 px-3 py-2 min-h-[44px] bg-[var(--color-surface)] text-[var(--color-text)] rounded-lg text-sm font-medium hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span className="w-2.5 h-2.5 bg-[var(--color-text)] rounded-sm shrink-0" aria-hidden="true" />
              <span>Stop</span>
            </button>
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
