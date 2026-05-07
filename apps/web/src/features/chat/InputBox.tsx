import { useRef, useState, type KeyboardEvent } from 'react';
import { PromptHistoryDropdown } from '../prompt-history/PromptHistoryDropdown';
import { ImageThumbnails } from '../image-attach/ImageThumbnails';
import type { UseImagePaste } from '../image-attach/useImagePaste';
import type { AgentKind } from '../../types/protocol';

interface InputBoxProps {
  onSend(text: string, images?: ReadonlyArray<{ mime: string; base64: string }>): void;
  onStop(): void;
  disabled: boolean;
  currentProjectPath?: string;
  agent: AgentKind;
  // Owned by Chat.tsx so drag-drop on the chat area and paste on the
  // textarea share the same image list.
  imagePaste: UseImagePaste;
}

export function InputBox({
  onSend,
  onStop,
  disabled,
  currentProjectPath,
  agent,
  imagePaste,
}: InputBoxProps): JSX.Element {
  const [text, setText] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesEnabled = agent === 'claude' && !disabled;
  const { images, error, addImageFromFile, removeImage, clear } = imagePaste;

  const submit = (): void => {
    const t = text.trim();
    if (t.length === 0 && images.length === 0) return;
    if (images.length > 0) {
      onSend(
        t,
        images.map((img) => ({ mime: img.mime, base64: img.base64 })),
      );
    } else {
      onSend(t);
    }
    setText('');
    clear();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
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
      <textarea
        value={text}
        placeholder={
          disabled
            ? 'Session ended.'
            : agent === 'codex'
              ? 'Type a prompt. Cmd/Ctrl+Enter to send. ↑ on empty input opens history. (Codex: no image input.)'
              : 'Type a prompt. Cmd/Ctrl+Enter to send. ↑ on empty input opens history. Paste/drop/📎 to attach images.'
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        rows={3}
        disabled={disabled}
      />
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
