import { describe, it, expect, beforeEach } from 'vitest';
import { usePromptHistoryStore } from './prompt-history';

beforeEach(() => {
  usePromptHistoryStore.setState({ prompts: [], query: '', showProjectOnly: false });
});

describe('prompt-history store', () => {
  it('hydrates from prompts_result message', () => {
    usePromptHistoryStore.getState().applyPromptsResult([
      { text: 'hello', lastUsedAt: 100, projectPaths: ['/p1'], agents: ['claude'] },
    ]);
    expect(usePromptHistoryStore.getState().prompts).toHaveLength(1);
  });

  it('filtered() applies query case-insensitively and project filter', () => {
    usePromptHistoryStore.setState({
      prompts: [
        { text: 'Hello', lastUsedAt: 200, projectPaths: ['/p1'], agents: ['claude'] },
        { text: 'goodbye', lastUsedAt: 100, projectPaths: ['/p2'], agents: ['claude'] },
      ],
      query: 'hel',
      showProjectOnly: false,
    });
    expect(usePromptHistoryStore.getState().filtered(undefined).map((p) => p.text)).toEqual(['Hello']);

    usePromptHistoryStore.setState({ query: '', showProjectOnly: true });
    expect(usePromptHistoryStore.getState().filtered('/p1').map((p) => p.text)).toEqual(['Hello']);
  });

  it('setQuery updates the query string', () => {
    usePromptHistoryStore.getState().setQuery('hi');
    expect(usePromptHistoryStore.getState().query).toBe('hi');
  });

  it('toggleProjectOnly flips the boolean', () => {
    usePromptHistoryStore.getState().toggleProjectOnly();
    expect(usePromptHistoryStore.getState().showProjectOnly).toBe(true);
    usePromptHistoryStore.getState().toggleProjectOnly();
    expect(usePromptHistoryStore.getState().showProjectOnly).toBe(false);
  });
});
