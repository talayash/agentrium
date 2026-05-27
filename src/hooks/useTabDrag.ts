import { useCallback, useRef, useState } from 'react';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { setDragData, getDragData, isTerminalDrag } from '../utils/dragDrop';
import { routeTabDrop } from '../lib/tabTransfer';

/** Current ordered ids of the main-tab terminals in THIS window's store
 *  (excludes script children and bottom-pane shells). Read on demand to avoid
 *  stale closures. */
function tabOrder(): string[] {
  return Array.from(useTerminalStore.getState().terminals.values())
    .filter((t) => !t.scriptParentId && !t.isShellTerminal)
    .map((t) => t.config.id);
}

export interface TabDragProps {
  draggable: true;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
}

export interface ContainerDragProps {
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

/**
 * Shared tab drag/drop behavior for both the main window's tab strip and a
 * detached window's. One HTML5-DnD gesture covers:
 *   - reorder within the strip (insertion indicator via `dropIndex`),
 *   - split-on-drop from the sidebar/grid (main variant only),
 *   - Ctrl/Cmd+click multi-select, and
 *   - drag-out: on drop outside the strip, `routeTabDrop` tears off a new window
 *     or transfers the tab(s) into whichever window the cursor is over.
 */
export function useTabDrag(windowLabel: string, variant: 'main' | 'detached' = 'main') {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [splitDropTargetId, setSplitDropTargetId] = useState<string | null>(null);

  // Ids being dragged for the current gesture (null when the drag didn't start
  // here — e.g. a sidebar/grid drag). `droppedInternally` suppresses the
  // tear-off route when an in-strip reorder consumed the drop.
  const dragStateRef = useRef<{ ids: string[] } | null>(null);
  const droppedInternallyRef = useRef(false);

  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);
  const reorderTerminals = useTerminalStore((s) => s.reorderTerminals);
  const setActiveFilePath = useAppStore((s) => s.setActiveFilePath);
  const setSplitTerminals = useAppStore((s) => s.setSplitTerminals);
  const setSplitMode = useAppStore((s) => s.setSplitMode);

  const onTabClick = useCallback(
    (e: React.MouseEvent, id: string) => {
      if (e.ctrlKey || e.metaKey) {
        // Toggle multi-selection without changing the active tab.
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

  const beginDrag = useCallback(
    (e: React.DragEvent, id: string, index: number) => {
      // Dragging a tab that's part of a multi-selection drags the whole set;
      // dragging an unselected tab drags only it (Chrome behavior).
      const inGroup = selectedIds.has(id) && selectedIds.size > 1;
      const sel = inGroup ? selectedIds : new Set([id]);
      const ids = tabOrder().filter((tid) => sel.has(tid));
      const finalIds = ids.length > 0 ? ids : [id];
      dragStateRef.current = { ids: finalIds };
      droppedInternallyRef.current = false;
      setDragData(e, { terminalId: id, source: 'tab', sourceIndex: index, ids: finalIds, windowLabel });
    },
    [selectedIds, windowLabel],
  );

  const overTab = useCallback(
    (e: React.DragEvent, index: number, tabId: string) => {
      if (!isTerminalDrag(e)) return;
      if (dragStateRef.current) {
        // Reorder: insert before/after this tab based on the cursor midpoint.
        e.preventDefault();
        e.stopPropagation(); // don't let the container handler override the index
        e.dataTransfer.dropEffect = 'move';
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const after = e.clientX > rect.left + rect.width / 2;
        setDropIndex(after ? index + 1 : index);
        setSplitDropTargetId(null);
      } else if (variant === 'main') {
        // Sidebar/grid drag onto a tab → split highlight.
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setSplitDropTargetId(tabId);
      }
    },
    [variant],
  );

  const leaveTab = useCallback((e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setSplitDropTargetId(null);
    }
  }, []);

  const dropOnTab = useCallback(
    (e: React.DragEvent, tabId: string) => {
      e.preventDefault();
      if (dragStateRef.current) {
        const ids = dragStateRef.current.ids;
        commitReorder(ids, dropIndex ?? tabOrder().length);
        droppedInternallyRef.current = true;
      } else if (variant === 'main') {
        const payload = getDragData(e);
        if (payload && payload.terminalId !== tabId) {
          setSplitTerminals([tabId, payload.terminalId]);
          setSplitMode(true);
        }
      }
      setDropIndex(null);
      setSplitDropTargetId(null);
    },
    [dropIndex, commitReorder, variant, setSplitTerminals, setSplitMode],
  );

  const endDrag = useCallback(() => {
    const state = dragStateRef.current;
    dragStateRef.current = null;
    setDropIndex(null);
    setSplitDropTargetId(null);
    if (state && !droppedInternallyRef.current) {
      // Dropped outside this strip — tear off / transfer based on cursor.
      void routeTabDrop(state.ids, windowLabel);
    }
    droppedInternallyRef.current = false;
    setSelectedIds(new Set());
  }, [windowLabel]);

  const tabDragProps = useCallback(
    (id: string, index: number): TabDragProps => ({
      draggable: true,
      onDragStart: (e) => beginDrag(e, id, index),
      onDragOver: (e) => overTab(e, index, id),
      onDragLeave: leaveTab,
      onDrop: (e) => dropOnTab(e, id),
      onDragEnd: endDrag,
    }),
    [beginDrag, overTab, leaveTab, dropOnTab, endDrag],
  );

  // For the empty area after the last tab: allow dropping at the end.
  const containerDragProps: ContainerDragProps = {
    onDragOver: (e) => {
      if (dragStateRef.current && isTerminalDrag(e)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropIndex(tabOrder().length);
      }
    },
    onDrop: (e) => {
      if (!dragStateRef.current) return;
      e.preventDefault();
      commitReorder(dragStateRef.current.ids, dropIndex ?? tabOrder().length);
      droppedInternallyRef.current = true;
      setDropIndex(null);
    },
  };

  return {
    selectedIds,
    isSelected: (id: string) => selectedIds.has(id),
    onTabClick,
    dropIndex,
    splitDropTargetId,
    tabDragProps,
    containerDragProps,
  };
}
