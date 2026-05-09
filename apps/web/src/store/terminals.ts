import { create } from 'zustand';
import type { ServerMsg } from '../types/protocol';

export interface TerminalView {
  termId: string;
  cwd: string;
  createdAt: number;
  alive: boolean;
  exitCode?: number | null;
  signal?: string | null;
}

interface TerminalsStore {
  terminals: Record<string, TerminalView>;
  order: string[];
  applyServerMsg(m: ServerMsg): void;
  remove(termId: string): void;
}

export const useTerminalsStore = create<TerminalsStore>((set, get) => ({
  terminals: {},
  order: [],

  applyServerMsg(m) {
    if (m.type === 'term_started') {
      set((s) => ({
        terminals: {
          ...s.terminals,
          [m.termId]: { termId: m.termId, cwd: m.cwd, createdAt: m.createdAt, alive: true },
        },
        order: s.order.includes(m.termId) ? s.order : [...s.order, m.termId],
      }));
      return;
    }
    if (m.type === 'term_exit') {
      const existing = get().terminals[m.termId];
      if (!existing) return;
      set((s) => ({
        terminals: {
          ...s.terminals,
          [m.termId]: { ...existing, alive: false, exitCode: m.exitCode, signal: m.signal },
        },
      }));
      return;
    }
  },

  remove(termId) {
    set((s) => {
      if (!s.terminals[termId]) return s;
      const { [termId]: _drop, ...rest } = s.terminals;
      void _drop;
      return { terminals: rest, order: s.order.filter((id) => id !== termId) };
    });
  },
}));
