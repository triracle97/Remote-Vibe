import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionsStore } from '../../store/sessions';
import type { BridgeClient } from '../../services/bridge-client';
import { ProjectPicker, type ProjectPickerSelection } from './ProjectPicker';

function newCorrelationId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function useNewSession(client: BridgeClient): {
  open(): void;
  pickerNode: JSX.Element | null;
} {
  const navigate = useNavigate();
  const sessionsMap = useSessionsStore((s) => s.sessions);
  const [pickerOpen, setPickerOpen] = useState(false);
  const awaitingCorrelationRef = useRef<string | null>(null);

  // Existing AI-session match path (unchanged).
  useEffect(() => {
    const target = awaitingCorrelationRef.current;
    if (!target) return;
    for (const s of Object.values(sessionsMap)) {
      const matched = s.events.find(
        (e) =>
          e.type === 'system' &&
          e.event === 'session_created' &&
          e.correlationId === target,
      );
      if (matched) {
        awaitingCorrelationRef.current = null;
        navigate(`/session/${s.sessionId}`);
        return;
      }
    }
  }, [sessionsMap, navigate]);

  // Subscribe to term_started replies for navigation.
  useEffect(() => {
    if (typeof client.on !== 'function') return;
    const off = client.on('message', (m) => {
      const target = awaitingCorrelationRef.current;
      if (!target) return;
      if (m.type === 'term_started' && m.correlationId === target) {
        awaitingCorrelationRef.current = null;
        navigate(`/terminal/${m.termId}`);
      }
    });
    return off;
  }, [client, navigate]);

  const pickerNode = pickerOpen ? (
    <ProjectPicker
      onCancel={() => setPickerOpen(false)}
      onPick={(selection: ProjectPickerSelection) => {
        const correlationId = newCorrelationId();
        awaitingCorrelationRef.current = correlationId;
        if (selection.agent === 'terminal') {
          // Single dir only for terminal; ignore extras if any.
          const cwd = selection.dirs[0]!;
          // Default starting size; FitAddon resizes on first paint.
          const cols = 80;
          const rows = 24;
          client.send({ type: 'term_start', cwd, cols, rows, correlationId });
        } else {
          client.send({
            type: 'start',
            agent: selection.agent,
            dirs: selection.dirs,
            projectPath: selection.projectPath,
            ...(selection.account ? { account: selection.account } : {}),
            correlationId,
          });
        }
        setPickerOpen(false);
      }}
    />
  ) : null;

  return {
    open: () => setPickerOpen(true),
    pickerNode,
  };
}
