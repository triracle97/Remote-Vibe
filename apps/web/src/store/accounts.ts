import { create } from 'zustand';
import type { AgentKind } from '../types/protocol';

export interface AccountSummary {
  name: string;
  agent: 'codex';
  isDefault: boolean;
}

/** A named CLAUDE_CONFIG_DIR. The directory itself never crosses the wire. */
export interface ClaudeConfigSummary {
  name: string;
  agent: 'claude';
  isDefault: boolean;
}

/** Wire shape: the bridge sends both kinds on one `account_list`. */
export interface AccountListEntry {
  name: string;
  agent: AgentKind;
  isDefault: boolean;
}

interface AccountsStore {
  /** Codex accounts (CODEX_HOME). */
  accounts: AccountSummary[];
  selectedAccount: string | null;
  /** Claude profiles (CLAUDE_CONFIG_DIR), e.g. `default` and `claude1`. */
  claudeConfigs: ClaudeConfigSummary[];
  selectedClaudeConfig: string | null;
  applyAccountList(entries: AccountListEntry[]): void;
  setSelectedAccount(name: string): void;
  setSelectedClaudeConfig(name: string): void;
}

/** Keep the current pick if it still exists, else fall back to the default. */
function reselect<T extends { name: string; isDefault: boolean }>(
  list: T[],
  current: string | null,
): string | null {
  if (current !== null && list.some((a) => a.name === current)) return current;
  return list.find((a) => a.isDefault)?.name ?? list[0]?.name ?? null;
}

export const useAccountsStore = create<AccountsStore>((set, get) => ({
  accounts: [],
  selectedAccount: null,
  claudeConfigs: [],
  selectedClaudeConfig: null,
  applyAccountList(entries) {
    const accounts = entries.filter((a): a is AccountSummary => a.agent === 'codex');
    const claudeConfigs = entries.filter(
      (a): a is ClaudeConfigSummary => a.agent === 'claude',
    );
    set({
      accounts,
      selectedAccount: reselect(accounts, get().selectedAccount),
      claudeConfigs,
      selectedClaudeConfig: reselect(claudeConfigs, get().selectedClaudeConfig),
    });
  },
  setSelectedAccount(name) {
    if (!get().accounts.some((a) => a.name === name)) return;
    set({ selectedAccount: name });
  },
  setSelectedClaudeConfig(name) {
    if (!get().claudeConfigs.some((a) => a.name === name)) return;
    set({ selectedClaudeConfig: name });
  },
}));
