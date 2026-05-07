import { useState, type KeyboardEvent } from 'react';
import { PromptHistoryDropdown } from '../prompt-history/PromptHistoryDropdown';

interface InputBoxProps {
  onSend(text: string): void;
  onStop(): void;
  disabled: boolean;
  currentProjectPath?: string;
}

export function InputBox({
  onSend,
  onStop,
  disabled,
  currentProjectPath,
}: InputBoxProps): JSX.Element {
  const [text, setText] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);

  const submit = (): void => {
    const t = text.trim();
    if (t.length === 0) return;
    onSend(t);
    setText('');
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
      <textarea
        value={text}
        placeholder={
          disabled
            ? 'Session ended.'
            : 'Type a prompt. Cmd/Ctrl+Enter to send. ↑ on empty input opens history.'
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        rows={3}
        disabled={disabled}
      />
      <div className="input-actions">
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
        <button type="button" onClick={submit} disabled={disabled || text.trim().length === 0}>
          Send
        </button>
      </div>
    </div>
  );
}
