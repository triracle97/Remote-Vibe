import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Notifier, formatDuration } from '../notifier';

describe('Notifier', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('env unset → no-op stub does NOT call fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const n = new Notifier({ minDurationMs: 0 });
    n.noteInput('s1');
    await n.noteResult({
      webSessionId: 's1',
      name: 'test',
      agent: 'claude',
      projectPath: '/x',
      transcriptPath: '/x',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 0,
      account: null,
      additionalDirs: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('threshold 0 + env set → fetches on every result', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const n = new Notifier({ token: 'TOK', chatId: '123', minDurationMs: 0 });
    n.noteInput('s1');
    // Force a tiny delay
    await new Promise((r) => setTimeout(r, 10));
    await n.noteResult({
      webSessionId: 's1',
      name: 'test',
      agent: 'claude',
      projectPath: '/x',
      transcriptPath: '/x',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 0,
      account: null,
      additionalDirs: [],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0]!;
    expect((call[0] as string).includes('/botTOK/sendMessage')).toBe(true);
  });

  it('threshold filter: short turn does NOT fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const n = new Notifier({ token: 'TOK', chatId: '123', minDurationMs: 60_000 });
    n.noteInput('s1');
    await new Promise((r) => setTimeout(r, 10));
    await n.noteResult({
      webSessionId: 's1',
      name: 'test',
      agent: 'claude',
      projectPath: '/x',
      transcriptPath: '/x',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 0,
      account: null,
      additionalDirs: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('PUBLIC_URL set → message contains link', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const n = new Notifier({
      token: 'TOK',
      chatId: '123',
      minDurationMs: 0,
      publicUrl: 'http://100.x.x.x:7777',
    });
    n.noteInput('s1');
    await n.noteResult({
      webSessionId: 'web-abc',
      name: 'test name',
      agent: 'claude',
      projectPath: '/x',
      transcriptPath: '/x',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 0,
      account: null,
      additionalDirs: [],
    });
    const call = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((call[1] as { body: string }).body) as { text: string };
    expect(body.text).toContain('http://100.x.x.x:7777/session/web-abc');
  });

  it('PUBLIC_URL trailing slash sanitized', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const n = new Notifier({
      token: 'TOK',
      chatId: '123',
      minDurationMs: 0,
      publicUrl: 'http://100.x.x.x:7777/',
    });
    n.noteInput('s1');
    await n.noteResult({
      webSessionId: 'abc',
      name: 'x',
      agent: 'claude',
      projectPath: '/x',
      transcriptPath: '/x',
      claudeSessionId: null,
      codexSessionId: null,
      createdAt: 0,
      account: null,
      additionalDirs: [],
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as { body: string }).body,
    ) as { text: string };
    expect(body.text).toContain('http://100.x.x.x:7777/session/abc');
    expect(body.text).not.toContain('//session');
  });

  it('formatDuration', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_725_000)).toBe('1h 2m 5s');
  });
});
