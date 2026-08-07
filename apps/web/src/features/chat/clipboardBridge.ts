import { getBridgeClient, hasBridgeClient } from '../../services/bridge-client-singleton';

/**
 * Ask the bridge host what the pasted files' absolute paths are.
 *
 * See `clipboardPaths.ts` for why the browser cannot answer this itself: a
 * `File` off a paste event has had every path component stripped, and no web
 * API gives it back. The bridge runs unsandboxed on the Mac that holds the
 * pasteboard, so it can read the `file://` URLs directly.
 *
 * The `names` the browser *did* see travel with the request and bound the
 * answer — the bridge returns only paths whose basename is among them. That
 * keeps the call honest when the browser is somewhere else entirely (a phone
 * over Tailscale), where the host's clipboard is unrelated and simply fails to
 * match.
 */

const REQUEST_TIMEOUT_MS = 2500;

export function requestClipboardPaths(names: readonly string[]): Promise<string[]> {
  // No socket means component tests, or a paste before the app connected.
  if (names.length === 0 || !hasBridgeClient()) return Promise.resolve([]);
  const client = getBridgeClient();
  const correlationId = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise((resolve) => {
    let settled = false;
    let off: (() => void) | null = null;
    let timer = 0;
    const finish = (paths: string[]): void => {
      if (settled) return;
      settled = true;
      off?.();
      window.clearTimeout(timer);
      resolve(paths);
    };

    off = client.on('message', (m) => {
      if (m.type === 'clipboard_paths' && m.correlationId === correlationId) finish(m.paths);
    });
    // An older bridge answers `get_clipboard_paths` with nothing at all, so the
    // timeout is the normal exit there, not just a failure mode.
    timer = window.setTimeout(() => finish([]), REQUEST_TIMEOUT_MS);
    client.send({ type: 'get_clipboard_paths', names: [...names], correlationId });
  });
}
