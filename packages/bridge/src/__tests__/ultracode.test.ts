import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, type DriverFactoryArgs } from '../session.js';
import { SessionRegistry } from '../session-registry.js';
import { ClaudeSettingsWriter, type ClaudeSessionSettings } from '../claude-settings.js';
import { parseClaudeLine } from '../parser.js';
import type { AgentEvent, ServerMsg, ServerStreamMsg } from '../types.js';

class FakeDriver extends EventEmitter {
  sendUserText(): void {}
  kill(): void {}
}

/**
 * Ultracode is the one setting that is two things at once — a flag value and a
 * settings file — so what these check is that both halves always agree, and
 * that a session which cannot have it never claims it does.
 */
describe('ultracode', () => {
  let dir: string;
  let registry: SessionRegistry;
  let drivers: FakeDriver[];
  let spawnArgs: DriverFactoryArgs[];
  let written: Array<{ id: string; settings: ClaudeSessionSettings }>;
  let warn: ReturnType<typeof vi.spyOn>;

  const makeManager = (opts: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) =>
    new SessionManager({
      allowedDirs: [dir],
      bufferCap: 100,
      realpath: async (p) => p,
      registry,
      driverFactory: (args) => {
        spawnArgs.push(args);
        const d = new FakeDriver();
        drivers.push(d);
        return d;
      },
      writeClaudeSettings: async (id, settings) => {
        written.push({ id, settings });
        return join(dir, `${id}.json`);
      },
      ...opts,
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mrt-ultracode-'));
    registry = new SessionRegistry(join(dir, 'sessions.json'));
    await registry.load();
    drivers = [];
    spawnArgs = [];
    written = [];
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    warn.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it('spawns at xhigh with a settings file, and remembers the mode', async () => {
    const mgr = makeManager();
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir], effort: 'ultracode' });

    // The flag says xhigh — `--effort ultracode` is a plain alias for it and
    // would turn none of the mode on.
    expect(spawnArgs[0]!.effort).toBe('xhigh');
    expect(spawnArgs[0]!.settingsPath).toBeTruthy();
    expect(written[0]!.settings).toEqual({ ultracode: true, enableWorkflows: true });
    // The card records what the user picked, not the flag it decayed into.
    expect(registry.get(info.sessionId)!.effort).toBe('ultracode');
  });

  it('writes nothing for a session that asked for nothing', async () => {
    const mgr = makeManager();
    await mgr.spawnSession({ agent: 'claude', dirs: [dir], effort: 'high' });
    expect(written).toHaveLength(0);
    expect(spawnArgs[0]!.settingsPath).toBeUndefined();
  });

  it('carries the workflow settings, turning workflows on to hold them', async () => {
    const mgr = makeManager();
    await mgr.spawnSession({
      agent: 'claude',
      dirs: [dir],
      workflowSize: 'large',
      workflowKeywordTrigger: false,
    });
    // Picking a fleet size for a feature that is off says you want it on.
    expect(written[0]!.settings).toEqual({
      enableWorkflows: true,
      workflowSizeGuideline: 'large',
      workflowKeywordTriggerEnabled: false,
    });
  });

  it('falls back to xhigh on a model that cannot reach it', async () => {
    const mgr = makeManager();
    const info = await mgr.spawnSession({
      agent: 'claude',
      dirs: [dir],
      effort: 'ultracode',
      model: 'haiku',
    });
    expect(spawnArgs[0]!.effort).toBe('xhigh');
    expect(written).toHaveLength(0);
    // And the card says xhigh, because that is what actually happened.
    expect(registry.get(info.sessionId)!.effort).toBe('xhigh');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot run ultracode'));
  });

  it('drops the mode on Codex rather than inventing a level for it', async () => {
    const mgr = makeManager({
      accounts: new Map([['default', { name: 'default', codexHome: dir, isDefault: true }]]),
    });
    const info = await mgr.spawnSession({ agent: 'codex', dirs: [dir], effort: 'ultracode' });
    expect(spawnArgs[0]!.effort).toBeUndefined();
    expect(registry.get(info.sessionId)!.effort).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Claude-only'));
  });

  it('refuses to switch a running session into the mode', async () => {
    // The CLI reads the settings file once, at launch. Recording the mode on a
    // session that never got it would leave the card advertising a lie.
    const mgr = makeManager();
    const info = await mgr.spawnSession({ agent: 'claude', dirs: [dir], effort: 'high' });
    await expect(mgr.setSessionModel(info.sessionId, { effort: 'ultracode' })).rejects.toThrow(
      /not switched into one that is already running/,
    );
    expect(registry.get(info.sessionId)!.effort).toBe('high');
  });

  it('rebuilds the settings file when the session resumes', async () => {
    const mgr = makeManager();
    const info = await mgr.spawnSession({
      agent: 'claude',
      dirs: [dir],
      effort: 'ultracode',
      workflowSize: 'small',
    });
    await mgr.registry!.update(info.sessionId, { claudeSessionId: 'cli-uuid' });
    written.length = 0;
    spawnArgs.length = 0;

    await mgr.resume(info.sessionId);
    expect(written[0]!.settings).toEqual({
      ultracode: true,
      enableWorkflows: true,
      workflowSizeGuideline: 'small',
    });
    expect(spawnArgs[0]!.effort).toBe('xhigh');
    expect(spawnArgs[0]!.settingsPath).toBeTruthy();
  });

  it('applies the bridge default, and lets a session override it', async () => {
    const mgr = makeManager({ defaultWorkflowSize: 'small' });
    await mgr.spawnSession({ agent: 'claude', dirs: [dir], effort: 'ultracode' });
    expect(written[0]!.settings.workflowSizeGuideline).toBe('small');

    await mgr.spawnSession({
      agent: 'claude',
      dirs: [dir],
      effort: 'ultracode',
      workflowSize: 'unrestricted',
    });
    expect(written[1]!.settings.workflowSizeGuideline).toBe('unrestricted');
  });
});

describe('ClaudeSettingsWriter', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mrt-settings-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes owner-only JSON the CLI can read', async () => {
    const path = await new ClaudeSettingsWriter(dir).write('s1', {
      ultracode: true,
      enableWorkflows: true,
    });
    expect(path).toBeTruthy();
    expect(JSON.parse(await readFile(path!, 'utf8'))).toEqual({
      ultracode: true,
      enableWorkflows: true,
    });
  });

  it('writes no file when there is nothing to say', async () => {
    expect(await new ClaudeSettingsWriter(dir).write('s1', {})).toBeNull();
  });
});

describe('subagent forwarding', () => {
  it('marks forwarded text with the call that started it', () => {
    const [e] = parseClaudeLine(
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'toolu_task1',
        message: { content: [{ type: 'text', text: 'reading the file' }] },
      }),
    );
    expect(e).toEqual({
      kind: 'assistant_text',
      text: 'reading the file',
      parentToolUseId: 'toolu_task1',
    });
  });

  it('leaves the main agent unmarked', () => {
    const [e] = parseClaudeLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
    );
    expect(e).toEqual({ kind: 'assistant_text', text: 'hi' });
  });

  it('marks every event a single forwarded line carries', () => {
    const events = parseClaudeLine(
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'toolu_task1',
        message: {
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'tool_use', id: 't9', name: 'Read', input: {} },
          ],
        },
      }),
    );
    expect(events.map((e) => (e as { parentToolUseId?: string }).parentToolUseId)).toEqual([
      'toolu_task1',
      'toolu_task1',
    ]);
  });
});

describe('subagent events on the wire', () => {
  let dir: string;
  let drivers: FakeDriver[];
  let broadcasts: ServerMsg[];
  let mgr: SessionManager;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mrt-subagent-'));
    drivers = [];
    broadcasts = [];
    mgr = new SessionManager({
      allowedDirs: [dir],
      bufferCap: 100,
      realpath: async (p) => p,
      driverFactory: () => {
        const d = new FakeDriver();
        drivers.push(d);
        return d;
      },
    });
    mgr.on('broadcast', (m: ServerMsg) => broadcasts.push(m));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the origin on the message the client sees', async () => {
    await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    drivers[0]!.emit('event', {
      kind: 'assistant_text',
      text: 'from the subagent',
      parentToolUseId: 'toolu_task1',
    } satisfies AgentEvent);

    const msg = broadcasts.find((m) => m.type === 'assistant') as ServerStreamMsg;
    expect(msg.parentToolUseId).toBe('toolu_task1');
  });

  it('survives a directive being stripped out of subagent prose', async () => {
    // The rebuild that drops the marker must not also drop who was speaking.
    await mgr.spawnSession({ agent: 'claude', dirs: [dir] });
    drivers[0]!.emit('event', {
      kind: 'assistant_text',
      text: 'done <!--mrt:phase=verifying-->',
      parentToolUseId: 'toolu_task1',
    } satisfies AgentEvent);

    const msg = broadcasts.find((m) => m.type === 'assistant') as ServerStreamMsg;
    expect(msg.parentToolUseId).toBe('toolu_task1');
    expect(msg.payload).toEqual({ text: 'done' });
  });
});
