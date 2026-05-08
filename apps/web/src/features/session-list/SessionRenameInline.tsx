import { useState, useRef, useEffect } from 'react';
import { useSessionsStore } from '../../store/sessions';

interface SessionRenameInlineProps {
  sessionId: string;
  initialName: string;
  onClose: () => void;
}

export function SessionRenameInline({
  sessionId,
  initialName,
  onClose,
}: SessionRenameInlineProps): JSX.Element {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('Name cannot be empty');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await useSessionsStore.getState().renameSession(sessionId, trimmed);
      onClose();
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? 'Rename failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="session-rename-inline flex gap-1.5 items-center p-1 flex-1">
      <input
        ref={inputRef}
        type="text"
        className="session-rename-input flex-1 min-w-0 min-h-[40px] px-2 py-1.5 bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] rounded text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        disabled={saving}
        maxLength={200}
        aria-label="Session name"
      />
      <button
        type="button"
        className="session-rename-save min-w-[44px] min-h-[44px] flex items-center justify-center bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] rounded px-2 py-1.5 hover:bg-[var(--color-surface)]"
        onClick={() => void submit()}
        disabled={saving}
        aria-label="Save name"
      >
        Save
      </button>
      <button
        type="button"
        className="session-rename-cancel min-w-[44px] min-h-[44px] flex items-center justify-center bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] rounded px-2 py-1.5 hover:bg-[var(--color-surface)]"
        onClick={onClose}
        disabled={saving}
        aria-label="Cancel rename"
      >
        ✕
      </button>
      {error !== null && <span className="session-rename-error text-xs text-[var(--color-danger)]">{error}</span>}
    </div>
  );
}
