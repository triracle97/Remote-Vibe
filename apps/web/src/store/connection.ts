import { create } from 'zustand';

export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'error';

interface ConnectionStore {
  status: ConnectionStatus;
  lastError: string | null;
  setStatus(s: ConnectionStatus): void;
  setError(e: string | null): void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  status: 'connecting',
  lastError: null,
  setStatus: (status) => set({ status }),
  setError: (lastError) => set({ lastError }),
}));
