// Back/forward state for a browser tab. Native webviews expose no history
// API, so this mirrors it from finished page loads: back/forward clicks mark
// a pending direction, and the next finished load moves the cursor instead
// of pushing a new entry. Same-document navigations (pushState) produce no
// page load, so single-page apps can drift; the buttons then still work via
// history.back()/forward(), only their enabled state may be off by one.

export interface NavHistory {
  entries: string[];
  index: number;
  pending: 'back' | 'forward' | null;
}

export const emptyHistory: NavHistory = { entries: [], index: -1, pending: null };

export function canGoBack(h: NavHistory): boolean {
  return h.index > 0;
}

export function canGoForward(h: NavHistory): boolean {
  return h.index >= 0 && h.index < h.entries.length - 1;
}

export function markPending(h: NavHistory, dir: 'back' | 'forward'): NavHistory {
  return { ...h, pending: dir };
}

export function recordLoad(h: NavHistory, url: string): NavHistory {
  if (h.pending === 'back' && h.index > 0) {
    const index = h.index - 1;
    const entries = h.entries.slice();
    entries[index] = url;
    return { entries, index, pending: null };
  }
  if (h.pending === 'forward' && h.index < h.entries.length - 1) {
    const index = h.index + 1;
    const entries = h.entries.slice();
    entries[index] = url;
    return { entries, index, pending: null };
  }
  // Reload, or a duplicate finished event for the same page.
  if (h.index >= 0 && h.entries[h.index] === url) return { ...h, pending: null };
  const entries = h.entries.slice(0, h.index + 1).concat(url);
  return { entries, index: entries.length - 1, pending: null };
}
