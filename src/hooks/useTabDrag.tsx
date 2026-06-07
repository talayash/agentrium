import { useCallback, useEffect, useRef, useState } from 'react';
import { emit } from '@tauri-apps/api/event';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { getDragData, isTerminalDrag } from '../utils/dragDrop';
import { routeTabDrop } from '../lib/tabTransfer';
import { DRAG_PREVIEW_START, DRAG_PREVIEW_END } from '../components/DragPreview';

const DRAG_THRESHOLD = 6; // px before a press becomes a drag
const STRIP_PAD = 28; // px of slack around the strip that still counts as "in strip"

/** Ordered ids of the main-tab terminals in THIS window's store. */
function tabOrder(): string[] {
  return Array.from(useTerminalStore.getState().terminals.values())
    .filter((t) => !t.scriptParentId && !t.isShellTerminal)
    .map((t) => t.config.id);
}

export interface TabHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  onClick: (e: React.MouseEvent) => void;
  // Drop target for incoming sidebar/grid HTML5 drags → split (main only).
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

interface DragStart {
  x: number;
  y: number;
  id: string;
  index: number;
  moved: boolean;
  pointerId: number;
  el: HTMLElement;
  ul: HTMLElement | null;
  width: number;
}

/**
 * Pointer-based tab drag/drop. HTML5 DnD is unreliable in WebView2, so the tab
 * drag uses pointer events + pointer capture. The lifted "carry" visual is a
 * separate transparent, always-on-top overlay window (see DragPreview) that
 * follows the cursor — so the dragged tab is visible even OUTSIDE the window (a
 * DOM ghost would be clipped to its window). One gesture covers:
 *   - reorder within the strip (slide-aside: other tabs part to open a gap),
 *   - drag-out: release outside the strip → `routeTabDrop` tears off a new
 *     window or transfers into the window under the cursor,
 *   - Ctrl/Cmd+click multi-select.
 * Incoming sidebar/grid drags still arrive as HTML5 drops → split (main only).
 */
export function useTabDrag(windowLabel: string, variant: 'main' | 'detached' = 'main') {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [splitDropTargetId, setSplitDropTargetId] = useState<string | null>(null);
  // Ids currently being dragged — drives the strip's slide-aside preview order.
  const [dragIds, setDragIds] = useState<string[]>([]);

  const startRef = useRef<DragStart | null>(null);
  const dragIdsRef = useRef<string[]>([]);
  const suppressClickRef = useRef(false);
  const dropIndexRef = useRef<number | null>(null);
  const previewActiveRef = useRef(false);

  const reorderTerminals = useTerminalStore((s) => s.reorderTerminals);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);
  const setActiveFilePath = useAppStore((s) => s.setActiveFilePath);
  const setSplitTerminals = useAppStore((s) => s.setSplitTerminals);
  const setSplitMode = useAppStore((s) => s.setSplitMode);

  const endPreview = useCallback(() => {
    if (previewActiveRef.current) {
      previewActiveRef.current = false;
      void emit(DRAG_PREVIEW_END);
    }
  }, []);

  const resetDrag = useCallback(() => {
    startRef.current = null;
    dragIdsRef.current = [];
    dropIndexRef.current = null;
    setDragIds([]);
    setDropIndex(null);
    endPreview();
  }, [endPreview]);

  // Safety net: if a drag is lost (window blur, e.g. release outside the window
  // where pointer capture didn't follow), clear state + hide the overlay.
  useEffect(() => {
    const onBlur = () => {
      if (startRef.current?.moved) resetDrag();
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [resetDrag]);

  const commitReorder = useCallback(
    (ids: string[], at: number) => {
      // `at` is an index among the NON-dragged tabs (see computeDropIndex), so
      // insert there directly — matching the strip's slide-aside preview order,
      // so commit produces no visual jump.
      const remaining = tabOrder().filter((tid) => !ids.includes(tid));
      const insertAt = Math.max(0, Math.min(at, remaining.length));
      reorderTerminals([...remaining.slice(0, insertAt), ...ids, ...remaining.slice(insertAt)]);
    },
    [reorderTerminals],
  );

  const tabInfo = (id: string): { label: string; colorTag: string | null } => {
    const cfg = useTerminalStore.getState().terminals.get(id)?.config;
    return { label: cfg?.nickname || cfg?.label || 'Terminal', colorTag: cfg?.color_tag ?? null };
  };

  const computeDropIndex = (ul: HTMLElement, clientX: number): number => {
    // Only the non-dragged tabs (the dragged one renders as a faded gap, marked
    // [data-dragging] and excluded); the index is the slot among them.
    const tabs = Array.from(ul.querySelectorAll<HTMLElement>('[role="tab"]:not([data-dragging])'));
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return tabs.length;
  };

  const onPointerDown = useCallback((e: React.PointerEvent, id: string, index: number) => {
    if (e.button !== 0) return; // left button only
    // Don't hijack presses on the in-tab action buttons (close/split/grid/…).
    if ((e.target as HTMLElement).closest('button,[role="button"]')) return;
    const el = e.currentTarget as HTMLElement;
    const ul = el.closest('[data-tab-strip]') as HTMLElement | null;
    const rect = el.getBoundingClientRect();
    startRef.current = {
      x: e.clientX,
      y: e.clientY,
      id,
      index,
      moved: false,
      pointerId: e.pointerId,
      el,
      ul,
      width: rect.width,
    };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const s = startRef.current;
      if (!s) return;

      if (!s.moved) {
        if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < DRAG_THRESHOLD) return;
        s.moved = true;
        // Drag the whole multi-selection if the grabbed tab is part of it.
        const sel = selectedIds.has(s.id) && selectedIds.size > 1 ? selectedIds : new Set([s.id]);
        const ids = tabOrder().filter((tid) => sel.has(tid));
        dragIdsRef.current = ids.length ? ids : [s.id];
        const info = tabInfo(dragIdsRef.current[0]);
        setDragIds(dragIdsRef.current); // triggers the strip slide-aside preview
        // Show the floating overlay (the lifted tab that can leave the window).
        previewActiveRef.current = true;
        void emit(DRAG_PREVIEW_START, {
          label: info.label,
          color: info.colorTag,
          count: dragIdsRef.current.length,
          width: s.width,
        });
      }

      // Reorder indicator: only update state when the slot actually changes.
      let nextIndex: number | null = null;
      if (s.ul) {
        const r = s.ul.getBoundingClientRect();
        const inStrip =
          e.clientX >= r.left - STRIP_PAD &&
          e.clientX <= r.right + STRIP_PAD &&
          e.clientY >= r.top - STRIP_PAD &&
          e.clientY <= r.bottom + STRIP_PAD;
        nextIndex = inStrip ? computeDropIndex(s.ul, e.clientX) : null;
      }
      if (nextIndex !== dropIndexRef.current) {
        dropIndexRef.current = nextIndex;
        setDropIndex(nextIndex);
      }
    },
    [selectedIds],
  );

  const onPointerUp = useCallback(() => {
    const s = startRef.current;
    try {
      s?.el.releasePointerCapture(s.pointerId);
    } catch {
      /* ignore */
    }
    if (!s) return;
    if (!s.moved) {
      // Plain click — let onClick handle focus/selection.
      startRef.current = null;
      return;
    }
    suppressClickRef.current = true;
    const ids = dragIdsRef.current;
    const di = dropIndexRef.current;
    resetDrag();
    setSelectedIds(new Set());
    if (di != null) {
      commitReorder(ids, di);
    } else {
      void routeTabDrop(ids, windowLabel);
    }
  }, [commitReorder, resetDrag, windowLabel]);

  const onPointerCancel = useCallback(() => {
    resetDrag();
  }, [resetDrag]);

  const onClick = useCallback(
    (e: React.MouseEvent, id: string) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return; // this "click" is the tail of a drag
      }
      if (e.ctrlKey || e.metaKey) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        return;
      }
      setSelectedIds(new Set());
      setActiveFilePath(null);
      setActiveTerminal(id);
    },
    [setActiveFilePath, setActiveTerminal],
  );

  // --- Incoming sidebar/grid HTML5 drag → split (main window only) ---
  const onDragOver = useCallback(
    (e: React.DragEvent, tabId: string) => {
      if (variant !== 'main' || !isTerminalDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setSplitDropTargetId(tabId);
    },
    [variant],
  );
  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setSplitDropTargetId(null);
    }
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent, tabId: string) => {
      if (variant !== 'main') return;
      e.preventDefault();
      setSplitDropTargetId(null);
      const payload = getDragData(e);
      if (payload && payload.terminalId !== tabId) {
        setSplitTerminals([tabId, payload.terminalId]);
        setSplitMode(true);
      }
    },
    [variant, setSplitTerminals, setSplitMode],
  );

  const tabHandlers = useCallback(
    (id: string, index: number): TabHandlers => ({
      onPointerDown: (e) => onPointerDown(e, id, index),
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClick: (e) => onClick(e, id),
      onDragOver: (e) => onDragOver(e, id),
      onDragLeave,
      onDrop: (e) => onDrop(e, id),
    }),
    [onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick, onDragOver, onDragLeave, onDrop],
  );

  return {
    isSelected: (id: string) => selectedIds.has(id),
    isDragging: (id: string) => dragIds.includes(id),
    dragIds,
    dropIndex,
    splitDropTargetId,
    tabHandlers,
  };
}
