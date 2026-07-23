import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Plus, Grid3X3, SplitSquareHorizontal, RotateCw, GitBranch, ChevronLeft, ChevronRight, Copy, File as FileIcon } from 'lucide-react';
import appIconUrl from '../assets/app-icon.png';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { Button } from './ui/Button';
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
import { StateDot } from './StateDot';
import { Tooltip } from './ui/Tooltip';
import type { SessionState } from '../lib/terminalState';

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

export function TerminalTabs() {
  const { terminals, activeTerminalId, closeTerminal, unreadTerminalIds, gitInfoCache, scriptChildren, closeScript } = useTerminalStore();
  const { openNewTerminalModal, gridMode, toggleGridMode, addToGrid, gridTerminalIds, splitMode, splitTerminalIds, splitOrientation, splitRatio, setSplitOrientation, setSplitRatio, clearSplit, setSplitTerminals, setSplitMode, openFiles, activeFilePath, setActiveFilePath, closeFileTab, showFileTree, showTabActivity } = useAppStore();
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
  const terminalList = useMemo(
    () =>
      Array.from(terminals.values())
        .filter((t) => !t.scriptParentId && !t.isShellTerminal)
        .map((t) => t.config),
    [terminals]
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

  const { createTerminal } = useTerminalStore();
  const handleDuplicate = (terminalId: string) => {
    const instance = terminals.get(terminalId);
    if (!instance) return;
    const { label, working_directory, claude_args, env_vars, color_tag, nickname } = instance.config;
    createTerminal(
      label,
      working_directory,
      claude_args,
      env_vars,
      color_tag ?? undefined,
      nickname ?? undefined,
    );
  };

  // Tab scroll overflow detection
  const tabsContainerRef = useRef<HTMLUListElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

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
            ref={tabsContainerRef}
            data-tab-strip
            className="flex items-center overflow-x-auto scrollbar-none list-none m-0 p-0"
          >
            <AnimatePresence initial={false}>
            {renderList.map((terminal, index) => {
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
                      closeTerminal(terminal.id);
                    }
                  }}
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
                          closeTerminal(terminal.id);
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
            <div className="absolute inset-0 flex flex-col items-center justify-center text-text-secondary">
              <img
                src={appIconUrl}
                alt=""
                className="w-12 h-12 rounded-[8px] mb-5 select-none shadow-[0_2px_12px_rgba(0,0,0,0.35)]"
                draggable={false}
                style={{ imageRendering: 'pixelated' }}
              />
              <p className="text-[13px] text-text-primary font-medium mb-1">No active terminal</p>
              <p className="text-[12px] text-text-tertiary mb-5 flex items-center">
                <span className="mr-1.5">Press</span>
                <kbd className="px-1.5 py-0.5 rounded bg-elevation-2 text-text-secondary text-[11px] font-sans border border-[var(--ij-divider-soft)]">
                  {isMac ? '⌘' : 'Ctrl'}
                </kbd>
                <span className="mx-1 text-text-tertiary/60">+</span>
                <kbd className="px-1.5 py-0.5 rounded bg-elevation-2 text-text-secondary text-[11px] font-sans border border-[var(--ij-divider-soft)]">
                  {isMac ? '⇧' : 'Shift'}
                </kbd>
                <span className="mx-1 text-text-tertiary/60">+</span>
                <kbd className="px-1.5 py-0.5 rounded bg-elevation-2 text-text-secondary text-[11px] font-sans border border-[var(--ij-divider-soft)]">
                  N
                </kbd>
                <span className="ml-2">to start one</span>
              </p>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  onClick={handleNewTab}
                  icon={<Plus size={14} strokeWidth={2.25} />}
                >
                  New Terminal
                </Button>
                {terminalList.length > 0 && (
                  <Button
                    variant="secondary"
                    onClick={toggleGridMode}
                    icon={<Grid3X3 size={14} strokeWidth={1.75} />}
                  >
                    Grid View
                  </Button>
                )}
              </div>
            </div>
        )}
      </div>

      <BottomTerminalPane />
    </div>
  );
}
