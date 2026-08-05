import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ModelEffortPicker } from './ModelEffortPicker';
import { SessionModelSwitch } from './SessionModelSwitch';
import { useBoardStore } from '../board/boardStore';
import type { BoardSession, ClientMsg } from '../../types/protocol';

// vitest runs with `globals: false`, so RTL auto-cleanup never registers.
afterEach(cleanup);

const sent: ClientMsg[] = [];
vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: () => ({ send: (m: ClientMsg) => sent.push(m) }),
}));

beforeEach(() => {
  sent.length = 0;
  useBoardStore.setState({ cards: {} });
});

describe('ModelEffortPicker', () => {
  const render_ = (over: Partial<Parameters<typeof ModelEffortPicker>[0]> = {}) => {
    const onModelChange = vi.fn();
    const onEffortChange = vi.fn();
    render(
      <ModelEffortPicker
        agent="claude"
        model={null}
        effort={null}
        onModelChange={onModelChange}
        onEffortChange={onEffortChange}
        {...over}
      />,
    );
    return { onModelChange, onEffortChange };
  };

  it('offers the Claude aliases', () => {
    render_();
    const select = screen.getByLabelText('Model') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'opus', 'sonnet', 'haiku', 'fable']);
  });

  it('offers Codex models instead when the agent is codex', () => {
    render_({ agent: 'codex' });
    const select = screen.getByLabelText('Model') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'gpt-5-codex', 'gpt-5']);
  });

  it('offers exactly the effort levels the CLI documents', () => {
    render_();
    const select = screen.getByLabelText('Effort') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      '',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('defaults to the blank option, which means "let the CLI decide"', () => {
    render_();
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('');
  });

  it('reports a pick', () => {
    const { onModelChange, onEffortChange } = render_();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'opus' } });
    fireEvent.change(screen.getByLabelText('Effort'), { target: { value: 'xhigh' } });
    expect(onModelChange).toHaveBeenCalledWith('opus');
    expect(onEffortChange).toHaveBeenCalledWith('xhigh');
  });

  it('reports null when cleared back to the default', () => {
    // Empty string must not reach the bridge as a model id.
    const { onModelChange } = render_({ model: 'opus' });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '' } });
    expect(onModelChange).toHaveBeenCalledWith(null);
  });

  it('can be disabled', () => {
    render_({ disabled: true });
    expect((screen.getByLabelText('Model') as HTMLSelectElement).disabled).toBe(true);
  });
});

function card(over: Partial<BoardSession> = {}): BoardSession {
  return {
    sessionId: 's1',
    agent: 'claude',
    projectPath: '/p',
    additionalDirs: [],
    createdAt: 1,
    lastActiveAt: 1,
    endedAt: null,
    name: null,
    namePinned: false,
    status: 'live',
    alive: true,
    phase: 'planning',
    phasePinned: false,
    tags: [],
    archived: false,
    account: null,
    claudeConfigDir: null,
    headroom: false,
    resumable: false,
    model: null,
    effort: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      turns: 0,
    },
    ...over,
  };
}

describe('SessionModelSwitch', () => {
  it('shows what the session is currently running', () => {
    useBoardStore.setState({ cards: { s1: card({ model: 'sonnet', effort: 'max' }) } });
    render(<SessionModelSwitch sessionId="s1" agent="claude" />);
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('sonnet');
    expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('max');
  });

  it('sends only the field that changed', () => {
    useBoardStore.setState({ cards: { s1: card({ model: 'opus', effort: 'high' }) } });
    render(<SessionModelSwitch sessionId="s1" agent="claude" />);
    fireEvent.change(screen.getByLabelText('Effort'), { target: { value: 'low' } });
    expect(sent).toEqual([{ type: 'set_session_model', sessionId: 's1', effort: 'low' }]);
  });

  it('sends null to clear back to the CLI default', () => {
    useBoardStore.setState({ cards: { s1: card({ model: 'opus' }) } });
    render(<SessionModelSwitch sessionId="s1" agent="claude" />);
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '' } });
    expect(sent).toEqual([{ type: 'set_session_model', sessionId: 's1', model: null }]);
  });

  it('follows a change that came from somewhere else', () => {
    useBoardStore.setState({ cards: { s1: card({ model: 'opus' }) } });
    render(<SessionModelSwitch sessionId="s1" agent="claude" />);
    act(() => {
      useBoardStore.getState().applyServerMsg({
        type: 'session_model_changed',
        sessionId: 's1',
        model: 'haiku',
        effort: 'low',
      });
    });
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('haiku');
    expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('low');
  });

  it('renders before the card is known, rather than crashing', () => {
    expect(() => render(<SessionModelSwitch sessionId="unknown" agent="codex" />)).not.toThrow();
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('');
  });
});
