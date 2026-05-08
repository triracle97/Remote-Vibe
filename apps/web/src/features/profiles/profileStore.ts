import { create } from 'zustand';
import type { Profile, ServerMsg } from '../../types/protocol';
import { getBridgeClient } from '../../services/bridge-client-singleton';

// correlationId → resolver/rejecter for in-flight save / delete / setDefault.
// Lives at module scope (not store state) because Zustand state must remain
// JSON-serializable for replay/devtools — promise resolvers are not.
const pending = new Map<
  string,
  { resolve: () => void; reject: (e: { code: string; message: string }) => void }
>();

function newCorrelationId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ProfileState {
  profiles: Profile[];
  loading: boolean;
  fetch: () => void;
  save: (p: Profile) => Promise<void>;
  delete: (name: string, agent: 'claude' | 'codex') => Promise<void>;
  setDefault: (name: string, agent: 'claude' | 'codex') => Promise<void>;
  applyServerMsg: (m: ServerMsg) => void;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profiles: [],
  loading: false,

  fetch() {
    set({ loading: true });
    getBridgeClient().send({
      type: 'list_profiles',
      correlationId: newCorrelationId('pf-list'),
    });
  },

  save(p) {
    return new Promise((resolve, reject) => {
      const correlationId = newCorrelationId('pf-save');
      pending.set(correlationId, { resolve, reject });
      getBridgeClient().send({ type: 'save_profile', profile: p, correlationId });
    });
  },

  delete(name, agent) {
    return new Promise((resolve, reject) => {
      const correlationId = newCorrelationId('pf-del');
      pending.set(correlationId, { resolve, reject });
      getBridgeClient().send({ type: 'delete_profile', name, agent, correlationId });
    });
  },

  setDefault(name, agent) {
    return new Promise((resolve, reject) => {
      const correlationId = newCorrelationId('pf-def');
      pending.set(correlationId, { resolve, reject });
      getBridgeClient().send({ type: 'set_default_profile', name, agent, correlationId });
    });
  },

  applyServerMsg(m: ServerMsg) {
    if (m.type === 'profile_list') {
      set({ profiles: m.profiles, loading: false });
      return;
    }
    if (m.type === 'profile_saved') {
      const updated = get().profiles.filter(
        (p) => !(p.agent === m.profile.agent && p.name === m.profile.name),
      );
      updated.push(m.profile);
      set({ profiles: updated });
      pending.get(m.correlationId)?.resolve();
      pending.delete(m.correlationId);
      return;
    }
    if (m.type === 'profile_deleted') {
      set({
        profiles: get().profiles.filter((p) => !(p.agent === m.agent && p.name === m.name)),
      });
      pending.get(m.correlationId)?.resolve();
      pending.delete(m.correlationId);
      return;
    }
    if (m.type === 'profile_default_set') {
      set({
        profiles: get().profiles.map((p) =>
          p.agent === m.agent ? { ...p, default: p.name === m.name } : p,
        ),
      });
      pending.get(m.correlationId)?.resolve();
      pending.delete(m.correlationId);
      return;
    }
    if (m.type === 'error' && m.correlationId && pending.has(m.correlationId)) {
      const p = pending.get(m.correlationId)!;
      pending.delete(m.correlationId);
      p.reject({ code: m.code, message: m.message });
      return;
    }
  },
}));
