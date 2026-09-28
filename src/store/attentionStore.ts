import { create } from 'zustand';

export type AttentionKind = 'input' | 'review' | 'error' | 'stopped';
export interface AttentionItem {
  terminalId: string;
  targetId: string;
  kind: AttentionKind;
  title: string;
  detail: string;
  createdAt: number;
}

interface AttentionStore {
  items: AttentionItem[];
  put: (item: Omit<AttentionItem, 'createdAt'>) => void;
  dismiss: (terminalId: string) => void;
  retain: (ids: Set<string>) => void;
}

// One actionable item per terminal. Dismissal lasts until a new state
// transition, so a poll of the same waiting prompt cannot recreate an item.
export const useAttentionStore = create<AttentionStore>((set) => ({
  items: [],
  put: (item) => set(s => ({ items: [
    { ...item, createdAt: Date.now() },
    ...s.items.filter(old => old.terminalId !== item.terminalId),
  ].slice(0, 200) })),
  dismiss: (id) => set(s => s.items.some(item => item.terminalId === id)
    ? { items: s.items.filter(item => item.terminalId !== id) } : {}),
  retain: (ids) => set(s => s.items.some(item => !ids.has(item.terminalId) || !ids.has(item.targetId))
    ? { items: s.items.filter(item => ids.has(item.terminalId) && ids.has(item.targetId)) } : {}),
}));
