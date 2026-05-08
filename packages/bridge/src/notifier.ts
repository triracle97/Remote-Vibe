import type { RegistryEntry } from './session-registry.js';

interface NotifierOpts {
  token?: string;
  chatId?: string;
  minDurationMs: number;
  publicUrl?: string;
}

export class Notifier {
  private readonly enabled: boolean;
  private turnStart = new Map<string, number>();
  private failureCounter = new Map<string, number>();

  constructor(private readonly opts: NotifierOpts) {
    this.enabled = !!(opts.token && opts.chatId);
  }

  noteInput(sessionId: string): void {
    if (!this.enabled) return;
    this.turnStart.set(sessionId, Date.now());
  }

  noteSessionEnd(sessionId: string): void {
    this.turnStart.delete(sessionId);
    this.failureCounter.delete(sessionId);
  }

  async noteResult(session: RegistryEntry): Promise<void> {
    if (!this.enabled) return;
    const start = this.turnStart.get(session.webSessionId);
    this.turnStart.delete(session.webSessionId);
    const duration = start !== undefined ? Date.now() - start : 0;
    if (duration < this.opts.minDurationMs) return;

    const text = this.buildText(session, duration);
    try {
      const url = `https://api.telegram.org/bot${this.opts.token}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.opts.chatId, text }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      this.failureCounter.delete(session.webSessionId);
    } catch (err: unknown) {
      const count = (this.failureCounter.get(session.webSessionId) ?? 0) + 1;
      this.failureCounter.set(session.webSessionId, count);
      console.error('[notifier] sendMessage failed:', (err as Error).message);
      if (count === 5) {
        console.error(
          '[notifier] 5 consecutive failures — verify BRIDGE_TELEGRAM_BOT_TOKEN + BRIDGE_TELEGRAM_CHAT_ID',
        );
      }
    }
  }

  private buildText(session: RegistryEntry, duration: number): string {
    const name = session.name ?? '(unnamed session)';
    const dur = formatDuration(duration);
    const lines = [`Session '${name}' completed`, `took ${dur}`];
    if (this.opts.publicUrl) {
      const base = this.opts.publicUrl.replace(/\/$/, '');
      lines.push(`${base}/session/${session.webSessionId}`);
    }
    return lines.join('\n');
  }
}

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
