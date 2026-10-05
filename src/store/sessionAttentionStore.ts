import { create } from 'zustand';

interface AttentionState {
  pending: Set<string>;
  acknowledged: Set<string>;
  request: (id: string) => void;
  acknowledge: (id: string) => void;
  clear: (id: string) => void;
}

// Transient, per waiting episode; never persist alerts across app restarts.
export const useSessionAttentionStore = create<AttentionState>((set, get) => ({
  pending: new Set(),
  acknowledged: new Set(),
  request: (id) => {
    if (get().pending.has(id) || get().acknowledged.has(id)) return;
    set({ pending: new Set([...get().pending, id]) });
  },
  acknowledge: (id) => {
    if (!get().pending.has(id)) return;
    const pending = new Set(get().pending);
    pending.delete(id);
    set({ pending, acknowledged: new Set([...get().acknowledged, id]) });
  },
  clear: (id) => {
    if (!get().pending.has(id) && !get().acknowledged.has(id)) return;
    const pending = new Set(get().pending);
    const acknowledged = new Set(get().acknowledged);
    pending.delete(id);
    acknowledged.delete(id);
    set({ pending, acknowledged });
  },
}));
