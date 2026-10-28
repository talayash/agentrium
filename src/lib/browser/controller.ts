// Side effects for the built-in browser: IPC to the native child webviews
// (src-tauri/src/browser.rs) and the bridge for their events. React
// components call these; browserStore stays a pure state container.
//
// Native webviews draw ABOVE the DOM, so anything the UI wants on top of the
// page (modals, menus, the split drag) works by hiding the webview, never by
// z-index. Messages for the user go into the tab's notice bar rather than a
// toast, because a toast over the page area would be hidden behind it.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useBrowserStore, type BrowserEventPayload } from '../../store/browserStore';
import { resolveAddress } from './address';
import { reportInvokeFailure } from '../errorReporter';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const store = () => useBrowserStore.getState();
const findTab = (id: string) => store().tabs.find((t) => t.id === id);

// ---- page slot ------------------------------------------------------------

let slot: HTMLElement | null = null;

export function setPageSlot(el: HTMLElement | null): void {
  slot = el;
}

export function slotBounds(): Bounds | null {
  if (!slot) return null;
  const r = slot.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

// ---- native event bridge --------------------------------------------------

let bridge: Promise<unknown> | null = null;

export function ensureBrowserEvents(): void {
  if (bridge) return;
  bridge = listen<BrowserEventPayload>('browser-event', (e) => handleEvent(e.payload)).catch((err) => {
    bridge = null;
    reportInvokeFailure('browser_listen', err);
  });
}

function handleEvent(ev: BrowserEventPayload): void {
  if (!findTab(ev.id)) return;
  if (ev.kind === 'newTab') {
    void openInNewTab(ev.url);
    return;
  }
  store().applyEvent(ev);
}

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

// ---- visibility and bounds ------------------------------------------------

const shown = new Map<string, boolean>();
const lastBounds = new Map<string, string>();

/** Show exactly one tab's webview (or none). Skips redundant IPC. */
export function showOnly(visibleId: string | null): void {
  for (const tab of store().tabs) {
    if (!tab.hasWebview) continue;
    const want = tab.id === visibleId;
    if (shown.get(tab.id) === want) continue;
    shown.set(tab.id, want);
    // Best effort: a webview closed meanwhile simply has nothing to show.
    invoke('browser_set_visible', { id: tab.id, visible: want }).catch(() => {});
  }
}

export function placeTab(id: string): void {
  const b = slotBounds();
  if (!b) return;
  const key = `${b.x},${b.y},${b.width},${b.height}`;
  if (lastBounds.get(id) === key) return;
  lastBounds.set(id, key);
  // Best effort: the next resize or tab switch places it again.
  invoke('browser_set_bounds', { id, bounds: b }).catch(() => {});
}

// ---- user actions ---------------------------------------------------------

export async function navigateTab(id: string, input: string): Promise<void> {
  const url = resolveAddress(input);
  const tab = findTab(id);
  if (!url || !tab) return;
  ensureBrowserEvents();
  store().patchTab(id, { url, loading: true, error: null, notice: null, title: tab.hasWebview ? tab.title : '' });
  try {
    await invoke('browser_navigate', { id, url, bounds: slotBounds() ?? { x: 0, y: 0, width: 1, height: 1 } });
    if (!findTab(id)) {
      // Tab closed while its webview was being created.
      invoke('browser_close', { id }).catch(() => {});
      return;
    }
    if (!tab.hasWebview) {
      // A new webview starts visible at the slot; let the page sync decide.
      shown.set(id, true);
      lastBounds.delete(id);
      store().patchTab(id, { hasWebview: true });
    }
  } catch (err) {
    store().patchTab(id, { loading: false, notice: errorText(err) });
    reportInvokeFailure('browser_navigate', err);
  }
}

export async function openInNewTab(url: string): Promise<void> {
  const id = store().addTab();
  await navigateTab(id, url);
}

function tabAction(cmd: 'browser_back' | 'browser_forward' | 'browser_reload', id: string): void {
  invoke(cmd, { id }).catch((err) => {
    store().patchTab(id, { loading: false, notice: errorText(err) });
    reportInvokeFailure(cmd, err);
  });
}

export function goBack(id: string): void {
  store().markPending(id, 'back');
  tabAction('browser_back', id);
}

export function goForward(id: string): void {
  store().markPending(id, 'forward');
  tabAction('browser_forward', id);
}

export function reloadTab(id: string): void {
  const tab = findTab(id);
  if (!tab || !tab.url) return;
  // No webview yet means the first load never got that far: start it again.
  if (!tab.hasWebview) {
    void navigateTab(id, tab.url);
    return;
  }
  store().patchTab(id, { loading: true, error: null, notice: null });
  tabAction('browser_reload', id);
}

export function closeTab(id: string): void {
  const tab = findTab(id);
  store().removeTab(id);
  shown.delete(id);
  lastBounds.delete(id);
  // Best effort: closing a webview that is already gone is not a failure.
  if (tab?.hasWebview) invoke('browser_close', { id }).catch(() => {});
}
