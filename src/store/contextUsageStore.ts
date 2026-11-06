import { create } from 'zustand';
import type { ContextUsage } from '../lib/contextMeter';

/** Latest context-window fill per terminal, filled by `useContextUsagePoller`.
 *  Not persisted: it is re-read from the transcripts on start. */
interface ContextUsageState {
  byId: Map<string, ContextUsage>;
  replace: (next: Record<string, ContextUsage>) => void;
  clear: () => void;
}

const same = (a: ContextUsage | undefined, b: ContextUsage) =>
  !!a && a.used_tokens === b.used_tokens && a.window_tokens === b.window_tokens && a.model === b.model;

export const useContextUsageStore = create<ContextUsageState>((set, get) => ({
  byId: new Map(),
  replace: (next) => {
    const prev = get().byId;
    const entries = Object.entries(next);
    // Skip the set (and every subscriber's re-render) when nothing changed,
    // which is the common case between agent turns.
    if (entries.length === prev.size && entries.every(([id, u]) => same(prev.get(id), u))) return;
    set({ byId: new Map(entries) });
  },
  clear: () => set({ byId: new Map() }),
}));
