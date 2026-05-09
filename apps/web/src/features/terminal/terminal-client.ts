import { getBridgeClient } from '../../services/bridge-client-singleton';

function newCorrelationId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function startTerminal(cwd: string, cols: number, rows: number): string {
  const correlationId = newCorrelationId();
  getBridgeClient().send({ type: 'term_start', cwd, cols, rows, correlationId });
  return correlationId;
}
export function killTerminal(termId: string): void {
  getBridgeClient().send({ type: 'term_kill', termId, correlationId: newCorrelationId() });
}
export function sendTerminalInput(termId: string, data: string): void {
  getBridgeClient().send({ type: 'term_input', termId, data });
}
export function resizeTerminal(termId: string, cols: number, rows: number): void {
  getBridgeClient().send({ type: 'term_resize', termId, cols, rows });
}
