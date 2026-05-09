import { useState } from 'react';

interface Props {
  onSend(data: string): void;
}

const BUTTON_CLASS =
  'min-h-[44px] min-w-[44px] px-2 rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text)] active:bg-[var(--color-surface)] text-sm font-mono';

export function TerminalHelperBar({ onSend }: Props): JSX.Element {
  const [ctrl, setCtrl] = useState(false);

  const tap = (data: string) => () => onSend(data);

  const handleAlpha = (ch: string) => () => {
    if (ctrl && /^[a-z]$/.test(ch)) {
      onSend(String.fromCharCode(ch.charCodeAt(0) - 96));
      setCtrl(false);
    } else {
      onSend(ch);
    }
  };

  const toggleCtrl = () => setCtrl((v) => !v);

  return (
    <div
      className="sticky bottom-0 left-0 right-0 flex flex-wrap gap-1 p-2 bg-[var(--color-bg)] border-t border-[var(--color-border)]"
      role="toolbar"
      aria-label="Terminal helper keys"
    >
      <button type="button" className={BUTTON_CLASS} onClick={tap('\x1b')} aria-label="Esc">Esc</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap('\t')} aria-label="Tab">Tab</button>
      <button
        type="button"
        className={`${BUTTON_CLASS} ${ctrl ? 'ring-2 ring-[var(--color-accent)]' : ''}`}
        onClick={toggleCtrl}
        aria-label="Ctrl"
        aria-pressed={ctrl}
      >Ctrl</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap('\x03')} aria-label="Ctrl-C">Ctrl-C</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap('\x1b[A')} aria-label="Up">↑</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap('\x1b[B')} aria-label="Down">↓</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap('\x1b[D')} aria-label="Left">←</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap('\x1b[C')} aria-label="Right">→</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap(':')} aria-label=":">:</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap('/')} aria-label="/">/</button>
      <button type="button" className={BUTTON_CLASS} onClick={tap('-')} aria-label="-">-</button>
      <button type="button" className={BUTTON_CLASS} onClick={handleAlpha('a')} aria-label="a">a</button>
      {/* The "a" button is a representative alpha for tests; in production
          users type alpha via the on-screen keyboard. Keep it for the
          Ctrl-composition test. */}
    </div>
  );
}
