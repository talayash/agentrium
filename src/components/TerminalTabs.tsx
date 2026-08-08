import { useMemo, useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Plus, Grid3X3, SplitSquareHorizontal, RotateCw, GitBranch, ChevronLeft, ChevronRight, ChevronDown, Copy, File as FileIcon, Pin, PinOff, Search as SearchIcon, SlidersHorizontal } from 'lucide-react';
import appIconUrl from '../assets/app-icon.png';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { TerminalView } from './TerminalView';
import { TerminalGrid } from './TerminalGrid';
import { SplitView } from './SplitView';
import { SessionInsights } from './SessionInsights';
import { SessionMetricsPanel } from './SessionMetricsPanel';
import { FileEditorView } from './FileEditorView';
import { ScriptsMenu } from './ScriptsMenu';
import { ScriptChildPane } from './ScriptChildPane';
import { BottomTerminalPane } from './BottomTerminalPane';
import { useNowTick } from '../hooks/useNowTick';
import { useTabDrag } from '../hooks/useTabDrag';
import { getWindowMode } from '../lib/windowMode';
import { getLastOutputAt } from '../lib/terminalActivity';
import { orderTabsPinnedFirst } from '../lib/pinnedTabOrder';
import { estimateTabWidth, computeTabOverflow } from '../lib/tabOverflow';
import { idsToCloseForOthers, idsToCloseForAllButPinned } from '../lib/closeTabActions';
import { StateDot } from './StateDot';
import { Tooltip } from './ui/Tooltip';
import type { SessionState } from '../lib/terminalState';

interface TabContextMenuState {
  x: number;
  y: number;
  terminalId: string;
}

function fileBasename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function formatCost(usd: number): string {
  if (usd <= 0) return '';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

const isMac = navigator.platform.toUpperCase().includes('MAC');

// Width reserved for the "Show Hidden Tabs" chevron in the tab-strip overflow
// calculation. Approx: ChevronDown 13px + 4px gap + badge (min 15px, growing
// with digit count) + 2*8px horizontal padding + 1px left border = ~49px.
// Rounded up to 50 so `computeTabOverflow` doesn't shove the last tab under
// the chevron by a hair.
const CHEVRON_WIDTH = 50;

export function TerminalTabs() {
  const { terminals, activeTerminalId, closeTerminal, unreadTerminalIds, gitInfoCache, scriptChildren, closeScript, setActiveTerminal } = useTerminalStore();
  const { openNewTerminalModal, gridMode, toggleGridMode, addToGrid, gridTerminalIds, splitMode, splitTerminalIds, splitOrientation, splitRatio, setSplitOrientation, setSplitRatio, clearSplit, setSplitTerminals, setSplitMode, openFiles, activeFilePath, setActiveFilePath, closeFileTab, showFileTree, showTabActivity } = useAppStore();
  const pinnedTabIds = useAppStore((s) => s.pinnedTabIds);
  const toggleTabPin = useAppStore((s) => s.toggleTabPin);
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null);
  const now = useNowTick();
  const terminalStates = useTerminalStore((s) => s.terminalStates);
  const justFinishedAt = useTerminalStore((s) => s.justFinishedAt);
  const terminalMetrics = useTerminalStore((s) => s.terminalMetrics);

  // Tab drag/drop + multi-select + tear-off. Keyed on this window's label so a
  // detached window routes transfers from its own identity.
  const { isSelected, isDragging, dragIds, dropIndex, splitDropTargetId, tabHandlers } = useTabDrag(getWindowMode().label, 'main');

  const focusFile = useCallback((path: string) => {
    setActiveFilePath(path);
  }, [setActiveFilePath]);
  // Script-child terminals are rendered below their parent and bottom-pane
  // shells are rendered in BottomTerminalPane - neither belongs in the main
  // tab bar.
  //
  // Pinned tabs are re-ordered to the front of the strip via
  // `orderTabsPinnedFirst` while the terminal store's insertion order stays
  // untouched — pinning is a render-only concern. Drag-reorder still writes to
  // the store via `reorderTerminals`, and the pinned-first partition is
  // re-applied on next render, so dragging can't move a tab across the
  // pinned/unpinned boundary visually.
  const terminalList = useMemo(
    () => {
      const configs = Array.from(terminals.values())
        .filter((t) => !t.scriptParentId && !t.isShellTerminal)
        .map((t) => t.config);
      if (pinnedTabIds.length === 0) return configs;
      const byId = new Map(configs.map((c) => [c.id, c] as const));
      const orderedIds = orderTabsPinnedFirst(configs.map((c) => c.id), pinnedTabIds);
      return orderedIds
        .map((id) => byId.get(id))
        .filter((c): c is NonNullable<typeof c> => c != null);
    },
    [terminals, pinnedTabIds]
  );

  // Slide-aside preview order: while dragging, the dragged tab(s) are pulled out
  // and re-inserted at the drop slot, so the other tabs (motion.li `layout`)
  // physically part to open a gap where the tab will land. The dragged tab(s)
  // render as a faded placeholder = the gap. When the cursor leaves the strip
  // (dropIndex null), the gap stays at its original slot. Commit uses the same
  // index, so dropping produces no jump.
  const renderList = useMemo(() => {
    if (dragIds.length === 0) return terminalList;
    const draggedSet = new Set(dragIds);
    const nonDragged = terminalList.filter((t) => !draggedSet.has(t.id));
    const draggedTabs = terminalList.filter((t) => draggedSet.has(t.id));
    if (draggedTabs.length === 0) return terminalList;
    const firstIdx = terminalList.findIndex((t) => draggedSet.has(t.id));
    const origAt = terminalList.slice(0, firstIdx).filter((t) => !draggedSet.has(t.id)).length;
    const at = dropIndex != null ? Math.max(0, Math.min(dropIndex, nonDragged.length)) : origAt;
    return [...nonDragged.slice(0, at), ...draggedTabs, ...nonDragged.slice(at)];
  }, [terminalList, dragIds, dropIndex]);

  const handleNewTab = () => {
    openNewTerminalModal();
  };

  const handleAddToGrid = (terminalId: string) => {
    addToGrid(terminalId);
    if (!gridMode) {
      toggleGridMode();
    }
  };

  const handleSplitWith = (terminalId: string) => {
    if (activeTerminalId && terminalId !== activeTerminalId) {
      setSplitTerminals([activeTerminalId, terminalId]);
      setSplitMode(true);
    }
  };

  // Wrap `closeTerminal` in the same toast-on-failure / telemetry pattern the
  // rest of the tab strip already uses (see the × button, middle-click close).
  // Used by the context menu's Close / Close Others / Close All But Pinned.
  const closeTerminalWithReport = useCallback((id: string) => {
    closeTerminal(id).catch((err) => {
      toast.error('Close failed', 'Could not close the terminal.');
      reportInvokeFailure('close_terminal', err);
    });
  }, [closeTerminal]);

  const openTabContextMenu = useCallback((e: React.MouseEvent, terminalId: string) => {
    e.preventDefault();
    e.stopPropagation();
    // Clamp against the viewport so the menu doesn't overflow when the
    // right-click lands near the right or bottom edge. Numbers mirror the
    // SessionsPanel pattern — a slight over-estimate is fine, the CSS
    // min-width keeps the menu readable.
    const margin = 4;
    const menuWidth = 220;
    const menuHeight = 200;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - margin);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - margin);
    setContextMenu({ x: Math.max(margin, x), y: Math.max(margin, y), terminalId });
  }, []);

  // Close the tab context menu on outside click / Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-context-menu="terminal-tabs"]')) return;
      setContextMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  const { createTerminal } = useTerminalStore();
  const handleDuplicate = (terminalId: string) => {
    const instance = terminals.get(terminalId);
    if (!instance) return;
    const { label, working_directory, claude_args, env_vars, color_tag, nickname } = instance.config;
    // createTerminal rethrows on spawn failure - catch or the duplicate
    // silently never appears and the rejection goes unhandled.
    createTerminal(
      label,
      working_directory,
      claude_args,
      env_vars,
      color_tag ?? undefined,
      nickname ?? undefined,
    ).catch((err) => {
      toast.error('Duplicate failed', 'Could not start the new terminal.');
      reportInvokeFailure('create_terminal', err);
    });
  };

  // Tab scroll overflow detection
  const tabsContainerRef = useRef<HTMLUListElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Phase 4b Task B: tab-strip overflow measurement.
  // `hiddenTabIds` holds the ids the strip can't fit, so Task C's chevron
  // dropdown can surface them. `chevronWidth` is now the measured
  // `CHEVRON_WIDTH` constant defined at the top of this module.
  const stripRef = useRef<HTMLUListElement | null>(null);
  const [hiddenTabIds, setHiddenTabIds] = useState<string[]>([]);
  const hiddenSet = useMemo(() => new Set(hiddenTabIds), [hiddenTabIds]);

  // Phase 4b Task C: hidden-tabs chevron dropdown state.
  const [hiddenMenuOpen, setHiddenMenuOpen] = useState(false);
  const chevronRef = useRef<HTMLButtonElement | null>(null);

  // Close the "Show Hidden Tabs" dropdown on outside click / Escape. Mirrors
  // the pattern used by the tab-context-menu dismiss above; the chevron
  // button itself is excluded so its own onClick (which toggles the menu)
  // still fires cleanly.
  useEffect(() => {
    if (!hiddenMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (chevronRef.current?.contains(target)) return;
      const menu = document.querySelector('[data-hidden-tabs-menu]');
      if (menu?.contains(target)) return;
      setHiddenMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHiddenMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [hiddenMenuOpen]);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;

    const measure = () => {
      const el = stripRef.current;
      if (!el) return;
      const containerWidth = el.clientWidth;

      const tabIds = terminalList.map((t) => t.id);
      const tabWidths = terminalList.map((t) =>
        estimateTabWidth(t.nickname || t.label, {
          isPinned: pinnedTabIds.includes(t.id),
          hasStatusDot: t.status === 'Running' || t.status === 'Idle',
        })
      );

      const result = computeTabOverflow({
        tabIds,
        activeId: activeTerminalId,
        tabWidths,
        containerWidth,
        chevronWidth: CHEVRON_WIDTH,
        // Approx. two 28px controls (+, grid toggle) + gaps + divider slack.
        // Adjust when the real controls are stabilized.
        reservedRight: 96,
      });

      setHiddenTabIds((prev) => {
        if (
          prev.length === result.hidden.length &&
          prev.every((id, i) => id === result.hidden[i])
        ) {
          return prev;
        }
        return result.hidden;
      });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [terminalList, pinnedTabIds, activeTerminalId]);

  const checkScroll = useCallback(() => {
    const el = tabsContainerRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  useEffect(() => {
    const el = tabsContainerRef.current;
    if (!el) return;
    checkScroll();
    el.addEventListener('scroll', checkScroll, { passive: true });
    const ro = new ResizeObserver(checkScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', checkScroll);
      ro.disconnect();
    };
  }, [checkScroll, terminalList.length]);

  const scrollTabs = (direction: 'left' | 'right') => {
    const el = tabsContainerRef.current;
    if (!el) return;
    el.scrollBy({ left: direction === 'left' ? -200 : 200, behavior: 'smooth' });
  };

  // Keep keyboard focus on the active terminal across tab switches. Every
  // terminal is now permanently mounted (so its xterm + scrollback survive a
  // switch - see the content area below), which means switching tabs only flips
  // visibility; it no longer remounts and auto-focuses the terminal. So focus
  // the newly-shown terminal's xterm here. rAF waits for the visibility flip to
  // paint, since xterm can't focus a `visibility: hidden` textarea.
  useEffect(() => {
    if (!activeTerminalId || activeFilePath) return;
    const id = activeTerminalId;
    const raf = requestAnimationFrame(() => {
      useTerminalStore.getState().terminals.get(id)?.xterm?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [activeTerminalId, activeFilePath]);

  // If split mode is active with valid terminals, show split view
  if (splitMode && splitTerminalIds && terminals.has(splitTerminalIds[0]) && terminals.has(splitTerminalIds[1])) {
    return (
      <div className="h-full flex flex-col">
        {/* Split Toolbar */}
        <div className="h-9 bg-elevation-1 border-b border-[var(--ij-divider)] flex items-center justify-between px-3">
          <div className="flex items-center gap-2">
            <SplitSquareHorizontal size={13} className="text-accent-primary" strokeWidth={1.75} />
            <span className="text-text-primary text-[12px] font-medium">Split View</span>
            <span className="text-text-tertiary text-[11px]">
              {terminals.get(splitTerminalIds[0])?.config.nickname || terminals.get(splitTerminalIds[0])?.config.label}
              {' · '}
              {terminals.get(splitTerminalIds[1])?.config.nickname || terminals.get(splitTerminalIds[1])?.config.label}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip label="Toggle orientation">
            <button
              onClick={() => setSplitOrientation(splitOrientation === 'horizontal' ? 'vertical' : 'horizontal')}
              className="flex items-center gap-1 h-6 px-2 rounded-[4px] text-[11px] text-text-secondary hover:bg-white/[0.06] hover:text-text-primary transition-colors"
            >
              <RotateCw size={12} strokeWidth={1.75} />
              {splitOrientation === 'horizontal' ? 'Vertical' : 'Horizontal'}
            </button>
            </Tooltip>
            <button
              onClick={clearSplit}
              className="flex items-center gap-1 h-6 px-2 rounded-[4px] text-[11px] text-text-secondary hover:bg-white/[0.06] hover:text-text-primary transition-colors"
            >
              <X size={12} strokeWidth={1.75} />
              Exit Split
            </button>
          </div>
        </div>
        <div className="flex-1">
          <SplitView
            terminalIds={splitTerminalIds}
            orientation={splitOrientation}
            ratio={splitRatio}
            onRatioChange={setSplitRatio}
          />
        </div>
      </div>
    );
  }

  // If grid mode is active, show the grid
  if (gridMode) {
    return <TerminalGrid />;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Tab Bar - IntelliJ editor tabs */}
      <div className="h-9 bg-elevation-1 border-b border-[var(--ij-divider)] flex items-center justify-between px-0.5">
        <div className="relative flex items-center flex-1 min-w-0">
          {canScrollLeft && (
            <button
              onClick={() => scrollTabs('left')}
              className="absolute left-0 z-10 h-full px-1 flex items-center bg-gradient-to-r from-elevation-1 via-elevation-1/90 to-transparent"
            >
              <ChevronLeft size={14} className="text-text-secondary" strokeWidth={1.75} />
            </button>
          )}
          <ul
            ref={(node) => {
              tabsContainerRef.current = node;
              stripRef.current = node;
            }}
            data-tab-strip
            className="flex items-center overflow-x-auto scrollbar-none list-none m-0 p-0"
          >
            <AnimatePresence initial={false}>
            {renderList.map((terminal, index) => {
              // Phase 4b Task B: overflow-hidden tabs drop from the render but
              // stay in the enumeration so `index` still matches the drag/drop
              // model. Task C will surface them via a chevron dropdown.
              if (hiddenSet.has(terminal.id)) return null;
              const instance = terminals.get(terminal.id);
              const model = instance?.model;
              const isWorktree = instance?.isWorktree;
              const loopInfo = instance?.loopInfo;
              const lastOutputAt = getLastOutputAt(terminal.id);
              const liveBusy = lastOutputAt != null && now - lastOutputAt < 2000;
              // Prefer the poller's classified state; fall back to the live
              // activity timer so the dot lights up instantly on first output
              // before the first poll tick lands. The 2000ms window here is
              // intentionally wider than the poller's 600ms BUSY_WINDOW_MS to
              // avoid flicker during the brief gap before the poller takes over.
              const sessionState: SessionState =
                terminalStates.get(terminal.id) ?? (liveBusy ? 'busy' : 'idle');
              const isWorking = sessionState === 'busy';
              const isActiveTab = activeTerminalId === terminal.id && !activeFilePath;
              const selected = isSelected(terminal.id);
              const dragged = isDragging(terminal.id);

              return (
              <motion.li
                key={terminal.id}
                layout
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85 }}
                transition={{ type: 'spring', stiffness: 700, damping: 42, mass: 0.6 }}
                className="flex items-center flex-shrink-0"
              >
                <div
                  role="tab"
                  tabIndex={0}
                  aria-selected={isActiveTab}
                  data-dragging={dragged ? '' : undefined}
                  {...tabHandlers(terminal.id, index)}
                  onAuxClick={(e) => {
                    // Middle-click (mouse wheel) closes the tab - same as VS Code.
                    if (e.button === 1) {
                      e.preventDefault();
                      closeTerminal(terminal.id).catch((err) => {
                        toast.error('Close failed', 'Could not close the terminal.');
                        reportInvokeFailure('close_terminal', err);
                      });
                    }
                  }}
                  onContextMenu={(e) => openTabContextMenu(e, terminal.id)}
                  className={`group relative flex items-center gap-2 px-3 h-9 text-[12px] cursor-pointer select-none transition-all duration-150 ${
                    splitDropTargetId === terminal.id
                      ? 'bg-accent-primary/12 text-accent-primary'
                      : isActiveTab
                        ? 'bg-elevation-0 text-text-primary'
                        : 'hover:bg-white/[0.045] text-text-secondary'
                  } ${selected && !isActiveTab ? 'ring-1 ring-inset ring-accent-primary/40' : ''} ${dragged ? 'opacity-20' : ''} ${isWorking && !isActiveTab && showTabActivity ? 'ct-working-tab' : ''} ${
                    justFinishedAt.has(terminal.id) && !isActiveTab ? 'ct-tab-finish-inactive' : ''
                  }`}
                >
                  {/* IntelliJ-style bottom underline for active tab */}
                  {(isActiveTab || splitDropTargetId === terminal.id) && (
                    <span
                      className={`absolute left-2 right-2 bottom-0 h-[2px] rounded-t bg-accent-primary ${
                        justFinishedAt.has(terminal.id) ? 'ct-tab-finish-underline' : ''
                      }`}
                    />
                  )}
                  {splitDropTargetId === terminal.id && (
                    <SplitSquareHorizontal size={12} className="text-accent-primary flex-shrink-0 animate-pulse" />
                  )}
                  {unreadTerminalIds.has(terminal.id) && activeTerminalId !== terminal.id && (
                    <div className="w-1.5 h-1.5 rounded-full bg-accent-primary flex-shrink-0" />
                  )}
                  {sessionState !== 'idle' && showTabActivity && (
                    <StateDot state={sessionState} />
                  )}
                  {terminal.color_tag && (
                    <div className={`w-2 h-2 rounded-full ${terminal.color_tag} flex-shrink-0`} />
                  )}
                  {/* Badges */}
                  {model && (
                    <span className={`text-[9px] px-1 rounded font-medium flex-shrink-0 ${
                      model === 'opus' ? 'bg-purple-500/20 text-purple-400' :
                      model === 'sonnet' ? 'bg-blue-500/20 text-blue-400' :
                      model === 'haiku' ? 'bg-green-500/20 text-green-400' :
                      'bg-white/[0.06] text-text-tertiary'
                    }`}>
                      {model}
                    </span>
                  )}
                  {(() => {
                    const cost = terminalMetrics.get(terminal.id)?.costUsd ?? 0;
                    const label = formatCost(cost);
                    if (!label) return null;
                    return (
                      <Tooltip label="Estimated session cost (live)">
                        <span className="text-[9px] px-1 rounded font-medium flex-shrink-0 bg-emerald-500/15 text-emerald-400 tabular-nums">
                          {label}
                        </span>
                      </Tooltip>
                    );
                  })()}
                  {isWorktree && (
                    <GitBranch size={10} className="text-cyan-400 flex-shrink-0" />
                  )}
                  {loopInfo && (
                    <Tooltip label={`Loop: ${loopInfo.interval}`}>
                      <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse flex-shrink-0" />
                    </Tooltip>
                  )}
                  {pinnedTabIds.includes(terminal.id) && (
                    <Pin size={10} className="text-accent-primary flex-shrink-0" />
                  )}
                  <span className="max-w-[120px] truncate">{terminal.nickname || terminal.label}</span>
                  {gitInfoCache.get(terminal.id)?.current_branch && (
                    <span className={`text-[11px] font-mono max-w-[60px] truncate ${
                      gitInfoCache.get(terminal.id)?.is_worktree ? 'text-purple-400' : 'text-text-tertiary'
                    }`}>
                      {gitInfoCache.get(terminal.id)?.current_branch}
                    </span>
                  )}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    {activeTerminalId && terminal.id !== activeTerminalId && (
                      <Tooltip label="Split with active terminal">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSplitWith(terminal.id);
                          }}
                          className="p-0.5 rounded hover:bg-white/[0.08] text-text-tertiary hover:text-text-secondary transition-colors"
                        >
                          <SplitSquareHorizontal size={12} />
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip label="Duplicate terminal">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDuplicate(terminal.id);
                        }}
                        className="p-0.5 rounded hover:bg-white/[0.08] text-text-tertiary hover:text-text-secondary transition-colors"
                      >
                        <Copy size={12} />
                      </button>
                    </Tooltip>
                    <Tooltip label="Add to grid">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAddToGrid(terminal.id);
                        }}
                        className={`p-0.5 rounded hover:bg-white/[0.08] transition-colors ${
                          gridTerminalIds.includes(terminal.id) ? 'text-accent-primary' : 'text-text-tertiary hover:text-text-secondary'
                        }`}
                      >
                        <Grid3X3 size={12} />
                      </button>
                    </Tooltip>
                    <Tooltip label="Close terminal">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTerminal(terminal.id).catch((err) => {
                            toast.error('Close failed', 'Could not close the terminal.');
                            reportInvokeFailure('close_terminal', err);
                          });
                        }}
                        className="p-0.5 rounded hover:bg-white/[0.08] text-text-tertiary hover:text-text-secondary"
                      >
                        <X size={12} />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              </motion.li>
              );
            })}
            </AnimatePresence>
          </ul>

          {/* Phase 4b Task C: "Show Hidden Tabs" chevron. Rendered only when
              the strip overflowed (Task B's `hiddenTabIds`). Clicking opens a
              floating dropdown below the button with the hidden tabs; picking
              one calls `setActiveTerminal`, which triggers Task A's
              computeTabOverflow to swap it into the visible list on the next
              layout pass. */}
          {hiddenTabIds.length > 0 && (
            <button
              ref={chevronRef}
              onClick={(e) => {
                e.stopPropagation();
                setHiddenMenuOpen((v) => !v);
              }}
              className="no-drag h-[var(--h-tab)] px-2 flex items-center gap-1 text-text-secondary hover:bg-white/[0.06] hover:text-text-primary transition-colors border-l border-[var(--ij-divider-soft)] flex-shrink-0"
              title="Show hidden tabs"
              aria-label={`Show ${hiddenTabIds.length} hidden tab${hiddenTabIds.length === 1 ? '' : 's'}`}
              aria-expanded={hiddenMenuOpen}
            >
              <ChevronDown size={13} strokeWidth={2} />
              <span className="text-[10px] font-semibold px-[5px] h-[15px] min-w-[15px] flex items-center justify-center rounded-full bg-accent-primary text-white">
                {hiddenTabIds.length}
              </span>
            </button>
          )}

          {/* File tabs - rendered inline next to terminal tabs, VS Code style */}
          {openFiles.length > 0 && (
            <>
              {terminalList.length > 0 && (
                <span className="w-px h-5 bg-[var(--ij-divider)] mx-0.5 flex-shrink-0" aria-hidden />
              )}
              <div className="flex items-center flex-shrink-0">
                {openFiles.map((tab) => {
                  const isActive = activeFilePath === tab.path;
                  const dirty = tab.content !== tab.original;
                  return (
                    <Tooltip key={tab.path} label={tab.path}>
                    <button
                      onClick={() => focusFile(tab.path)}
                      onAuxClick={(e) => {
                        if (e.button !== 1) return;
                        e.preventDefault();
                        if (dirty) {
                          const ok = window.confirm(`Discard unsaved changes in ${fileBasename(tab.path)}?`);
                          if (!ok) return;
                        }
                        closeFileTab(tab.path);
                      }}
                      className={`group relative flex items-center gap-1.5 px-3 h-9 text-[12px] transition-colors flex-shrink-0 ${
                        isActive
                          ? 'bg-elevation-0 text-text-primary'
                          : 'hover:bg-white/[0.045] text-text-secondary'
                      }`}
                    >
                      {isActive && (
                        <span className="absolute left-2 right-2 bottom-0 h-[2px] rounded-t bg-accent-primary" />
                      )}
                      <FileIcon size={11} className="text-text-tertiary flex-shrink-0" strokeWidth={1.75} />
                      <span className="max-w-[140px] truncate">{fileBasename(tab.path)}</span>
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          if (dirty) {
                            const ok = window.confirm(`Discard unsaved changes in ${fileBasename(tab.path)}?`);
                            if (!ok) return;
                          }
                          closeFileTab(tab.path);
                        }}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.stopPropagation();
                            closeFileTab(tab.path);
                          }
                        }}
                        className="p-0.5 rounded hover:bg-white/[0.08] text-text-tertiary hover:text-text-primary transition-colors flex items-center justify-center"
                        aria-label={dirty ? 'Unsaved changes' : 'Close'}
                      >
                        {dirty ? (
                          <span className="w-2 h-2 rounded-full bg-accent-primary" />
                        ) : (
                          <X size={12} />
                        )}
                      </span>
                    </button>
                    </Tooltip>
                  );
                })}
              </div>
            </>
          )}

          {canScrollRight && (
            <button
              onClick={() => scrollTabs('right')}
              className="absolute right-8 z-10 h-full px-1 flex items-center bg-gradient-to-l from-elevation-1 via-elevation-1/90 to-transparent"
            >
              <ChevronRight size={14} className="text-text-secondary" />
            </button>
          )}
          <Tooltip label="New Terminal" shortcut="Ctrl+Shift+N">
            <button
              onClick={handleNewTab}
              className="w-7 h-7 ml-0.5 flex items-center justify-center rounded-[4px] hover:bg-white/[0.06] text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
            >
              <Plus size={14} strokeWidth={1.75} />
            </button>
          </Tooltip>
        </div>

        {/* Per-terminal actions: package.json scripts for the active terminal.
            Hidden when the "Project Tools" setting is off. */}
        <div className="flex items-center gap-1 ml-2 flex-shrink-0">
          {showFileTree && activeTerminalId && !activeFilePath && (() => {
            const inst = terminals.get(activeTerminalId);
            if (!inst || inst.scriptParentId) return null;
            return <ScriptsMenu terminalId={activeTerminalId} cwd={inst.config.working_directory} />;
          })()}
        </div>

        {/* Grid Mode Toggle */}
        <div className="flex items-center gap-1 ml-2 mr-1 flex-shrink-0">
          {gridTerminalIds.length > 0 && (
            <span className="text-[10.5px] text-text-tertiary mr-1 uppercase tracking-wide">
              {gridTerminalIds.length} in grid
            </span>
          )}
          <Tooltip label="Toggle Grid View">
            <button
              onClick={toggleGridMode}
              className={`flex items-center gap-1.5 h-7 px-2 rounded-[4px] text-[11.5px] font-medium transition-colors ${
                gridTerminalIds.length > 0
                  ? 'bg-accent-primary/18 text-accent-primary ring-1 ring-inset ring-accent-primary/30 hover:bg-accent-primary/25'
                  : 'hover:bg-white/[0.06] text-text-secondary hover:text-text-primary'
              }`}
            >
              <Grid3X3 size={13} strokeWidth={1.75} />
              <span className="hidden sm:inline">Grid</span>
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Content area - EVERY terminal stays mounted so its xterm instance and
          scrollback survive tab switches; only the active one is visible (the
          rest are `visibility: hidden`, which keeps their layout box sized so
          xterm's fit stays correct, and makes them non-interactive). This
          mirrors grid mode, which already mounts many terminals at once, and
          keeps background terminals' buffers current as their PTYs stream. The
          file editor overlays on top (z-10) when a file tab is active. */}
      <div className="flex-1 relative">
        {terminalList.map((terminal) => {
          const tid = terminal.id;
          const isVisible = tid === activeTerminalId && !activeFilePath;
          const inst = terminals.get(tid);
          const scriptChildId = scriptChildren.get(tid);
          const scriptInst = scriptChildId ? terminals.get(scriptChildId) : null;
          return (
            <div
              key={tid}
              className="absolute inset-0 flex flex-col"
              style={{ visibility: isVisible ? 'visible' : 'hidden' }}
              aria-hidden={!isVisible}
            >
              <div className="flex-1 min-h-0 flex flex-col">
                <TerminalView terminalId={tid} />
              </div>
              {inst?.config.status === 'Stopped' && inst?.sessionSummary && (
                <SessionInsights summary={inst.sessionSummary} />
              )}
              {inst && terminalMetrics.get(tid) && (
                <SessionMetricsPanel terminalId={tid} />
              )}
              {scriptInst && scriptChildId && (
                <ScriptChildPane
                  parentId={tid}
                  childId={scriptChildId}
                  scriptName={scriptInst.scriptName ?? ''}
                  status={scriptInst.config.status}
                  onClose={() => { void closeScript(tid); }}
                />
              )}
            </div>
          );
        })}
        {activeFilePath && openFiles.some((t) => t.path === activeFilePath) && (
          <div key={`file:${activeFilePath}`} className="absolute inset-0 z-10">
            <FileEditorView path={activeFilePath} />
          </div>
        )}
        {!activeTerminalId && !activeFilePath && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-text-secondary p-8">
              <div className="w-full max-w-[560px] flex flex-col items-center">
                {/* Hero header — sketch's "welcome" moment */}
                <img
                  src={appIconUrl}
                  alt=""
                  className="w-14 h-14 rounded-[10px] mb-5 select-none shadow-[0_4px_20px_rgba(0,0,0,0.4)] ring-1 ring-white/[0.05]"
                  draggable={false}
                  style={{ imageRendering: 'pixelated' }}
                />
                <h1 className="text-[length:var(--text-h1)] font-semibold text-text-primary mb-1.5 tracking-tight">
                  Welcome to ClaudeTerminal
                </h1>
                <p className="text-[13px] text-text-tertiary mb-8 text-center max-w-[420px]">
                  Manage multiple Claude Code sessions from a single native window.
                  Start a new terminal, or press{' '}
                  <kbd className="px-1.5 py-0.5 rounded bg-elevation-2 text-text-secondary text-[11px] font-sans border border-[var(--ij-divider-soft)] mx-0.5">
                    {isMac ? '⌘' : 'Ctrl'}
                  </kbd>
                  <kbd className="px-1.5 py-0.5 rounded bg-elevation-2 text-text-secondary text-[11px] font-sans border border-[var(--ij-divider-soft)] mx-0.5">
                    P
                  </kbd>
                  {' '}for Search Everywhere.
                </p>

                {/* Action cards — sketch's "New Project / Open Project" pattern */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full mb-6">
                  <button
                    onClick={handleNewTab}
                    className="group flex flex-col items-start gap-2 p-4 bg-elevation-1 border border-[var(--ij-divider-soft)] rounded-lg hover:border-accent-primary/60 hover:bg-elevation-2 hover:shadow-glow-md transition-all text-left"
                  >
                    <div className="w-9 h-9 rounded-md bg-accent-primary/12 flex items-center justify-center text-accent-primary group-hover:bg-accent-primary/20 transition-colors">
                      <Plus size={18} strokeWidth={2.25} />
                    </div>
                    <div>
                      <div className="text-[13px] font-medium text-text-primary">New Terminal</div>
                      <div className="text-[11.5px] text-text-tertiary mt-0.5">
                        Start a Claude Code session in any folder
                      </div>
                    </div>
                  </button>

                  <button
                    onClick={() => useAppStore.getState().openCommandPalette()}
                    className="group flex flex-col items-start gap-2 p-4 bg-elevation-1 border border-[var(--ij-divider-soft)] rounded-lg hover:border-accent-primary/60 hover:bg-elevation-2 hover:shadow-glow-md transition-all text-left"
                  >
                    <div className="w-9 h-9 rounded-md bg-elevation-3 flex items-center justify-center text-text-secondary group-hover:text-accent-primary transition-colors">
                      <SearchIcon size={16} strokeWidth={2} />
                    </div>
                    <div>
                      <div className="text-[13px] font-medium text-text-primary">Search Everywhere</div>
                      <div className="text-[11.5px] text-text-tertiary mt-0.5">
                        Find sessions, actions, hints, and snippets
                      </div>
                    </div>
                  </button>

                  {terminalList.length > 0 && (
                    <button
                      onClick={toggleGridMode}
                      className="group flex flex-col items-start gap-2 p-4 bg-elevation-1 border border-[var(--ij-divider-soft)] rounded-lg hover:border-accent-primary/60 hover:bg-elevation-2 hover:shadow-glow-md transition-all text-left"
                    >
                      <div className="w-9 h-9 rounded-md bg-elevation-3 flex items-center justify-center text-text-secondary group-hover:text-accent-primary transition-colors">
                        <Grid3X3 size={16} strokeWidth={2} />
                      </div>
                      <div>
                        <div className="text-[13px] font-medium text-text-primary">Grid View</div>
                        <div className="text-[11.5px] text-text-tertiary mt-0.5">
                          Watch up to 8 sessions side-by-side
                        </div>
                      </div>
                    </button>
                  )}

                  <button
                    onClick={() => useAppStore.getState().openSettings()}
                    className="group flex flex-col items-start gap-2 p-4 bg-elevation-1 border border-[var(--ij-divider-soft)] rounded-lg hover:border-accent-primary/60 hover:bg-elevation-2 hover:shadow-glow-md transition-all text-left"
                  >
                    <div className="w-9 h-9 rounded-md bg-elevation-3 flex items-center justify-center text-text-secondary group-hover:text-accent-primary transition-colors">
                      <SlidersHorizontal size={16} strokeWidth={2} />
                    </div>
                    <div>
                      <div className="text-[13px] font-medium text-text-primary">Preferences</div>
                      <div className="text-[11.5px] text-text-tertiary mt-0.5">
                        Theme, accent, density, keybindings
                      </div>
                    </div>
                  </button>
                </div>

                {/* Keyboard shortcut list — IDE-style discovery */}
                <div className="w-full grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px]">
                  <div className="flex items-center justify-between text-text-tertiary">
                    <span>Search Everywhere</span>
                    <span className="flex items-center gap-0.5">
                      <kbd className="px-1 py-0.5 rounded bg-elevation-2 text-text-secondary font-sans border border-[var(--ij-divider-soft)] text-[10px]">
                        {isMac ? '⌘' : 'Ctrl'}
                      </kbd>
                      <span className="text-text-tertiary/60">+</span>
                      <kbd className="px-1 py-0.5 rounded bg-elevation-2 text-text-secondary font-sans border border-[var(--ij-divider-soft)] text-[10px]">P</kbd>
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-text-tertiary">
                    <span>New Terminal</span>
                    <span className="flex items-center gap-0.5">
                      <kbd className="px-1 py-0.5 rounded bg-elevation-2 text-text-secondary font-sans border border-[var(--ij-divider-soft)] text-[10px]">
                        {isMac ? '⌘' : 'Ctrl'}
                      </kbd>
                      <span className="text-text-tertiary/60">+</span>
                      <kbd className="px-1 py-0.5 rounded bg-elevation-2 text-text-secondary font-sans border border-[var(--ij-divider-soft)] text-[10px]">
                        {isMac ? '⇧' : 'Shift'}
                      </kbd>
                      <span className="text-text-tertiary/60">+</span>
                      <kbd className="px-1 py-0.5 rounded bg-elevation-2 text-text-secondary font-sans border border-[var(--ij-divider-soft)] text-[10px]">N</kbd>
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-text-tertiary">
                    <span>Toggle Sidebar</span>
                    <span className="flex items-center gap-0.5">
                      <kbd className="px-1 py-0.5 rounded bg-elevation-2 text-text-secondary font-sans border border-[var(--ij-divider-soft)] text-[10px]">
                        {isMac ? '⌘' : 'Ctrl'}
                      </kbd>
                      <span className="text-text-tertiary/60">+</span>
                      <kbd className="px-1 py-0.5 rounded bg-elevation-2 text-text-secondary font-sans border border-[var(--ij-divider-soft)] text-[10px]">B</kbd>
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-text-tertiary">
                    <span>Toggle Grid</span>
                    <span className="flex items-center gap-0.5">
                      <kbd className="px-1 py-0.5 rounded bg-elevation-2 text-text-secondary font-sans border border-[var(--ij-divider-soft)] text-[10px]">
                        {isMac ? '⌘' : 'Ctrl'}
                      </kbd>
                      <span className="text-text-tertiary/60">+</span>
                      <kbd className="px-1 py-0.5 rounded bg-elevation-2 text-text-secondary font-sans border border-[var(--ij-divider-soft)] text-[10px]">G</kbd>
                    </span>
                  </div>
                </div>
              </div>
            </div>
        )}
      </div>

      {hiddenMenuOpen && chevronRef.current && (() => {
        const rect = chevronRef.current.getBoundingClientRect();
        const menuWidth = 240;
        // Anchor to the chevron's right edge so the menu extends leftward
        // (mirrors Chrome/Edge's overflow tab menu). Clamp against viewport
        // edges so the menu never renders off-screen on a narrow window.
        const left = Math.max(4, rect.right - menuWidth);
        const top = rect.bottom + 4;
        const clampedTop = Math.min(top, window.innerHeight - 200 - 4);
        const clampedLeft = Math.min(Math.max(4, left), window.innerWidth - menuWidth - 4);
        return (
          <div
            data-hidden-tabs-menu
            className="fixed z-[80] bg-bg-elevated ring-1 ring-white/[0.08] rounded-md shadow-elevation-4 py-1 min-w-[240px] max-h-[320px] overflow-y-auto"
            style={{ left: clampedLeft, top: clampedTop }}
            onClick={(e) => e.stopPropagation()}
            role="menu"
          >
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-semibold text-text-tertiary border-b border-[var(--ij-divider-soft)]">
              Hidden Tabs ({hiddenTabIds.length})
            </div>
            {hiddenTabIds.map((id) => {
              const t = terminalList.find((x) => x.id === id);
              if (!t) return null;
              const isPinned = pinnedTabIds.includes(id);
              return (
                <button
                  key={id}
                  role="menuitem"
                  onClick={() => {
                    setActiveTerminal(id);
                    setHiddenMenuOpen(false);
                  }}
                  onContextMenu={(e) => {
                    // Right-click on a hidden tab reaches the same actions as
                    // a visible tab (Pin/Unpin/Close/Close Others/Close All
                    // But Pinned) — otherwise users would have to activate a
                    // hidden tab first, defeating the dropdown's purpose.
                    setHiddenMenuOpen(false);
                    openTabContextMenu(e, id);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-primary hover:bg-white/[0.06] text-left"
                >
                  {isPinned && <Pin size={10} className="text-accent-primary flex-shrink-0" />}
                  <span className="truncate">{t.nickname || t.label}</span>
                </button>
              );
            })}
          </div>
        );
      })()}

      {contextMenu && (() => {
        const ctxId = contextMenu.terminalId;
        const isPinned = pinnedTabIds.includes(ctxId);
        // Terminal-store insertion order is the source of truth for "all
        // terminals" — we deliberately don't reuse `terminalList` here (which
        // has the pinned-first re-order applied), because bulk-close acts on
        // the store, not on the rendered ordering. Filter out script-child /
        // shell terminals for the same reason `terminalList` does: those are
        // rendered elsewhere and shouldn't be touched by the tab-strip menu.
        const allTabIds = Array.from(terminals.values())
          .filter((t) => !t.scriptParentId && !t.isShellTerminal)
          .map((t) => t.config.id);
        return (
          <div
            role="menu"
            data-context-menu="terminal-tabs"
            className="fixed z-[80] min-w-[220px] bg-bg-elevated ring-1 ring-white/[0.08] rounded-md py-1 select-none"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <TabMenuItem
              icon={isPinned ? <PinOff size={13} strokeWidth={1.75} /> : <Pin size={13} strokeWidth={1.75} />}
              label={isPinned ? 'Unpin' : 'Pin'}
              onClick={() => { setContextMenu(null); toggleTabPin(ctxId); }}
            />
            <div className="my-1 border-t border-white/[0.06]" />
            <TabMenuItem
              icon={<X size={13} strokeWidth={1.75} />}
              label="Close"
              onClick={() => { setContextMenu(null); closeTerminalWithReport(ctxId); }}
            />
            <TabMenuItem
              icon={<X size={13} strokeWidth={1.75} />}
              label="Close Others"
              disabled={allTabIds.length <= 1}
              onClick={() => {
                setContextMenu(null);
                idsToCloseForOthers(allTabIds, ctxId).forEach(closeTerminalWithReport);
              }}
            />
            <TabMenuItem
              icon={<X size={13} strokeWidth={1.75} />}
              label="Close All But Pinned"
              disabled={idsToCloseForAllButPinned(allTabIds, pinnedTabIds).length === 0}
              onClick={() => {
                setContextMenu(null);
                idsToCloseForAllButPinned(allTabIds, pinnedTabIds).forEach(closeTerminalWithReport);
              }}
            />
          </div>
        );
      })()}

      <BottomTerminalPane />
    </div>
  );
}

interface TabMenuItemProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

function TabMenuItem({ icon, label, onClick, disabled }: TabMenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] transition-colors ${
        disabled
          ? 'text-text-tertiary/50 cursor-not-allowed'
          : 'text-text-primary hover:bg-white/[0.06]'
      }`}
    >
      <span className={disabled ? 'opacity-50' : 'text-text-tertiary'}>{icon}</span>
      <span className="flex-1">{label}</span>
    </button>
  );
}
