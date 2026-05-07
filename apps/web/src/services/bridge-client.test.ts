import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BridgeClient } from './bridge-client';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  url: string;
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(new CloseEvent('close', { code: 1000 })); }
  open() { this.readyState = 1; this.onopen?.(new Event('open')); }
  receive(obj: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(obj) })); }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BridgeClient', () => {
  it('connects to /ws relative to origin', () => {
    const client = new BridgeClient();
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.url.endsWith('/ws')).toBe(true);
  });

  it('emits "open" when underlying socket opens', () => {
    const client = new BridgeClient();
    const onOpen = vi.fn();
    client.on('open', onOpen);
    client.connect();
    FakeWebSocket.instances[0]!.open();
    expect(onOpen).toHaveBeenCalled();
  });

  it('emits "message" with parsed JSON payloads', () => {
    const client = new BridgeClient();
    const onMsg = vi.fn();
    client.on('message', onMsg);
    client.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.receive({ type: 'system', event: 'init' });
    expect(onMsg).toHaveBeenCalledWith({ type: 'system', event: 'init' });
  });

  it('send() serializes outgoing messages to JSON', () => {
    const client = new BridgeClient();
    client.connect();
    FakeWebSocket.instances[0]!.open();
    client.send({ type: 'list_sessions' });
    expect(FakeWebSocket.instances[0]!.sent).toEqual([JSON.stringify({ type: 'list_sessions' })]);
  });

  it('reconnects with backoff after close', () => {
    const client = new BridgeClient();
    client.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.close();

    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('caps backoff at MAX_BACKOFF_MS', () => {
    const client = new BridgeClient();
    client.connect();
    for (let i = 0; i < 20; i++) {
      const sock = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
      sock.open();
      sock.close();
      vi.advanceTimersByTime(60_000);
    }
    expect(FakeWebSocket.instances.length).toBeGreaterThan(15);
  });
});
