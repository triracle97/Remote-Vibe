import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { GrokProcess } from '../grok-process.js';

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
  return {
    child,
    pushStdout: (s: string) => stdout.push(s),
    pushStderr: (s: string) => stderr.push(s),
    exit: (code: number) => {
      stdout.push(null);
      stderr.push(null);
      child.emit('exit', code);
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('GrokProcess', () => {
  it('mints a session id on the first turn and resumes it on the second', async () => {
    const first = makeFakeChild();
    const spawn = vi.fn();
    spawn.mockReturnValueOnce(first.child);
    const proc = new GrokProcess({ projectPath: '/Users/test/proj', spawn });
    const ids: string[] = [];
    proc.on('cli_session_id', (id: string) => ids.push(id));

    proc.sendUserText('hello');
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0]!;
    expect(cmd).toBe('grok');
    expect(args[0]).toBe('--session-id');
    expect(args[1]).toMatch(UUID_RE);
    expect(args).toEqual([
      '--session-id',
      args[1],
      '--output-format',
      'streaming-json',
      '--always-approve',
      '--cwd',
      '/Users/test/proj',
      '--verbatim',
      '-p',
      'hello',
    ]);
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(opts.env.GROK_DISABLE_AUTOUPDATER).toBe('1');
    expect(opts.cwd).toBe('/Users/test/proj');
    expect(ids).toEqual([args[1]]);

    first.pushStdout('{"type":"text","data":"hi"}\n');
    first.pushStdout('{"type":"end","sessionId":"' + args[1] + '","stopReason":"end_turn"}\n');
    first.exit(0);
    await new Promise((r) => setImmediate(r));

    const second = makeFakeChild();
    spawn.mockReturnValueOnce(second.child);
    proc.sendUserText('again');
    const args2 = spawn.mock.calls[1]![1] as string[];
    expect(args2.slice(0, 2)).toEqual(['--resume', args[1]]);
    expect(args2.at(-1)).toBe('again');
  });

  it('passes model, effort, and image paths', () => {
    const fake = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fake.child);
    const proc = new GrokProcess({
      projectPath: '/proj',
      model: 'grok-4.6',
      effort: 'high',
      spawn,
    });
    proc.sendUserText('look', undefined, ['/tmp/a.png']);
    const args = spawn.mock.calls[0]![1] as string[];
    expect(args).toContain('--model');
    expect(args).toContain('grok-4.6');
    expect(args).toContain('--effort');
    expect(args).toContain('high');
    const prompt = args.at(-1) as string;
    expect(prompt).toContain('look');
    expect(prompt).toContain('/tmp/a.png');
  });

  it('joins thought chunks and emits text, tools, and one result', async () => {
    const fake = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fake.child);
    const proc = new GrokProcess({ projectPath: '/proj', spawn });
    const events: unknown[] = [];
    proc.on('event', (e) => events.push(e));
    proc.sendUserText('go');
    fake.pushStdout(
      [
        '{"type":"thought","data":"A"}',
        '{"type":"thought","data":"B"}',
        '{"type":"text","data":"done"}',
        '{"type":"tool_call","toolCallId":"c1","toolName":"read_file","rawInput":{"path":"a"}}',
        '{"type":"tool_call_update","toolCallId":"c1","status":"completed","rawOutput":{"ok":true}}',
        '{"type":"end","stopReason":"end_turn","sessionId":"ignored-because-we-minted"}',
        '',
      ].join('\n'),
    );
    fake.exit(0);
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([
      { kind: 'thinking', text: 'AB' },
      { kind: 'stream_delta', delta: 'done' },
      { kind: 'tool_use', toolUseId: 'c1', toolName: 'read_file', input: { path: 'a' } },
      { kind: 'tool_result', toolUseId: 'c1', output: { ok: true } },
      { kind: 'result' },
    ]);
  });

  it('adopts the CLI session id when it differs from the one we minted', async () => {
    const fake = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fake.child);
    const proc = new GrokProcess({ projectPath: '/proj', spawn });
    const ids: string[] = [];
    proc.on('cli_session_id', (id: string) => ids.push(id));
    proc.sendUserText('hi');
    fake.pushStdout('{"type":"end","sessionId":"server-id","stopReason":"end_turn"}\n');
    fake.exit(0);
    await new Promise((r) => setImmediate(r));
    expect(ids).toEqual([expect.stringMatching(UUID_RE), 'server-id']);

    const next = makeFakeChild();
    spawn.mockReturnValueOnce(next.child);
    proc.sendUserText('next');
    const args = spawn.mock.calls[1]![1] as string[];
    expect(args.slice(0, 2)).toEqual(['--resume', 'server-id']);
  });

  it('resumes from a seed without minting', () => {
    const fake = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fake.child);
    const proc = new GrokProcess({
      projectPath: '/proj',
      grokResumeSeed: 'already-there',
      spawn,
    });
    proc.sendUserText('continue');
    const args = spawn.mock.calls[0]![1] as string[];
    expect(args.slice(0, 2)).toEqual(['--resume', 'already-there']);
  });

  it('classifies a failed resume before any output', async () => {
    const fake = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fake.child);
    const proc = new GrokProcess({
      projectPath: '/proj',
      grokResumeSeed: 'missing',
      spawn,
    });
    const events: unknown[] = [];
    proc.on('event', (e) => events.push(e));
    proc.sendUserText('continue');
    fake.pushStderr('session not found\n');
    fake.exit(1);
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([{ kind: 'result', error: 'grok_resume_rejected' }]);
  });

  it('interrupt closes the turn without ending the session', () => {
    const fake = makeFakeChild();
    const spawn = vi.fn().mockReturnValue(fake.child);
    const proc = new GrokProcess({ projectPath: '/proj', spawn });
    const events: unknown[] = [];
    const exits: unknown[] = [];
    proc.on('event', (e) => events.push(e));
    proc.on('exit', (...a) => exits.push(a));
    proc.sendUserText('go');
    proc.interrupt();
    expect(events).toEqual([{ kind: 'result', error: 'interrupted' }]);
    expect(exits).toEqual([]);
  });
});
