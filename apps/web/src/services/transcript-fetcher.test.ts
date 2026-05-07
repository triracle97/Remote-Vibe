import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { streamTranscript } from './transcript-fetcher';

function makeMockResponse(body: string, status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamTranscript', () => {
  it('yields each NDJSON line as a parsed object', async () => {
    const body =
      JSON.stringify({ type: 'system', event: 'session_created', sessionId: 'a', seq: 1 }) +
      '\n' +
      JSON.stringify({ type: 'user', sessionId: 'a', seq: 2, payload: { text: 'hi' } }) +
      '\n';
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(makeMockResponse(body));
    const out: unknown[] = [];
    for await (const ev of streamTranscript('a')) out.push(ev);
    expect(out).toHaveLength(2);
    expect((out[1] as { type: string }).type).toBe('user');
  });

  it('throws on 404', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(makeMockResponse('', 404));
    const it = streamTranscript('a');
    await expect(it.next()).rejects.toThrow(/404/);
  });

  it('handles partial chunks across newline boundaries', async () => {
    const body = JSON.stringify({ type: 'user', sessionId: 'a', seq: 1, payload: { text: 'hi' } }) + '\n';
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body.slice(0, 10)));
        controller.enqueue(encoder.encode(body.slice(10)));
        controller.close();
      },
    });
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(new Response(stream, { status: 200 }));
    const out: unknown[] = [];
    for await (const ev of streamTranscript('a')) out.push(ev);
    expect(out).toHaveLength(1);
  });
});
