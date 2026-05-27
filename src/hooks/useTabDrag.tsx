import { useCallback, useEffect, useRef, useState } from 'react';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { getDragData, isTerminalDrag } from '../utils/dragDrop';
import { routeTabDrop } from '../lib/tabTransfer';

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
  // Offset of the cursor within the grabbed tab + the tab's width, so the ghost
  // is carried from the exact grab point at the tab's real size (Chrome/Arc feel).
  offsetX: number;
  offsetY: number;
  width: number;
}

interface DragMeta {
  label: string;
  count: number;
  colorTag: string | null;
  width: number;
}

/**
 * Pointer-based tab drag/drop. HTML5 drag-and-drop is unreliable in WebView2
 * (especially dragging out of the window), so the tab's own drag uses pointer
 * events + pointer capture and a floating ghost. One gesture covers:
 *   - reorder within the strip (insertion indicator via `dropIndex`),
 *   - drag-out: release outside the strip → `routeTabDrop` tears off a new
 *     window (release over the body/desktop) or transfers the tab(s) into the
 *     window under the cursor,
 *   - Ctrl/Cmd+click multi-select.
 * Incoming sidebar/grid drags still arrive as HTML5 drops → split (main only).
 *
 * Smoothness: the ghost follows the cursor via a direct GPU `transform` write
 * (no React state per move), and `dropIndex` only updates when the insertion
 * slot actually changes — so a drag re-renders the tab bar rarely, not on every
 * mouse move.
 */
export function useTabDrag(windowLabel: string, variant: 'main' | 'detached' = 'main') {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [splitDropTargetId, setSplitDropTargetId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragMeta, setDragMeta] = useState<DragMeta>({ label: '', count: 0, colorTag: null, width: 0 });

  const startRef = useRef<DragStart | null>(null);
  const dragIdsRef = useRef<string[]>([]);
  const suppressClickRef = useRef(false);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const lastPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dropIndexRef = useRef<number | null>(null);

  const reorderTerminals = useTerminalStore((s) => s.reorderTerminals);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);
  const setActiveFilePath = useAppStore((s) => s.setActiveFilePath);
  const setSplitTerminals = useAppStore((s) => s.setSplitTerminals);
  const setSplitMode = useAppStore((s) => s.setSplitMode);

  const resetDrag = useCallback(() => {
    startRef.current = null;
    dragIdsRef.current = [];
    dropIndexRef.current = null;
    setDragging(false);
    setDropIndex(null);
  }, []);

  // Safety net: if a drag is lost (window blur, e.g. release outside the window
  // where pointer capture didn't follow), clear the ghost so it isn't stuck.
  useEffect(() => {
    const onBlur = () => {
      if (startRef.current?.moved) resetDrag();
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [resetDrag]);

  const commitReorder = useCallback(
    (ids: string[], at: number) => {
      const order = tabOrder();
      const remaining = order.filter((tid) => !ids.includes(tid));
      const removedBefore = order.slice(0, at).filter((tid) => ids.includes(tid)).length;
      const insertAt = at - removedBefore;
      reorderTerminals([...remaining.slice(0, insertAt), ...ids, ...remaining.slice(insertAt)]);
    },
    [reorderTerminals],
  );

  const tabInfo = (id: string): { label: string; colorTag: string | null } => {
    const cfg = useTerminalStore.getState().terminals.get(id)?.config;
    return { label: cfg?.nickname || cfg?.label || 'Terminal', colorTag: cfg?.color_tag ?? null };
  };

  // The ghost is carried from the grab point (cursor - offset) with a subtle
  // lift: a small tilt + scale that reads as "picked up".
  const ghostTransform = (cx: number, cy: number, s: DragStart): string => {
    const x = cx - s.offsetX;
    const y = cy - s.offsetY;
    lastPosRef.current = { x, y };
    return `translate3d(${x}px, ${y}px, 0) rotate(-2deg) scale(1.04)`;
  };

  const computeDropIndex = (ul: HTMLElement, clientX: number): number => {
    const tabs = Array.from(ul.querySelectorAll<HTMLElement>('[role="tab"]'));
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
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
    };
    // Capture so we keep getting move/up even when the cursor leaves the tab.
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
      lastPosRef.current = { x: e.clientX, y: e.clientY };

      if (!s.moved) {
        if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < DRAG_THRESHOLD) return;
        s.moved = true;
        // Drag the whole multi-selection if the grabbed tab is part of it.
        const sel = selectedIds.has(s.id) && selectedIds.size > 1 ? selectedIds : new Set([s.id]);
        const ids = tabOrder().filter((tid) => sel.has(tid));
        dragIdsRef.current = ids.length ? ids : [s.id];
        const info = tabInfo(dragIdsRef.current[0]);
        // Initialize ghost position before first paint so it doesn't flash at 0,0.
        lastPosRef.current = { x: e.clientX - s.offsetX, y: e.clientY - s.offsetY };
        setDragMeta({ label: info.label, count: dragIdsRef.current.length, colorTag: info.colorTag, width: s.width });
        setDragging(true); // renders the ghost; positioned from lastPosRef on mount
      }

      // Move the ghost directly (no re-render).
      if (ghostRef.current) ghostRef.current.style.transform = ghostTransform(e.clientX, e.clientY, s);

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
    // It was a drag: suppress the click that the browser fires after pointerup.
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

  const ghostNode = dragging ? (
    <div
      ref={ghostRef}
      className="ct-ghost"
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        transform: `translate3d(${lastPosRef.current.x}px, ${lastPosRef.current.y}px, 0) rotate(-2deg) scale(1.04)`,
        transformOrigin: 'center',
        width: dragMeta.width || undefined,
        willChange: 'transform',
        zIndex: 100,
        pointerEvents: 'none',
        boxShadow: '0 10px 28px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.35)',
      }}
    >
      <div className="h-9 px-3 flex items-center gap-2 rounded-md bg-elevation-0 ring-1 ring-accent-primary/70 text-[12px] text-text-primary select-none overflow-hidden">
        {dragMeta.colorTag && <div className={`w-2 h-2 rounded-full ${dragMeta.colorTag} flex-shrink-0`} />}
        <span className="truncate">{dragMeta.label}</span>
        {dragMeta.count > 1 && (
          <span className="text-[10px] px-1 rounded bg-accent-primary/20 text-accent-primary flex-shrink-0">
            +{dragMeta.count - 1}
          </span>
        )}
      </div>
    </div>
  ) : null;

  return {
    isSelected: (id: string) => selectedIds.has(id),
    isDragging: (id: string) => dragging && dragIdsRef.current.includes(id),
    dropIndex,
    splitDropTargetId,
    tabHandlers,
    ghost: ghostNode,
  };
}
