import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import type { JSX } from 'react';
import { ToolCallCard } from './ToolCallCard';
import type { ToolCallMessage } from './projection';

function agent(over: Partial<ToolCallMessage>): ToolCallMessage {
  return {
    kind: 'tool_call',
    id: 'a1',
    toolUseId: 'a1',
    toolName: 'Agent',
    input: { description: 'review' },
    status: 'ok',
    subagent: [{ kind: 'text', id: 's1', role: 'assistant', text: 'reading the diff' }],
    ...over,
  } as ToolCallMessage;
}

const renderSubagent = (): JSX.Element => <div data-testid="subagent-body">body</div>;

function panelToggle(): HTMLElement {
  return screen.getByTestId('subagent-panel').querySelector('button') as HTMLElement;
}

describe('ToolCallCard subagent panel', () => {
  afterEach(cleanup);

  it('opens for an async agent still working under a returned call', () => {
    // The call reads `ok` from the moment the agent is launched. The panel
    // follows the agent, not the call.
    render(<ToolCallCard message={agent({ status: 'ok', subagentRunning: true })} renderSubagent={renderSubagent} />);
    expect(panelToggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('subagent-body')).toBeTruthy();
  });

  it('starts collapsed once the agent is done', () => {
    render(<ToolCallCard message={agent({ status: 'ok', subagentRunning: false })} renderSubagent={renderSubagent} />);
    expect(panelToggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('subagent-body')).toBeNull();
  });

  it('reopens when a quiet agent speaks again', () => {
    const { rerender } = render(
      <ToolCallCard message={agent({ subagentRunning: false })} renderSubagent={renderSubagent} />,
    );
    expect(panelToggle().getAttribute('aria-expanded')).toBe('false');
    rerender(<ToolCallCard message={agent({ subagentRunning: true })} renderSubagent={renderSubagent} />);
    expect(panelToggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('respects a collapse made by hand while the agent is still working', () => {
    const { rerender } = render(
      <ToolCallCard message={agent({ subagentRunning: true })} renderSubagent={renderSubagent} />,
    );
    fireEvent.click(panelToggle());
    expect(panelToggle().getAttribute('aria-expanded')).toBe('false');
    // More output arrives; still running. Nothing flipped, so nothing reopens.
    rerender(<ToolCallCard message={agent({ subagentRunning: true, id: 'a1' })} renderSubagent={renderSubagent} />);
    expect(panelToggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('falls back to the call status when no agent flag is present', () => {
    render(<ToolCallCard message={agent({ status: 'running' })} renderSubagent={renderSubagent} />);
    expect(panelToggle().getAttribute('aria-expanded')).toBe('true');
  });
});
