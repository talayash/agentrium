import { create } from 'zustand';
import type { InsightRecord } from '../lib/insightModel';

export const MAX_RECORDS = 5000;
export const MAX_PROMPT_HISTORY = 50;

export interface InsightTerminalState {
  records: InsightRecord[];
  supported: boolean | null;
  heightPx: number | null;
  collapsed: boolean | null;
  expandedTurn: number | null;
  prompts?: string[];
  /** Insight mode: the terminal drawer is open (input goes to the PTY). */
  drawerOpen?: boolean;
}

const empty = (): InsightTerminalState =>
  ({ records: [], supported: null, heightPx: null, collapsed: null, expandedTurn: null });

interface InsightStore {
  byId: Map<string, InsightTerminalState>;
  append: (id: string, records: InsightRecord[], reset: boolean) => void;
  setSupported: (id: string, v: boolean) => void;
  setHeight: (id: string, px: number) => void;
  setCollapsed: (id: string, v: boolean) => void;
  setExpandedTurn: (id: string, idx: number | null) => void;
  pushPromptHistory: (id: string, text: string) => void;
  promptHistory: (id: string) => string[];
  setDrawerOpen: (id: string, open: boolean) => void;
  clear: (id: string) => void;
}

// Per-terminal insight records and layer UI state. Not persisted: records are
// re-read from the transcript whenever the layer is turned on.
export const useInsightStore = create<InsightStore>((set, get) => {
  const patch = (id: string, fn: (cur: InsightTerminalState) => Partial<InsightTerminalState>) =>
    set(s => {
      const byId = new Map(s.byId);
      const cur = byId.get(id) ?? empty();
      byId.set(id, { ...cur, ...fn(cur) });
      return { byId };
    });
  return {
    byId: new Map(),
    append: (id, records, reset) => patch(id, cur => ({
      records: reset ? records.slice(-MAX_RECORDS) : [...cur.records, ...records].slice(-MAX_RECORDS),
    })),
    setSupported: (id, supported) => patch(id, () => ({ supported })),
    setHeight: (id, heightPx) => patch(id, () => ({ heightPx })),
    setCollapsed: (id, collapsed) => patch(id, () => ({ collapsed })),
    setExpandedTurn: (id, expandedTurn) => patch(id, () => ({ expandedTurn })),
    pushPromptHistory: (id, text) => patch(id, cur => {
      if (text.trim() === '' || cur.prompts?.[cur.prompts.length - 1] === text) return {};
      return { prompts: [...(cur.prompts ?? []), text].slice(-MAX_PROMPT_HISTORY) };
    }),
    promptHistory: (id) => get().byId.get(id)?.prompts ?? [],
    setDrawerOpen: (id, open) => {
      // Closing never creates an entry, so it cannot resurrect a cleared terminal.
      if ((get().byId.get(id)?.drawerOpen ?? false) === open) return;
      patch(id, () => ({ drawerOpen: open }));
    },
    clear: (id) => set(s => {
      if (!s.byId.has(id)) return {};
      const byId = new Map(s.byId);
      byId.delete(id);
      return { byId };
    }),
  };
});
