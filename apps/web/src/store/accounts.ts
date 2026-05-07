import { create } from 'zustand';

export interface AccountSummary {
  name: string;
  agent: 'codex';
  isDefault: boolean;
}

interface AccountsStore {
  accounts: AccountSummary[];
  selectedAccount: string | null;
  applyAccountList(accounts: AccountSummary[]): void;
  setSelectedAccount(name: string): void;
}

export const useAccountsStore = create<AccountsStore>((set, get) => ({
  accounts: [],
  selectedAccount: null,
  applyAccountList(accounts) {
    const current = get().selectedAccount;
    const stillValid = current && accounts.some((a) => a.name === current);
    let nextSelected: string | null = stillValid ? current : null;
    if (!nextSelected) {
      const def = accounts.find((a) => a.isDefault);
      nextSelected = def?.name ?? accounts[0]?.name ?? null;
    }
    set({ accounts, selectedAccount: nextSelected });
  },
  setSelectedAccount(name) {
    if (!get().accounts.some((a) => a.name === name)) return;
    set({ selectedAccount: name });
  },
}));
