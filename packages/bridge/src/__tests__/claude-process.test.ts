import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { ClaudeProcess } from '../claude-process.js';

function makeFakeChild() {
  const stdoutPushes: string[] = [];
  const stderrPushes: string[] = [];
  const stdinWrites: string[] = [];

  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinWrites.push(chunk.toString());
      cb();
    },
  });

  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    kill: (s: NodeJS.Signals) => boolean;
    pid: number;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.kill = vi.fn().mockReturnValue(true);
  child.pid = 1234;

  return {
    child,
    pushStdout: (s: string) => {
      stdout.push(s);
      stdoutPushes.push(s);
    },
    pushStderr: (s: string) => {
      stderr.push(s);
      stderrPushes.push(s);
    },
    endStdout: () => stdout.push(null),
    endStderr: () => stderr.push(null),
    exit: (code: number) => {
      stdout.push(null);
      stderr.push(null);
      child.emit('exit', code);
    },
    stdinWrites,
  };
}

describe('ClaudeProcess', () => {
  it('passes the right argv to spawn', () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    new ClaudeProcess('/Users/test/proj', { spawn });
    expect(spawn).toHaveBeenCalledWith(
      'zsh',
      [
        '-li',
        '-c',
        "exec claude -p --dangerously-skip-permissions --output-format stream-json --input-format stream-json --include-partial-messages --verbose",
      ],
      expect.objectContaining({ cwd: '/Users/test/proj', stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  it('emits parsed events for each NDJSON line on stdout', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });
    const events: unknown[] = [];
    proc.on('event', (e) => events.push(e));

    fakes.pushStdout('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}\n');
    fakes.pushStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}\n');
    await new Promise((r) => setImmediate(r));

    expect(events).toEqual([
      { kind: 'stream_delta', delta: 'hi' },
      { kind: 'assistant_text', text: 'hello' },
    ]);
  });

  it('handles partial NDJSON lines split across chunks', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });
    const events: unknown[] = [];
    proc.on('event', (e) => events.push(e));

    const json = '{"type":"assistant","message":{"content":[{"type":"text","text":"split"}]}}\n';
    fakes.pushStdout(json.slice(0, 20));
    fakes.pushStdout(json.slice(20));
    await new Promise((r) => setImmediate(r));

    expect(events).toEqual([{ kind: 'assistant_text', text: 'split' }]);
  });

  it('keeps a rolling 4KB stderr tail', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });

    fakes.pushStderr('A'.repeat(5000));
    await new Promise((r) => setImmediate(r));

    expect(proc.stderrTail().length).toBe(4096);
    expect(proc.stderrTail().endsWith('A'.repeat(10))).toBe(true);
  });

  it('writes user input as a single NDJSON line to stdin', () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });

    proc.sendUserText('hello');

    expect(fakes.stdinWrites.length).toBe(1);
    const written = JSON.parse(fakes.stdinWrites[0]!.trimEnd());
    expect(written).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
    expect(fakes.stdinWrites[0]!.endsWith('\n')).toBe(true);
  });

  it('emits "exit" with code on process exit', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });
    const exitSpy = vi.fn();
    proc.on('exit', exitSpy);

    fakes.exit(0);
    await new Promise((r) => setImmediate(r));

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('translates a child ENOENT error into exit(null, "agent_not_installed")', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });
    const exitSpy = vi.fn();
    proc.on('exit', exitSpy);

    fakes.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await new Promise((r) => setImmediate(r));

    expect(exitSpy).toHaveBeenCalledWith(null, 'agent_not_installed');
  });

  it('translates other child errors into exit(null, "spawn_failed")', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });
    const exitSpy = vi.fn();
    proc.on('exit', exitSpy);

    fakes.child.emit('error', Object.assign(new Error('boom'), { code: 'EACCES' }));
    await new Promise((r) => setImmediate(r));

    expect(exitSpy).toHaveBeenCalledWith(null, 'spawn_failed');
  });

  it('embeds image content blocks alongside text in the user message', () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });
    proc.sendUserText('look at this', [
      { mime: 'image/png', base64: 'PNGDATA' },
      { mime: 'image/jpeg', base64: 'JPGDATA' },
    ]);
    expect(fakes.stdinWrites.length).toBe(1);
    const written = JSON.parse(fakes.stdinWrites[0]!.trimEnd()) as {
      type: string;
      message: {
        role: string;
        content: Array<
          | { type: 'text'; text: string }
          | { type: 'image'; source: { type: string; media_type: string; data: string } }
        >;
      };
    };
    expect(written.type).toBe('user');
    expect(written.message.content).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PNGDATA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'JPGDATA' } },
    ]);
  });

  it('emits cli_session_id when Claude system init event arrives', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });
    const captured: string[] = [];
    const events: unknown[] = [];
    proc.on('cli_session_id', (id: string) => captured.push(id));
    proc.on('event', (e) => events.push(e));

    fakes.pushStdout(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-uuid-xyz' }) + '\n');
    await new Promise((r) => setImmediate(r));

    expect(captured).toEqual(['claude-uuid-xyz']);
    // session id must NOT pass through to the downstream `event` channel.
    expect(events).toEqual([]);
  });

  it('emits cli_session_id only ONCE per Claude driver lifetime', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });
    const captured: string[] = [];
    proc.on('cli_session_id', (id: string) => captured.push(id));

    fakes.pushStdout(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'a' }) + '\n');
    fakes.pushStdout(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'b' }) + '\n');
    await new Promise((r) => setImmediate(r));

    expect(captured).toEqual(['a']);
  });

  it('kill() sends SIGTERM then SIGKILL after grace', async () => {
    vi.useFakeTimers();
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new ClaudeProcess('/p', { spawn });

    proc.kill();
    expect(fakes.child.kill).toHaveBeenCalledWith('SIGTERM');

    vi.advanceTimersByTime(5000);
    expect(fakes.child.kill).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
  });
});
