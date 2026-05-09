import { useCallback, useEffect, useRef } from 'react';
import { getBridgeClient } from '../../services/bridge-client-singleton';
import type { ServerMsg } from '../../types/protocol';
import { killTerminal, sendTerminalInput, resizeTerminal } from './terminal-client';

export interface UseTerminalSessionOpts {
  termId: string;
  onData(data: string): void;
  onExit?(exitCode: number | null, signal: string | null): void;
}

export interface TerminalSessionApi {
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
}

export function useTerminalSession(opts: UseTerminalSessionOpts): TerminalSessionApi {
  const { termId, onData, onExit } = opts;
  const onDataRef = useRef(onData);
  const onExitRef = useRef(onExit);
  onDataRef.current = onData;
  onExitRef.current = onExit;

  useEffect(() => {
    const client = getBridgeClient();
    const off = client.on('message', (m: ServerMsg) => {
      if (m.type === 'term_output' && m.termId === termId) onDataRef.current(m.data);
      else if (m.type === 'term_exit' && m.termId === termId) onExitRef.current?.(m.exitCode, m.signal);
    });
    return () => {
      off();
      killTerminal(termId);
    };
  }, [termId]);

  const sendInput = useCallback((data: string) => sendTerminalInput(termId, data), [termId]);
  const resize = useCallback((cols: number, rows: number) => resizeTerminal(termId, cols, rows), [termId]);
  return { sendInput, resize };
}
