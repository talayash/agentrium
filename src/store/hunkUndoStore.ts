import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { HunkAction, UndoResult } from '../types/git';

const UNDO_TIMEOUT_MS = 5000;

let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

interface HunkUndoState {
  stack: HunkAction[];
  push: (a: HunkAction) => void;
  undoAll: () => Promise<UndoResult>;
  clear: () => void;
}

export const useHunkUndoStore = create<HunkUndoState>((set, get) => ({
  stack: [],

  push: (a) => {
    set((s) => ({ stack: [...s.stack, a] }));
    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(() => {
      set({ stack: [] });
      timeoutHandle = null;
    }, UNDO_TIMEOUT_MS);
  },

  undoAll: async () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    const stack = [...get().stack];
    set({ stack: [] });

    let ok = 0;
    let failed = 0;
    // LIFO: last-in undoes first.
    for (let i = stack.length - 1; i >= 0; i--) {
      const a = stack[i];
      // Undo a stage = unstage; undo a discard = restore.
      const undoMode = a.kind === 'stage' ? 'unstage' : 'restore';
      try {
        await invoke('apply_hunk', {
          mode: undoMode,
          repoPath: a.repoPath,
          filePath: a.filePath,
          hunkPatch: a.hunkPatch,
        });
        ok++;
      } catch {
        failed++;
      }
    }
    return { ok, failed };
  },

  clear: () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    set({ stack: [] });
  },
}));
