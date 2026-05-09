import { create } from 'zustand';

export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'error';

interface ConnectionStore {
  status: ConnectionStatus;
  lastError: string | null;
  capabilities: { terminal: boolean };
  setStatus(s: ConnectionStatus): void;
  setError(e: string | null): void;
  setCapabilities(caps: { terminal: boolean }): void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  status: 'connecting',
  lastError: null,
  capabilities: { terminal: false },
  setStatus: (status) => set({ status }),
  setError: (lastError) => set({ lastError }),
  setCapabilities: (capabilities) => set({ capabilities }),
}));
