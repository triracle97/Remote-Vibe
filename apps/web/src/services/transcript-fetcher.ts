import type { ServerLifecycleMsg, ServerStreamMsg } from '../types/protocol';

export type TranscriptEvent = ServerLifecycleMsg | ServerStreamMsg;

export async function* streamTranscript(sessionId: string): AsyncGenerator<TranscriptEvent> {
  const response = await fetch(`/transcripts/${encodeURIComponent(sessionId)}`, {
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`GET /transcripts/${sessionId} failed with ${response.status}`);
  }
  if (!response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length === 0) continue;
      try {
        yield JSON.parse(line) as TranscriptEvent;
      } catch {
        // Skip malformed lines silently. Bridge writes valid JSON but
        // cosmic-ray-tolerance keeps the iterator productive.
      }
    }
  }
  if (buf.trim().length > 0) {
    try {
      yield JSON.parse(buf) as TranscriptEvent;
    } catch {
      /* ignore tail */
    }
  }
}
