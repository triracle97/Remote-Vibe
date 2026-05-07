import { create } from 'zustand';
import type { AgentKind } from '../types/protocol';

export interface PromptEntry {
  text: string;
  lastUsedAt: number;
  projectPaths: string[];
  agents: AgentKind[];
}

interface PromptHistoryStore {
  prompts: PromptEntry[];
  query: string;
  showProjectOnly: boolean;
  applyPromptsResult(prompts: PromptEntry[]): void;
  setQuery(q: string): void;
  toggleProjectOnly(): void;
  filtered(currentProjectPath: string | undefined): PromptEntry[];
}

export const usePromptHistoryStore = create<PromptHistoryStore>((set, get) => ({
  prompts: [],
  query: '',
  showProjectOnly: false,
  applyPromptsResult(prompts) {
    set({ prompts });
  },
  setQuery(q) {
    set({ query: q });
  },
  toggleProjectOnly() {
    set((s) => ({ showProjectOnly: !s.showProjectOnly }));
  },
  filtered(currentProjectPath) {
    const { prompts, query, showProjectOnly } = get();
    let out = prompts;
    if (query.length > 0) {
      const lower = query.toLowerCase();
      out = out.filter((p) => p.text.toLowerCase().includes(lower));
    }
    if (showProjectOnly && currentProjectPath) {
      out = out.filter((p) => p.projectPaths.includes(currentProjectPath));
    }
    return out;
  },
}));
