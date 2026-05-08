interface ResumePromptProps {
  webSessionId: string;
  alive: boolean;
  onResume: () => void;
}

/**
 * Inline "session ended — Resume" banner. Renders only when the session is
 * not alive; clicking the CTA calls `onResume()` (Session.tsx wires this to
 * `useSessionsStore.getState().resume(webSessionId)`).
 */
export function ResumePrompt({
  webSessionId: _id,
  alive,
  onResume,
}: ResumePromptProps): JSX.Element | null {
  if (alive) return null;
  return (
    <div className="resume-prompt flex items-center justify-center gap-2 px-3 py-2 mx-3 my-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-mute)] text-sm">
      <span>session ended — </span>
      <button type="button" className="resume-prompt-button bg-[var(--color-surface-2)] text-[var(--color-accent)] border border-[var(--color-border)] px-3 py-1 rounded hover:bg-[var(--color-surface)]" onClick={onResume}>
        Resume
      </button>
    </div>
  );
}
