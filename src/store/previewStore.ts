import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { FrameworkHint } from '../lib/preview/framework';

export type DeviceName = 'desktop' | 'tablet' | 'mobile';
export interface DeviceMode { name: DeviceName; width: number; height?: number }

export const DEVICE_MODES: Record<DeviceName, DeviceMode> = {
  desktop: { name: 'desktop', width: 0 }, // 0 = full width
  tablet:  { name: 'tablet',  width: 768,  height: 1024 },
  mobile:  { name: 'mobile',  width: 375,  height: 812  },
};

export interface PreviewState {
  isOpen: boolean;
  detectedUrl: string | null;
  userOverride: string | null;
  frameworkHint: FrameworkHint;
  deviceMode: DeviceMode;
  history: string[];
  historyIndex: number;
  lastError: string | null;
  reloadCounter: number;
  inlineHintDismissed: boolean;
}

const defaultPreviewState = (): PreviewState => ({
  isOpen: false,
  detectedUrl: null,
  userOverride: null,
  frameworkHint: 'unknown',
  deviceMode: DEVICE_MODES.desktop,
  history: [],
  historyIndex: -1,
  lastError: null,
  reloadCounter: 0,
  inlineHintDismissed: false,
});

interface PreviewStoreState {
  perTerminal: Map<string, PreviewState>;
  globalOpen: boolean;
  allowList: string[];
  keepAliveAcrossTabs: boolean;
  panelWidthPx: number;

  seedTerminal(id: string, initial: Partial<PreviewState>): void;
  setDetectedUrl(id: string, url: string): void;
  setUserOverride(id: string, url: string): void;
  dismissInlineHint(id: string): void;
  markOpen(id: string, open: boolean): void;
  removeTerminal(id: string): void;
  toggleGlobal(): void;
  setDeviceMode(id: string, mode: DeviceMode): void;
  reload(id: string): void;
  addToAllowList(pattern: string): void;
  removeFromAllowList(pattern: string): void;
  setPanelWidth(px: number): void;
  setKeepAliveAcrossTabs(v: boolean): void;
  resolveUrl(id: string): string | null;
}

function withMutatedTerminal(
  set: (fn: (s: PreviewStoreState) => Partial<PreviewStoreState>) => void,
  id: string,
  mutator: (s: PreviewState) => PreviewState,
) {
  set((state) => {
    const next = new Map(state.perTerminal);
    const cur = next.get(id) ?? defaultPreviewState();
    next.set(id, mutator(cur));
    return { perTerminal: next };
  });
}

export const usePreviewStore = create<PreviewStoreState>()(
  persist(
    (set, get) => ({
      perTerminal: new Map(),
      globalOpen: false,
      allowList: [],
      keepAliveAcrossTabs: false,
      panelWidthPx: 640,

      seedTerminal: (id, initial) =>
        withMutatedTerminal(set, id, (s) => ({ ...s, ...initial })),

      setDetectedUrl: (id, url) =>
        withMutatedTerminal(set, id, (s) => ({ ...s, detectedUrl: url, lastError: null })),

      setUserOverride: (id, url) =>
        withMutatedTerminal(set, id, (s) => ({ ...s, userOverride: url })),

      dismissInlineHint: (id) =>
        withMutatedTerminal(set, id, (s) => ({ ...s, inlineHintDismissed: true })),

      markOpen: (id, open) =>
        withMutatedTerminal(set, id, (s) => ({ ...s, isOpen: open })),

      removeTerminal: (id) =>
        set((state) => {
          const next = new Map(state.perTerminal);
          next.delete(id);
          return { perTerminal: next };
        }),

      toggleGlobal: () => set((s) => ({ globalOpen: !s.globalOpen })),

      setDeviceMode: (id, mode) =>
        withMutatedTerminal(set, id, (s) => ({ ...s, deviceMode: mode })),

      reload: (id) =>
        withMutatedTerminal(set, id, (s) => ({ ...s, reloadCounter: s.reloadCounter + 1 })),

      addToAllowList: (pattern) =>
        set((s) => (s.allowList.includes(pattern)
          ? s
          : { allowList: [...s.allowList, pattern] })),

      removeFromAllowList: (pattern) =>
        set((s) => ({ allowList: s.allowList.filter((p) => p !== pattern) })),

      setPanelWidth: (px) => set({ panelWidthPx: Math.max(320, Math.min(1400, px)) }),
      setKeepAliveAcrossTabs: (v) => set({ keepAliveAcrossTabs: v }),

      resolveUrl: (id) => {
        const s = get().perTerminal.get(id);
        if (!s) return null;
        return s.userOverride ?? s.detectedUrl;
      },
    }),
    {
      name: 'preview-store',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        globalOpen: s.globalOpen,
        allowList: s.allowList,
        keepAliveAcrossTabs: s.keepAliveAcrossTabs,
        panelWidthPx: s.panelWidthPx,
      }),
    },
  ),
);
