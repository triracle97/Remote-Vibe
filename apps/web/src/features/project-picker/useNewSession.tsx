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

  const pickerNode = pickerOpen ? (
    <ProjectPicker
      onCancel={() => setPickerOpen(false)}
      onPick={(selection: ProjectPickerSelection) => {
        const correlationId = newCorrelationId();
        awaitingCorrelationRef.current = correlationId;
        client.send({
          type: 'start',
          agent: selection.agent,
          projectPath: selection.projectPath,
          ...(selection.account ? { account: selection.account } : {}),
          correlationId,
        });
        setPickerOpen(false);
      }}
    />
  ) : null;

  return {
    open: () => setPickerOpen(true),
    pickerNode,
  };
}
