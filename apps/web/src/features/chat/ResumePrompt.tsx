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
    <div className="resume-prompt">
      <span>session ended — </span>
      <button type="button" className="resume-prompt-button" onClick={onResume}>
        Resume
      </button>
    </div>
  );
}
