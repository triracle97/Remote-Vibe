import { useState, type KeyboardEvent } from 'react';

interface InputBoxProps {
  onSend(text: string): void;
  onStop(): void;
  disabled: boolean;
}

export function InputBox({ onSend, onStop, disabled }: InputBoxProps): JSX.Element {
  const [text, setText] = useState('');

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
    }
  };

  return (
    <div className="input-box">
      <textarea
        value={text}
        placeholder="Type a prompt. Cmd/Ctrl+Enter to send."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        rows={3}
        disabled={disabled}
      />
      <div className="input-actions">
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
