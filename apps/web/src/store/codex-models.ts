import { create } from 'zustand';
import type { CodexCatalogModel } from '../types/protocol';

interface CodexCatalogStore {
  /** Empty until the bridge answers `list_models`. The picker then uses the built-in list. */
  models: CodexCatalogModel[];
  source: 'cli' | 'fallback' | null;
  applyModelList(models: CodexCatalogModel[], source: 'cli' | 'fallback'): void;
}

export const useCodexCatalogStore = create<CodexCatalogStore>((set) => ({
  models: [],
  source: null,
  applyModelList(models, source) {
    set({ models, source });
  },
}));

/** Display name from the live catalog, or null when this id is not in it. */
export function codexCatalogLabel(models: readonly CodexCatalogModel[], value: string): string | null {
  return models.find((m) => m.value === value)?.label ?? null;
}
