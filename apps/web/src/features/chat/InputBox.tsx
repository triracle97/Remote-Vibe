import { useRef, useState, type KeyboardEvent } from 'react';
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
    <div className="input-box" style={{ position: 'relative' }}>
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
      {error && <div className="image-attach-error">{error}</div>}
      {showResumePromptInline && (
        <div className="resume-prompt">
          <span>Sending will resume the session — </span>
          <button
            type="button"
            className="resume-prompt-button"
            onClick={() => void onResumeAndSend()}
          >
            Resume + send
          </button>
        </div>
      )}
      <div className="input-textarea-wrap" style={{ position: 'relative' }}>
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
            // selectionStart updates synchronously after the change; capture it.
            setCursor(e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={onKey}
          onKeyUp={updateCursor}
          onSelect={updateCursor}
          onClick={updateCursor}
          onPaste={onPaste}
          rows={3}
          disabled={disabled}
        />
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        style={{ display: 'none' }}
        onChange={onFileInputChange}
      />
      <div className="input-actions">
        <button
          type="button"
          className="image-attach-button"
          onClick={onAttachClick}
          disabled={!imagesEnabled}
          title={
            agent === 'codex'
              ? 'Codex sessions do not accept images'
              : 'Attach image (paste / drop / click)'
          }
          aria-label="Attach image"
        >
          📎
        </button>
        <button
          type="button"
          onClick={() => setHistoryOpen((h) => !h)}
          disabled={disabled}
          aria-label="Toggle prompt history"
        >
          ⌘H
        </button>
        <button type="button" onClick={onStop} disabled={disabled}>
          Stop
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={disabled || (text.trim().length === 0 && images.length === 0)}
        >
          Send
        </button>
      </div>
    </div>
  );
}
