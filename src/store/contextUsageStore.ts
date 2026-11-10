import { create } from 'zustand';
import { CLAUDE_WINDOW, type ContextUsage } from '../lib/contextMeter';

/** Latest context-window fill per terminal, filled by `useContextUsagePoller`.
 *  Not persisted: it is re-read from the transcripts on start. */
interface ContextUsageState {
  byId: Map<string, ContextUsage>;
  /** Terminals that have reported over 200k tokens without a stated window:
   *  only a 1M window allows that, so the meter keeps 1M after a /compact
   *  instead of jumping back. Ids are never reused, so entries are only
   *  dropped by `clear`. */
  seenOver200k: Set<string>;
  replace: (next: Record<string, ContextUsage>) => void;
  clear: () => void;
}

const same = (a: ContextUsage | undefined, b: ContextUsage) =>
  !!a &&
  a.used_tokens === b.used_tokens &&
  a.window_tokens === b.window_tokens &&
  a.model === b.model &&
  a.configured_model === b.configured_model;

export const useContextUsageStore = create<ContextUsageState>((set, get) => ({
  byId: new Map(),
  seenOver200k: new Set(),
  replace: (next) => {
    const prev = get().byId;
    const entries = Object.entries(next);
    const newlyOver = entries
      .filter(([id, u]) => !u.window_tokens && u.used_tokens > CLAUDE_WINDOW && !get().seenOver200k.has(id))
      .map(([id]) => id);
    if (newlyOver.length) set({ seenOver200k: new Set([...get().seenOver200k, ...newlyOver]) });
    // Skip the set (and every subscriber's re-render) when nothing changed,
    // which is the common case between agent turns.
    if (entries.length === prev.size && entries.every(([id, u]) => same(prev.get(id), u))) return;
    set({ byId: new Map(entries) });
  },
  clear: () => set({ byId: new Map(), seenOver200k: new Set() }),
}));
