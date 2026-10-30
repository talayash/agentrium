import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { emptyHistory, recordLoad, markPending, type NavHistory } from '../lib/browser/history';
import type { PickedElement } from '../lib/browser/pickedElement';

// Built-in browser UI state. Tabs are ephemeral (their native webviews die
// with the app), so only layout and bookmarks persist. Side effects (IPC to
// the native webviews) live in src/lib/browser/controller.ts.

export interface BrowserTab {
  id: string;
  /** Last committed or requested URL; '' for an empty "New tab". */
  url: string;
  title: string;
  loading: boolean;
  /** Load failure shown in the in-app error card; null when fine. */
  error: string | null;
  /** Inline message under the toolbar (blocked link, refused download). */
  notice: string | null;
  /** True once a native webview exists for this tab. */
  hasWebview: boolean;
  history: NavHistory;
}

export interface Bookmark {
  url: string;
  title: string;
}

export type BrowserLayout = 'full' | 'split';

export type BrowserEventPayload =
  | { kind: 'loadStarted'; id: string; url: string }
  | { kind: 'loadFinished'; id: string; url: string }
  | { kind: 'titleChanged'; id: string; title: string }
  | { kind: 'loadFailed'; id: string; url: string; error: string }
  | { kind: 'newTab'; id: string; url: string }
  | { kind: 'blocked'; id: string; url: string; reason: string }
  | { kind: 'elementPicked'; id: string; element: PickedElement }
  | { kind: 'pickCancelled'; id: string };

export const MIN_TERMINAL_PX = 260;
export const MIN_BROWSER_PX = 360;

interface BrowserState {
  open: boolean;
  layout: BrowserLayout;
  /** Terminal pane width in split layout. */
  splitPx: number;
  tabs: BrowserTab[];
  activeTabId: string | null;
  bookmarks: Bookmark[];
  /** Tab whose element picker is armed; at most one at a time. */
  pickingTabId: string | null;

  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setLayout: (layout: BrowserLayout) => void;
  setSplitPx: (px: number, containerPx?: number) => void;
  /** Adds an empty tab (or one about to load `url`) and activates it. */
  addTab: (url?: string) => string;
  /** Removes a tab; returns the id that became active (may be a fresh tab). */
  removeTab: (id: string) => void;
  activateTab: (id: string) => void;
  patchTab: (id: string, patch: Partial<BrowserTab>) => void;
  markPending: (id: string, dir: 'back' | 'forward') => void;
  applyEvent: (ev: BrowserEventPayload) => void;
  toggleBookmark: (bookmark: Bookmark) => void;
  removeBookmark: (url: string) => void;
  setPickingTabId: (id: string | null) => void;
}

let seq = 0;
export function newTabId(): string {
  seq += 1;
  return `t${Date.now().toString(36)}${seq}`;
}

function blankTab(id: string, url = ''): BrowserTab {
  return { id, url, title: '', loading: false, error: null, notice: null, hasWebview: false, history: emptyHistory };
}

export function clampSplit(px: number, containerPx?: number): number {
  const max = containerPx ? Math.max(MIN_TERMINAL_PX, containerPx - MIN_BROWSER_PX) : Infinity;
  return Math.round(Math.max(MIN_TERMINAL_PX, Math.min(max, px)));
}

export const useBrowserStore = create<BrowserState>()(
  persist(
    (set, get) => ({
      open: false,
      layout: 'split',
      splitPx: 480,
      tabs: [],
      activeTabId: null,
      bookmarks: [],
      pickingTabId: null,

      setOpen: (open) =>
        set((s) => {
          if (open && s.tabs.length === 0) {
            const id = newTabId();
            return { open, tabs: [blankTab(id)], activeTabId: id };
          }
          return { open };
        }),

      toggleOpen: () => get().setOpen(!get().open),

      setLayout: (layout) => set({ layout }),

      setSplitPx: (px, containerPx) => set({ splitPx: clampSplit(px, containerPx) }),

      addTab: (url = '') => {
        const id = newTabId();
        set((s) => ({ tabs: [...s.tabs, blankTab(id, url)], activeTabId: id }));
        return id;
      },

      removeTab: (id) =>
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          if (idx === -1) return s;
          let tabs = s.tabs.filter((t) => t.id !== id);
          // Closing the last tab leaves a fresh New tab rather than an empty strip.
          if (tabs.length === 0) tabs = [blankTab(newTabId())];
          const activeTabId =
            s.activeTabId === id ? tabs[Math.min(idx, tabs.length - 1)].id : s.activeTabId;
          const pickingTabId = s.pickingTabId === id ? null : s.pickingTabId;
          return { tabs, activeTabId, pickingTabId };
        }),

      activateTab: (id) => set({ activeTabId: id }),

      patchTab: (id, patch) =>
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),

      markPending: (id, dir) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, history: markPending(t.history, dir) } : t)),
        })),

      applyEvent: (ev) =>
        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.id !== ev.id) return t;
            switch (ev.kind) {
              case 'loadStarted':
                return { ...t, url: ev.url, loading: true, error: null };
              case 'loadFinished':
                // A failed load still reports "finished"; keep its error card.
                return { ...t, url: ev.url, loading: false, history: recordLoad(t.history, ev.url) };
              case 'titleChanged':
                return { ...t, title: ev.title };
              case 'loadFailed':
                return { ...t, url: ev.url || t.url, loading: false, error: ev.error };
              case 'blocked':
                return { ...t, notice: ev.reason };
              default:
                return t;
            }
          }),
        })),

      toggleBookmark: (bookmark) =>
        set((s) =>
          s.bookmarks.some((b) => b.url === bookmark.url)
            ? { bookmarks: s.bookmarks.filter((b) => b.url !== bookmark.url) }
            : { bookmarks: [...s.bookmarks, bookmark] },
        ),

      removeBookmark: (url) => set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.url !== url) })),

      setPickingTabId: (pickingTabId) => set({ pickingTabId }),
    }),
    {
      name: 'browser-store',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ layout: s.layout, splitPx: s.splitPx, bookmarks: s.bookmarks }),
    },
  ),
);

export function activeTab(s: Pick<BrowserState, 'tabs' | 'activeTabId'>): BrowserTab | undefined {
  return s.tabs.find((t) => t.id === s.activeTabId);
}
