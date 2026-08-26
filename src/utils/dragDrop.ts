export const TERMINAL_DRAG_TYPE = 'application/x-claude-terminal';

export interface DragPayload {
  terminalId: string;
  source: 'sidebar' | 'grid' | 'tab';
  sourceIndex?: number;
  /** All dragged terminal ids when a multi-selection is dragged (tab source).
   *  Falls back to [terminalId] when absent. */
  ids?: string[];
  /** Label of the window the drag originated from (tab source). Used by the
   *  cross-window tear-off / transfer engine. */
  windowLabel?: string;
}

export function setDragData(e: React.DragEvent, payload: DragPayload) {
  e.dataTransfer.setData(TERMINAL_DRAG_TYPE, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = 'move';
}

export function getDragData(e: React.DragEvent): DragPayload | null {
  try {
    const data = e.dataTransfer.getData(TERMINAL_DRAG_TYPE);
    if (!data) return null;
    return JSON.parse(data) as DragPayload;
  } catch {
    return null;
  }
}

export function isTerminalDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(TERMINAL_DRAG_TYPE);
}

/** True if `el` or an ancestor is hidden via `visibility: hidden`/`collapse`.
 *  Inactive tab terminals stay mounted, stacked absolute inset-0 with
 *  `visibility: hidden` (the layout box must persist for xterm's fit), so
 *  their bounding rects still cover the viewport - a rect hit test alone
 *  matches every stacked terminal, not just the visible one. Walks ancestors
 *  explicitly rather than relying on computed-style inheritance, so it also
 *  works under jsdom; nothing in the app re-shows a descendant inside a
 *  hidden subtree. */
export function isVisibilityHidden(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const vis = getComputedStyle(node).visibility;
    if (vis === 'hidden' || vis === 'collapse') return true;
  }
  return false;
}
