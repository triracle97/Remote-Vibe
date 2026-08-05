import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_DIRECTIVE_PROMPT,
  extractDirectives,
} from '../agent-directives.js';
import { ClaudeProcess, shellQuote } from '../claude-process.js';
import { SessionRegistry } from '../session-registry.js';
import { SessionManager, type AgentDriver } from '../session.js';
import type { ServerMsg } from '../types.js';

describe('extractDirectives', () => {
  it('leaves ordinary text untouched', () => {
    const out = extractDirectives('Just a normal reply.');
    expect(out).toEqual({ text: 'Just a normal reply.', phase: null, tags: null });
  });

  it('reads the investigating phase', () => {
    const out = extractDirectives('Looking into it. <!--mrt:phase=investigating-->');
    expect(out.phase).toBe('investigating');
    expect(out.text).toBe('Looking into it.');
  });

  it('reads a phase directive and strips it', () => {
    const out = extractDirectives('Done planning.\n\n<!--mrt:phase=implementing-->');
    expect(out.phase).toBe('implementing');
    expect(out.text).toBe('Done planning.');
  });

  it('reads tags and strips them', () => {
    const out = extractDirectives('<!--mrt:tags=api, bug , api-->Working on it.');
    // Trimmed, de-duped case-insensitively, spaces dashed.
    expect(out.tags).toEqual(['api', 'bug']);
    expect(out.text).toBe('Working on it.');
  });

  it('reads both in one message', () => {
    const out = extractDirectives('ok <!--mrt:phase=verifying--> <!--mrt:tags=ci-->');
    expect(out.phase).toBe('verifying');
    expect(out.tags).toEqual(['ci']);
    expect(out.text).toBe('ok');
  });

  it('tolerates whitespace and case in the marker', () => {
    expect(extractDirectives('<!--  MRT:Phase = Done  -->').phase).toBe('done');
  });

  it('ignores an unknown phase but still strips the marker', () => {
    const out = extractDirectives('text <!--mrt:phase=shipping-->');
    expect(out.phase).toBeNull();
    expect(out.text).toBe('text');
  });

  it('takes the last value when a directive repeats', () => {
    const out = extractDirectives('<!--mrt:phase=planning--><!--mrt:phase=done-->');
    expect(out.phase).toBe('done');
  });

  it('returns empty text when the message was only a directive', () => {
    expect(extractDirectives('<!--mrt:phase=done-->').text).toBe('');
  });

  it('collapses the blank line a stripped marker leaves behind', () => {
    const out = extractDirectives('before\n\n<!--mrt:phase=done-->\n\nafter');
    expect(out.text).toBe('before\n\nafter');
  });

  it('drops tags that are empty, over-long or contain control characters', () => {
    const out = extractDirectives(`<!--mrt:tags=ok,,${'x'.repeat(41)},ab-->`);
    expect(out.tags).toEqual(['ok']);
  });

  it('caps the tag list', () => {
    const many = Array.from({ length: 30 }, (_, i) => `t${i}`).join(',');
    expect(extractDirectives(`<!--mrt:tags=${many}-->`).tags).toHaveLength(20);
  });

  it('treats an empty tag list as "clear the tags"', () => {
    expect(extractDirectives('<!--mrt:tags=-->').tags).toEqual([]);
  });

  it('does not fire on prose that merely mentions the marker name', () => {
    const out = extractDirectives('You can use mrt:phase=done to move the card.');
    expect(out.phase).toBeNull();
    expect(out.text).toContain('mrt:phase=done');
  });
});

describe('shellQuote', () => {
  it('wraps in single quotes', () => {
    expect(shellQuote('hello world')).toBe(`'hello world'`);
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
  });

  it('leaves shell metacharacters inert', () => {
    const quoted = shellQuote('a|b >c <d $(e) `f`');
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
  });
});

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    kill: (s: NodeJS.Signals) => boolean;
    pid: number;
  };
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  child.kill = vi.fn().mockReturnValue(true);
  child.pid = 999;
  return child;
}

describe('ClaudeProcess --append-system-prompt', () => {
  it('passes the directive prompt through, safely quoted', () => {
    const spawn = vi.fn().mockReturnValue(makeFakeChild());
    new ClaudeProcess('/proj', { spawn, appendSystemPrompt: AGENT_DIRECTIVE_PROMPT });
    const cmd = (spawn.mock.calls[0]![1] as string[])[2]!;
    expect(cmd).toContain('--append-system-prompt');
    expect(cmd).toContain('mrt:phase=');
    // Must sit before the claude flags, not after `--`-less trailing args.
    expect(cmd.indexOf('--append-system-prompt')).toBeLessThan(cmd.indexOf('-p '));
  });

  it('omits the flag entirely when no prompt is given', () => {
    const spawn = vi.fn().mockReturnValue(makeFakeChild());
    new ClaudeProcess('/proj', { spawn });
    expect((spawn.mock.calls[0]![1] as string[])[2]).not.toContain('--append-system-prompt');
  });
});

class FakeDriver extends EventEmitter implements AgentDriver {
  sendUserText(): void {}
  kill(): void {
    this.emit('exit', 0);
  }
}

const flush = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('SessionManager applies agent directives', () => {
  let dir: string;
  let registry: SessionRegistry;
  let mgr: SessionManager;
  let driver: FakeDriver;
  let broadcasts: ServerMsg[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mrt-directives-'));
    registry = new SessionRegistry(join(dir, 'sessions.json'));
    await registry.load();
    driver = new FakeDriver();
    mgr = new SessionManager({
      allowedDirs: [dir],
      bufferCap: 100,
      registry,
      realpath: async (p) => p,
      driverFactory: () => driver,
    });
    // Bind the array by value: registry writes are async and can land after
    // the test ends, and a listener closing over the `broadcasts` *variable*
    // would push a stale message into the next test's array.
    const sink: ServerMsg[] = [];
    broadcasts = sink;
    mgr.on('broadcast', (m: ServerMsg) => sink.push(m));
  });
  afterEach(async () => {
    // A write can still be draining; ENOTEMPTY here is noise.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const say = (text: string): void => {
    driver.emit('event', { kind: 'assistant_text', text });
  };

  it('accepts investigating, so research work can leave the build lanes', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    // Ranks below the spawn phase, so only an explicit directive gets it here.
    say('Digging into the logs. <!--mrt:phase=investigating-->');
    await flush();
    expect(registry.get(info.sessionId)!.phase).toBe('investigating');
  });

  it('moves the card when the agent says so', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    expect(registry.get(info.sessionId)!.phase).toBe('planning');
    say('Starting work now. <!--mrt:phase=implementing-->');
    await flush();
    expect(registry.get(info.sessionId)!.phase).toBe('implementing');
  });

  it('never shows the marker to clients', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    say('Starting work now. <!--mrt:phase=implementing-->');
    await flush();
    const texts = broadcasts
      .filter((m) => m.type === 'assistant')
      .map((m) => JSON.stringify((m as { payload: unknown }).payload));
    expect(texts.join(' ')).toContain('Starting work now.');
    expect(texts.join(' ')).not.toContain('mrt:phase');
  });

  it('suppresses a message that was only a directive', async () => {
    await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    const before = broadcasts.filter((m) => m.type === 'assistant').length;
    say('<!--mrt:phase=verifying-->');
    await flush();
    expect(broadcasts.filter((m) => m.type === 'assistant')).toHaveLength(before);
  });

  it('lets the agent move the phase backwards, unlike inference', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    say('<!--mrt:phase=verifying-->');
    await flush();
    say('Found a design problem. <!--mrt:phase=planning-->');
    await flush();
    expect(registry.get(info.sessionId)!.phase).toBe('planning');
  });

  it('respects a human pin', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await mgr.setSessionPhase(info.sessionId, 'backlog');
    say('<!--mrt:phase=done-->');
    await flush();
    expect(registry.get(info.sessionId)!.phase).toBe('backlog');
  });

  it('sets tags from a directive and broadcasts them', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    say('<!--mrt:tags=api,bug-->');
    await flush();
    expect(registry.get(info.sessionId)!.tags).toEqual(['api', 'bug']);
    expect(broadcasts).toContainEqual({
      type: 'session_tags_changed',
      sessionId: info.sessionId,
      tags: ['api', 'bug'],
    });
  });

  it('tags are not blocked by a phase pin', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    await mgr.setSessionPhase(info.sessionId, 'backlog');
    say('<!--mrt:tags=api-->');
    await flush();
    expect(registry.get(info.sessionId)!.tags).toEqual(['api']);
  });

  it('does not write when the directive changes nothing', async () => {
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    say('<!--mrt:phase=planning-->');
    await flush();
    expect(broadcasts.filter((m) => m.type === 'session_phase_changed')).toHaveLength(0);
  });
});
