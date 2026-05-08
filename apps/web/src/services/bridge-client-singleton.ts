import type { BridgeClient } from './bridge-client';

let registered: BridgeClient | null = null;

export function setBridgeClient(c: BridgeClient): void {
  registered = c;
}

export function getBridgeClient(): BridgeClient {
  if (registered === null) {
    throw new Error('BridgeClient has not been registered yet (App.tsx must call setBridgeClient on mount)');
  }
  return registered;
}
