import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TranscriptView } from './TranscriptView';
import { TranscriptSidebar, latestTodos, promptMarkers } from './TranscriptSidebar';
import { findMatches, searchableText } from './TranscriptSearchBar';
import { projectEvents } from './projection';
import type { SessionEvent } from '../../store/sessions';

vi.mock('../markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ source }: { source: string }) => <div>{source}</div>,
}));

// vitest runs with `globals: false`, so RTL's automatic cleanup never
// registers and renders would otherwise pile up in the same document.
afterEach(cleanup);

let seq = 0;
const next = (): number => (seq += 1);

const userMsg = (text: string): SessionEvent =>
  ({ type: 'user', sessionId: 's', seq: next(), payload: { text } }) as SessionEvent;
const asstMsg = (text: string): SessionEvent =>
  ({ type: 'assistant', sessionId: 's', seq: next(), payload: { text } }) as SessionEvent;
const thinkMsg = (text: string): SessionEvent =>
  ({ type: 'assistant', sessionId: 's', seq: next(), payload: { thinking: text } }) as SessionEvent;
const toolMsg = (id: string, name: string, input: unknown): SessionEvent =>
  ({
    type: 'assistant',
    sessionId: 's',
    seq: next(),
    payload: { toolUse: { toolUseId: id, toolName: name, input } },
  }) as SessionEvent;
const resultMsg = (id: string, output: unknown): SessionEvent =>
  ({ type: 'tool_result', sessionId: 's', seq: next(), payload: { toolUseId: id, output } }) as SessionEvent;

describe('TranscriptView', () => {
  it('renders user and assistant prose', () => {
    render(<TranscriptView events={[userMsg('hello'), asstMsg('hi back')]} />);
    expect(screen.getByText('hello')).toBeTruthy();
    expect(screen.getByText('hi back')).toBeTruthy();
  });

  it('renders a tool call as a collapsible card, collapsed by default', () => {
    render(<TranscriptView events={[toolMsg('t1', 'Bash', { command: 'npm test' })]} />);
    const toggle = screen.getByRole('button', { expanded: false });
    expect(toggle.textContent).toContain('Bash');
    expect(toggle.textContent).toContain('npm test');
  });

  it('expands a tool card on click to show its output', () => {
    render(
      <TranscriptView
        events={[toolMsg('t1', 'Bash', { command: 'ls' }), resultMsg('t1', 'a.txt')]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('a.txt')).toBeTruthy();
  });

  it('opens an errored tool card without being asked', () => {
    const errored = {
      type: 'tool_result',
      sessionId: 's',
      seq: next(),
      payload: { toolUseId: 't1', output: 'boom', isError: true },
    } as SessionEvent;
    render(<TranscriptView events={[toolMsg('t1', 'Bash', { command: 'false' }), errored]} />);
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
  });

  it('collapses thinking to a preview and reveals the rest on demand', () => {
    // Longer than the 80-char preview, so "collapsed" is observable.
    const full = `${'reasoning '.repeat(12)}END`;
    render(<TranscriptView events={[thinkMsg(full)]} />);
    expect(screen.queryByText(full)).toBeNull();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText(full)).toBeTruthy();
  });

  it('honours the showToolCalls setting', () => {
    render(
      <TranscriptView
        events={[asstMsg('text'), toolMsg('t1', 'Bash', { command: 'ls' })]}
        settings={{ showToolCalls: false, showThinking: true, expandTools: false }}
      />,
    );
    expect(screen.queryByTestId('tool-call')).toBeNull();
    expect(screen.getByText('text')).toBeTruthy();
  });

  it('honours the showThinking setting', () => {
    render(
      <TranscriptView
        events={[thinkMsg('hidden')]}
        settings={{ showToolCalls: true, showThinking: false, expandTools: false }}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders an Edit as a diff with counts', () => {
    render(
      <TranscriptView
        events={[
          toolMsg('t1', 'Edit', {
            file_path: '/proj/a.ts',
            old_string: 'let a = 1',
            new_string: 'let a = 2',
          }),
        ]}
        projectPath="/proj"
        settings={{ showToolCalls: true, showThinking: true, expandTools: true }}
      />,
    );
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
    expect(screen.getByText('let a = 1')).toBeTruthy();
    expect(screen.getByText('let a = 2')).toBeTruthy();
  });

  it('tags each message with an id so search and outline can jump to it', () => {
    const { container } = render(<TranscriptView events={[userMsg('a'), asstMsg('b')]} />);
    const ids = [...container.querySelectorAll('[data-message-id]')];
    expect(ids).toHaveLength(2);
  });

  it('renders the streaming footer when given one', () => {
    render(<TranscriptView events={[]} footer={<div>streaming…</div>} />);
    expect(screen.getByText('streaming…')).toBeTruthy();
  });

  it('shows turn accounting', () => {
    const e = {
      type: 'result',
      sessionId: 's',
      seq: next(),
      payload: { cost: 0.1234, durationMs: 5000, usage: { inputTokens: 1200, outputTokens: 300 } },
    } as SessionEvent;
    render(<TranscriptView events={[e]} />);
    const text = screen.getByText(/\$0\.1234/).textContent ?? '';
    expect(text).toContain('5s');
    expect(text).toContain('1.2k in');
    expect(text).toContain('300 out');
  });
});

describe('TranscriptSidebar', () => {
  it('lists each user turn as a jump target', () => {
    const messages = projectEvents([userMsg('first ask'), asstMsg('ok'), userMsg('second ask')]);
    const onJump = vi.fn();
    render(<TranscriptSidebar messages={messages} onJump={onJump} />);
    fireEvent.click(screen.getByTitle('second ask'));
    expect(onJump).toHaveBeenCalledWith(messages.find((m) => m.kind === 'text' && m.text === 'second ask')!.id);
  });

  it('shows the latest todo state, not an earlier snapshot', () => {
    const messages = projectEvents([
      toolMsg('t1', 'TodoWrite', { todos: [{ content: 'old', status: 'pending' }] }),
      toolMsg('t2', 'TodoWrite', {
        todos: [
          { content: 'done thing', status: 'completed' },
          { content: 'doing thing', status: 'in_progress' },
        ],
      }),
    ]);
    render(<TranscriptSidebar messages={messages} onJump={vi.fn()} />);
    expect(screen.queryByText('old')).toBeNull();
    expect(screen.getByText('done thing')).toBeTruthy();
    expect(screen.getByText('Todos (1/2)')).toBeTruthy();
  });
});

describe('sidebar selectors', () => {
  it('numbers prompt markers from one', () => {
    const markers = promptMarkers(projectEvents([userMsg('a'), userMsg('b')]));
    expect(markers.map((m) => m.index)).toEqual([1, 2]);
  });

  it('labels an empty prompt rather than rendering a blank row', () => {
    expect(promptMarkers(projectEvents([userMsg('   ')]))[0]!.text).toBe('(empty)');
  });

  it('returns no todos when TodoWrite was never called', () => {
    expect(latestTodos(projectEvents([asstMsg('hi')]))).toEqual([]);
  });

  it('tolerates a malformed TodoWrite payload', () => {
    const messages = projectEvents([toolMsg('t1', 'TodoWrite', { todos: [{ nope: 1 }, 'bad'] })]);
    expect(latestTodos(messages)).toEqual([]);
  });
});

describe('transcript search', () => {
  it('searches prose, thinking, tool names, args and output', () => {
    const messages = projectEvents([
      asstMsg('the quick brown fox'),
      thinkMsg('pondering deeply'),
      toolMsg('t1', 'Bash', { command: 'npm run build' }),
      resultMsg('t1', 'build succeeded'),
    ]);
    expect(findMatches(messages, 'brown')).toHaveLength(1);
    expect(findMatches(messages, 'pondering')).toHaveLength(1);
    expect(findMatches(messages, 'npm run')).toHaveLength(1);
    expect(findMatches(messages, 'succeeded')).toHaveLength(1);
  });

  it('is case-insensitive and ignores an empty query', () => {
    const messages = projectEvents([asstMsg('Hello World')]);
    expect(findMatches(messages, 'hello world')).toHaveLength(1);
    expect(findMatches(messages, '   ')).toHaveLength(0);
  });

  it('includes tool output in the searchable text', () => {
    const messages = projectEvents([toolMsg('t1', 'Read', { file_path: '/a.ts' }), resultMsg('t1', 'file body')]);
    expect(searchableText(messages[0]!)).toContain('file body');
  });
});
