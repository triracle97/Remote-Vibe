import { create } from 'zustand';

export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'error';

interface ConnectionStore {
  status: ConnectionStatus;
  lastError: string | null;
  capabilities: { terminal: boolean };
  /** Roots the bridge will spawn inside, from `BRIDGE_ALLOWED_DIRS`. */
  allowedDirs: string[];
  setStatus(s: ConnectionStatus): void;
  setError(e: string | null): void;
  setCapabilities(caps: { terminal: boolean }): void;
  setAllowedDirs(dirs: string[]): void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  status: 'connecting',
  lastError: null,
  capabilities: { terminal: false },
  allowedDirs: [],
  setStatus: (status) => set({ status }),
  setError: (lastError) => set({ lastError }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setAllowedDirs: (allowedDirs) => set({ allowedDirs }),
}));
