import { create } from 'zustand';

export type SyncStatus = 'idle' | 'syncing' | 'paused' | 'offline' | 'error';

export interface SyncState {
  status: SyncStatus;
  enabled: boolean;
  queueDepth: number;
  lastPulledAt: string | null;
  lastError: string | null;
  setStatus: (
    patch: Partial<Omit<SyncState, 'setStatus' | 'setEnabled'>>,
  ) => void;
  setEnabled: (enabled: boolean) => void;
}

/**
 * Sync engine state, updated by the `sync-status-changed` Tauri event.
 * Not persisted — engine emits an event on every startup so the store
 * hydrates itself within the first second of app boot.
 */
export const useSyncStore = create<SyncState>((set) => ({
  status: 'idle',
  enabled: true,
  queueDepth: 0,
  lastPulledAt: null,
  lastError: null,
  setStatus: (patch) => set((s) => ({ ...s, ...patch })),
  setEnabled: (enabled) => set({ enabled }),
}));
