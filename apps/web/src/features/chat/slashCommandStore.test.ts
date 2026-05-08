import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSlashCommandStore } from './slashCommandStore';
import type { SlashCommand } from '../../types/protocol';

vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: vi.fn(),
}));

import { getBridgeClient } from '../../services/bridge-client-singleton';

const mkCmd = (over: Partial<SlashCommand> = {}): SlashCommand => ({
  name: '/help',
  description: '',
  source: 'builtin',
  agent: 'both',
  ...over,
});

describe('slashCommandStore', () => {
  beforeEach(() => {
    useSlashCommandStore.setState({ bySession: {} });
    vi.clearAllMocks();
  });

  it('fetch() sends list_slash_commands for the given session', () => {
    const sent: unknown[] = [];
    const send = vi.fn((m: unknown) => sent.push(m));
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });

    useSlashCommandStore.getState().fetch('sess-1');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'list_slash_commands',
        sessionId: 'sess-1',
        correlationId: expect.any(String),
      }),
    );
  });

  it('applyServerMsg slash_commands_list populates bySession[sessionId] using correlationId map', () => {
    const sent: unknown[] = [];
    const send = vi.fn((m: unknown) => sent.push(m));
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });

    useSlashCommandStore.getState().fetch('sess-1');
    const cid = (sent[0] as { correlationId: string }).correlationId;

    const commands = [mkCmd(), mkCmd({ name: '/run' })];
    useSlashCommandStore.getState().applyServerMsg({
      type: 'slash_commands_list',
      commands,
      correlationId: cid,
    });

    const entry = useSlashCommandStore.getState().bySession['sess-1'];
    expect(entry?.commands).toEqual(commands);
    expect(entry?.lastFetched).toBeGreaterThan(0);
  });

  it('60s dedupe: second fetch within window does NOT re-send', () => {
    const send = vi.fn();
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });
    useSlashCommandStore.setState({
      bySession: { 'sess-1': { commands: [mkCmd()], lastFetched: Date.now() } },
    });
    useSlashCommandStore.getState().fetch('sess-1');
    expect(send).not.toHaveBeenCalled();
  });

  it('fetch for a different session re-sends even when other sessions are warm', () => {
    const send = vi.fn();
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });
    useSlashCommandStore.setState({
      bySession: { 'sess-1': { commands: [], lastFetched: Date.now() } },
    });
    useSlashCommandStore.getState().fetch('sess-2');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'list_slash_commands', sessionId: 'sess-2' }),
    );
  });

  it('applyServerMsg with unknown correlationId is a no-op', () => {
    useSlashCommandStore.getState().applyServerMsg({
      type: 'slash_commands_list',
      commands: [mkCmd()],
      correlationId: 'nope',
    });
    expect(useSlashCommandStore.getState().bySession).toEqual({});
  });
});
