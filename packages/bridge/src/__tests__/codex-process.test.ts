import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { CodexProcess } from '../codex-process.js';

function makeFakeChild() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_chunk, _enc, cb) {
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
    pushStdout: (s: string) => stdout.push(s),
    exit: (code: number) => {
      stdout.push(null);
      stderr.push(null);
      child.emit('exit', code);
    },
  };
}

describe('CodexProcess', () => {
  it('first turn argv excludes resume; subsequent argv uses resume', async () => {
    const fakes1 = makeFakeChild();
    const spawn = vi.fn();
    spawn.mockReturnValueOnce(fakes1.child);
    const proc = new CodexProcess({
      projectPath: '/Users/test/proj',
      codexHome: '/Users/test/.codex-work',
      spawn,
    });

    proc.sendUserText('first');
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd1, args1, opts1] = spawn.mock.calls[0]!;
    expect(cmd1).toBe('codex');
    expect(args1).toEqual([
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '-C',
      '/Users/test/proj',
      'first',
    ]);
    expect(opts1.env.CODEX_HOME).toBe('/Users/test/.codex-work');
    // Critical: stdin must be 'ignore', not 'pipe'. With a piped stdin codex
    // waits for additional input on stdin even though the prompt is in argv,
    // and the child never exits.
    expect(opts1.stdio).toEqual(['ignore', 'pipe', 'pipe']);

    // Simulate session_init then exit
    fakes1.pushStdout('{"type":"session_init","session_id":"sess-1"}\n');
    fakes1.exit(0);
    await new Promise((r) => setImmediate(r));

    // Second turn: should use resume
    const fakes2 = makeFakeChild();
    spawn.mockReturnValueOnce(fakes2.child);
    proc.sendUserText('second');
    const [cmd2, args2] = spawn.mock.calls[1]!;
    expect(cmd2).toBe('codex');
    expect(args2).toEqual([
      'exec',
      'resume',
      'sess-1',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '-C',
      '/Users/test/proj',
      'second',
    ]);
  });

  it('emits parsed events for each JSONL line on stdout', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new CodexProcess({ projectPath: '/p', codexHome: '/c', spawn });
    const events: unknown[] = [];
    proc.on('event', (e) => events.push(e));

    proc.sendUserText('hi');
    fakes.pushStdout('{"type":"session_init","session_id":"sess-x"}\n');
    fakes.pushStdout('{"type":"agent_message","content":"hello"}\n');
    await new Promise((r) => setImmediate(r));

    // session_init is captured internally, not emitted as an event
    expect(events).toEqual([{ kind: 'assistant_text', text: 'hello' }]);
  });

  it('emits a result event with error: "codex_session_id_missing" if session_init never seen', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new CodexProcess({ projectPath: '/p', codexHome: '/c', spawn });
    const events: Array<{ kind: string; error?: string }> = [];
    proc.on('event', (e) => events.push(e));

    proc.sendUserText('hi');
    fakes.pushStdout('{"type":"agent_message","content":"hi back"}\n');
    fakes.exit(0);
    await new Promise((r) => setImmediate(r));

    const result = events.find((e) => e.kind === 'result');
    expect(result?.error).toBe('codex_session_id_missing');
  });

  it('emits a result event with error: <stderr tail> on non-zero exit', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new CodexProcess({ projectPath: '/p', codexHome: '/c', spawn });
    const events: Array<{ kind: string; error?: string }> = [];
    proc.on('event', (e) => events.push(e));

    proc.sendUserText('hi');
    fakes.pushStdout('{"type":"session_init","session_id":"sess-1"}\n');
    fakes.child.stderr.push(Buffer.from('codex: usage error'));
    fakes.exit(2);
    await new Promise((r) => setImmediate(r));

    const result = events.find((e) => e.kind === 'result');
    expect(result?.error).toMatch(/usage error/);
  });

  it('translates ENOENT into exit(null, "agent_not_installed")', async () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new CodexProcess({ projectPath: '/p', codexHome: '/c', spawn });
    const exits: Array<[number | null, string?]> = [];
    proc.on('exit', (code, reason) => exits.push([code, reason]));

    proc.sendUserText('hi');
    fakes.child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await new Promise((r) => setImmediate(r));

    expect(exits).toEqual([[null, 'agent_not_installed']]);
  });

  it('kill() sends SIGTERM and SIGKILL after grace and emits exit when a turn is in flight', async () => {
    vi.useFakeTimers();
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new CodexProcess({ projectPath: '/p', codexHome: '/c', spawn });
    const exits: Array<[number | null, string?]> = [];
    proc.on('exit', (code, reason) => exits.push([code, reason]));

    proc.sendUserText('hi');
    proc.kill();
    expect(fakes.child.kill).toHaveBeenCalledWith('SIGTERM');
    vi.advanceTimersByTime(5000);
    expect(fakes.child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(exits).toEqual([[null, 'stopped']]);
    vi.useRealTimers();
  });

  it('kill() emits a single exit even when no turn is in flight', () => {
    const fakes = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fakes.child);
    const proc = new CodexProcess({ projectPath: '/p', codexHome: '/c', spawn });
    const exits: Array<[number | null, string?]> = [];
    proc.on('exit', (code, reason) => exits.push([code, reason]));

    proc.kill();
    expect(exits).toEqual([[null, 'idle_stop']]);

    // Idempotent — second kill must not double-emit.
    proc.kill();
    expect(exits).toEqual([[null, 'idle_stop']]);
  });
});
