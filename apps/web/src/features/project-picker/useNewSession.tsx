import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionsStore } from '../../store/sessions';
import type { BridgeClient } from '../../services/bridge-client';
import { ProjectPicker } from './ProjectPicker';

// crypto.getRandomValues is available in non-secure contexts (the Tailscale
// IP serves plain HTTP, so crypto.randomUUID would not be defined). 16 random
// bytes hex-encoded is sufficient correlation entropy for one operator.
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
  // Track the correlationId of the in-flight `start` request, NOT a "next
  // session arrives" boolean. order.length growth could be triggered by
  // an unrelated list_sessions arriving from App.connect — that race would
  // navigate to the wrong session. Matching by correlationId pins us to
  // the session this hook actually started.
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
      onPick={(path) => {
        const correlationId = newCorrelationId();
        awaitingCorrelationRef.current = correlationId;
        client.send({ type: 'start', agent: 'claude', projectPath: path, correlationId });
        setPickerOpen(false);
      }}
    />
  ) : null;

  return {
    open: () => setPickerOpen(true),
    pickerNode,
  };
}
