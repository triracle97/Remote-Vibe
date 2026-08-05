import type { BridgeClient } from './bridge-client';

let registered: BridgeClient | null = null;

export function setBridgeClient(c: BridgeClient): void {
  registered = c;
}

/**
 * Whether a client is available yet.
 *
 * For callers that would like to talk to the bridge but must not fail without
 * it — decorative UI that can render empty, and component tests that never
 * mount `App`. Anything that genuinely needs the client should call
 * `getBridgeClient` and let it throw.
 */
export function hasBridgeClient(): boolean {
  return registered !== null;
}

export function getBridgeClient(): BridgeClient {
  if (registered === null) {
    throw new Error('BridgeClient has not been registered yet (App.tsx must call setBridgeClient on mount)');
  }
  return registered;
}
