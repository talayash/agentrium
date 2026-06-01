import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export interface PasteEntry {
  file_name: string;
  relative_path: string;
  absolute_path: string;
  size_bytes: number;
  created_at: string;
  detected_kind: 'json' | 'log' | 'xml' | 'text';
}

export interface PasteHistoryEntry extends PasteEntry {
  preview: string;
}

const PREVIEW_CHARS = 200;
const MAX_PER_TERMINAL = 50;

interface PasteState {
  byTerminal: Map<string, PasteHistoryEntry[]>;
  add: (terminalId: string, entry: PasteEntry, content: string) => void;
  remove: (terminalId: string, fileName: string) => void;
  list: (terminalId: string) => PasteHistoryEntry[];
  clearForTerminal: (terminalId: string) => void;
  hydrateFromDisk: (terminalId: string) => Promise<void>;
}

export const usePasteStore = create<PasteState>((set, get) => ({
  byTerminal: new Map(),

  add: (terminalId, entry, content) => set((state) => {
    const next = new Map(state.byTerminal);
    const cur = next.get(terminalId) ?? [];
    const preview = content.slice(0, PREVIEW_CHARS);
    next.set(terminalId, [{ ...entry, preview }, ...cur].slice(0, MAX_PER_TERMINAL));
    return { byTerminal: next };
  }),

  remove: (terminalId, fileName) => set((state) => {
    const next = new Map(state.byTerminal);
    const cur = next.get(terminalId) ?? [];
    next.set(terminalId, cur.filter((e) => e.file_name !== fileName));
    return { byTerminal: next };
  }),

  list: (terminalId) => get().byTerminal.get(terminalId) ?? [],

  clearForTerminal: (terminalId) => set((state) => {
    const next = new Map(state.byTerminal);
    next.delete(terminalId);
    return { byTerminal: next };
  }),

  hydrateFromDisk: async (terminalId) => {
    try {
      const entries = await invoke<PasteEntry[]>('list_pastes', { terminalId });
      set((state) => {
        const next = new Map(state.byTerminal);
        next.set(
          terminalId,
          entries.map((e) => ({ ...e, preview: '' })),
        );
        return { byTerminal: next };
      });
    } catch {
      // non-fatal - paste dir may not exist yet
    }
  },
}));
