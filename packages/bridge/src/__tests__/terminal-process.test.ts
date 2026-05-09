import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { TerminalProcess, type PtyLike } from '../terminal-process.js';

interface FakePty extends PtyLike {
  _data: (s: string) => void;
  _exit: (e: { exitCode: number; signal?: number }) => void;
  writes: string[];
  resized: Array<[number, number]>;
  killed: string[];
  pausedCount: number;
  resumedCount: number;
}

function makeFakePty(): FakePty {
  const ee = new EventEmitter();
  const writes: string[] = [];
  const resized: Array<[number, number]> = [];
  const killed: string[] = [];
  let pausedCount = 0;
  let resumedCount = 0;
  const base = Object.assign(ee, {
    onData: (cb: (s: string) => void) => ee.on('data', cb),
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) =>
      ee.on('exitEvt', cb),
    write: (s: string) => writes.push(s),
    resize: (c: number, r: number) => resized.push([c, r]),
    kill: (sig?: string) => killed.push(sig ?? 'SIGHUP'),
    pause: () => { pausedCount++; },
    resume: () => { resumedCount++; },
    _data: (s: string) => ee.emit('data', s),
    _exit: (e: { exitCode: number; signal?: number }) => ee.emit('exitEvt', e),
    writes, resized, killed,
  });
  // Object.assign doesn't copy getters as live accessors; use defineProperties.
  Object.defineProperties(base, {
    pausedCount: { get() { return pausedCount; }, enumerable: true, configurable: true },
    resumedCount: { get() { return resumedCount; }, enumerable: true, configurable: true },
  });
  return base as unknown as FakePty;
}

describe('TerminalProcess', () => {
  it('passes shell, args, and pty options to spawn', () => {
    const fake = makeFakePty();
    const spawn = vi.fn().mockReturnValue(fake);
    new TerminalProcess('/Users/me/p', 80, 24, { spawn });
    expect(spawn).toHaveBeenCalledWith(
      'zsh',
      ['-l'],
      expect.objectContaining({
        cwd: '/Users/me/p',
        cols: 80,
        rows: 24,
        name: 'xterm-256color',
      }),
    );
  });

  it('emits output events for pty data', () => {
    const fake = makeFakePty();
    const proc = new TerminalProcess('/p', 80, 24, { spawn: () => fake });
    const out: string[] = [];
    proc.on('output', (s: string) => out.push(s));
    fake._data('hello');
    expect(out).toEqual(['hello']);
  });

  it('forwards write to pty', () => {
    const fake = makeFakePty();
    const proc = new TerminalProcess('/p', 80, 24, { spawn: () => fake });
    proc.write('ls\n');
    expect(fake.writes).toEqual(['ls\n']);
  });

  it('forwards resize to pty', () => {
    const fake = makeFakePty();
    const proc = new TerminalProcess('/p', 80, 24, { spawn: () => fake });
    proc.resize(120, 40);
    expect(fake.resized).toEqual([[120, 40]]);
  });

  it('emits exit with exitCode and signal', () => {
    const fake = makeFakePty();
    const proc = new TerminalProcess('/p', 80, 24, { spawn: () => fake });
    const exits: Array<[number | null, string | null]> = [];
    proc.on('exit', (code, sig) => exits.push([code, sig]));
    fake._exit({ exitCode: 0, signal: 1 });
    expect(exits).toEqual([[0, 'SIGHUP']]);
  });

  it('kill() sends SIGHUP, then SIGKILL after the grace timer', () => {
    vi.useFakeTimers();
    const fake = makeFakePty();
    const proc = new TerminalProcess('/p', 80, 24, { spawn: () => fake, killGraceMs: 100 });
    proc.kill();
    expect(fake.killed).toEqual(['SIGHUP']);
    vi.advanceTimersByTime(100);
    expect(fake.killed).toEqual(['SIGHUP', 'SIGKILL']);
    vi.useRealTimers();
  });

  it('kill() is idempotent', () => {
    const fake = makeFakePty();
    const proc = new TerminalProcess('/p', 80, 24, { spawn: () => fake, killGraceMs: 100 });
    proc.kill();
    proc.kill();
    expect(fake.killed).toEqual(['SIGHUP']);
  });

  it('pause/resume forwards to pty', () => {
    const fake = makeFakePty();
    const proc = new TerminalProcess('/p', 80, 24, { spawn: () => fake });
    proc.pause();
    proc.pause();
    proc.resume();
    expect(fake.pausedCount).toBe(2);
    expect(fake.resumedCount).toBe(1);
  });
});
