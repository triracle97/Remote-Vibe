import { describe, it, expect, beforeEach } from 'vitest';
import { useAccountsStore } from './accounts';

beforeEach(() => {
  useAccountsStore.setState({ accounts: [], selectedAccount: null });
});

describe('accounts store', () => {
  it('hydrates from account_list message', () => {
    useAccountsStore.getState().applyAccountList([
      { name: 'work', agent: 'codex', isDefault: false },
      { name: 'default', agent: 'codex', isDefault: true },
    ]);
    const state = useAccountsStore.getState();
    expect(state.accounts).toHaveLength(2);
    expect(state.selectedAccount).toBe('default'); // preselects default
  });

  it('falls back to first account when no default flagged', () => {
    useAccountsStore.getState().applyAccountList([
      { name: 'a', agent: 'codex', isDefault: false },
      { name: 'b', agent: 'codex', isDefault: false },
    ]);
    expect(useAccountsStore.getState().selectedAccount).toBe('a');
  });

  it('keeps existing selection if it is still in the new list', () => {
    useAccountsStore.setState({
      accounts: [{ name: 'work', agent: 'codex', isDefault: false }],
      selectedAccount: 'work',
    });
    useAccountsStore.getState().applyAccountList([
      { name: 'work', agent: 'codex', isDefault: false },
      { name: 'home', agent: 'codex', isDefault: true },
    ]);
    expect(useAccountsStore.getState().selectedAccount).toBe('work');
  });

  it('setSelectedAccount accepts a known name', () => {
    useAccountsStore.setState({
      accounts: [{ name: 'a', agent: 'codex', isDefault: true }],
      selectedAccount: 'a',
    });
    useAccountsStore.getState().setSelectedAccount('a');
    expect(useAccountsStore.getState().selectedAccount).toBe('a');
  });
});
