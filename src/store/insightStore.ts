import { create } from 'zustand';
import type { InsightRecord } from '../lib/insightModel';

export const MAX_RECORDS = 5000;

export interface InsightTerminalState {
  records: InsightRecord[];
  supported: boolean | null;
  heightPx: number | null;
  collapsed: boolean | null;
  expandedTurn: number | null;
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
  clear: (id: string) => void;
}

// Per-terminal insight records and layer UI state. Not persisted: records are
// re-read from the transcript whenever the layer is turned on.
export const useInsightStore = create<InsightStore>((set) => {
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
    clear: (id) => set(s => {
      if (!s.byId.has(id)) return {};
      const byId = new Map(s.byId);
      byId.delete(id);
      return { byId };
    }),
  };
});
