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
    <div className="session-rename-inline">
      <input
        ref={inputRef}
        type="text"
        className="session-rename-input"
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
        className="session-rename-save"
        onClick={() => void submit()}
        disabled={saving}
        aria-label="Save name"
      >
        Save
      </button>
      <button
        type="button"
        className="session-rename-cancel"
        onClick={onClose}
        disabled={saving}
        aria-label="Cancel rename"
      >
        ✕
      </button>
      {error !== null && <span className="session-rename-error">{error}</span>}
    </div>
  );
}
