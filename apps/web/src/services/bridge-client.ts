import type { ClientMsg, ServerMsg } from '../types/protocol';

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

type Listener<T> = (value: T) => void;

interface Listeners {
  open: Set<Listener<void>>;
  close: Set<Listener<void>>;
  message: Set<Listener<ServerMsg>>;
  error: Set<Listener<Error>>;
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer: number | null = null;
  private closedByUser = false;
  private listeners: Listeners = {
    open: new Set(),
    close: new Set(),
    message: new Set(),
    error: new Set(),
  };

  on<K extends keyof Listeners>(event: K, fn: Listeners[K] extends Set<infer L> ? L : never): () => void {
    (this.listeners[event] as Set<unknown>).add(fn);
    return () => (this.listeners[event] as Set<unknown>).delete(fn);
  }

  private emit<K extends keyof Listeners>(event: K, value?: unknown): void {
    for (const fn of this.listeners[event] as Set<(v: unknown) => void>) {
      try {
        fn(value);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  connect(): void {
    this.closedByUser = false;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = INITIAL_BACKOFF_MS;
      this.emit('open');
    };
    ws.onclose = () => {
      this.emit('close');
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.onerror = () => {
      this.emit('error', new Error('websocket error'));
    };
    ws.onmessage = (e) => {
      try {
        const parsed = JSON.parse(typeof e.data === 'string' ? e.data : '') as ServerMsg;
        this.emit('message', parsed);
      } catch {
        /* ignore */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.backoff;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      this.connect();
    }, delay);
  }

  send(msg: ClientMsg): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
