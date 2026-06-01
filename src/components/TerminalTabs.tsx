import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { Reorder } from 'framer-motion';
import { X, Plus, Grid3X3, SplitSquareHorizontal, RotateCw, GitBranch, ChevronLeft, ChevronRight, Copy, File as FileIcon } from 'lucide-react';
import appIconUrl from '../assets/app-icon.png';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { TerminalView } from './TerminalView';
import { TerminalGrid } from './TerminalGrid';
import { SplitView } from './SplitView';
import { SessionInsights } from './SessionInsights';
import { FileEditorView } from './FileEditorView';
import { ScriptsMenu } from './ScriptsMenu';
import { ScriptChildPane } from './ScriptChildPane';
import { BottomTerminalPane } from './BottomTerminalPane';
import { getDragData, isTerminalDrag } from '../utils/dragDrop';
import { useNowTick } from '../hooks/useNowTick';
import { getLastOutputAt } from '../lib/terminalActivity';
import { StateDot } from './StateDot';
import type { SessionState } from '../lib/terminalState';

function fileBasename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

const isMac = navigator.platform.toUpperCase().includes('MAC');

export function TerminalTabs() {
  const { terminals, activeTerminalId, setActiveTerminal, closeTerminal, unreadTerminalIds, gitInfoCache, reorderTerminals, scriptChildren, closeScript } = useTerminalStore();
  const { openNewTerminalModal, gridMode, toggleGridMode, addToGrid, gridTerminalIds, splitMode, splitTerminalIds, splitOrientation, splitRatio, setSplitOrientation, setSplitRatio, clearSplit, setSplitTerminals, setSplitMode, openFiles, activeFilePath, setActiveFilePath, closeFileTab, showFileTree } = useAppStore();
  const now = useNowTick();
  const terminalStates = useTerminalStore((s) => s.terminalStates);

  // Selecting a terminal clears the file-tab focus (so terminal view shows),
  // selecting a file clears the terminal focus-visual intent.
  const focusTerminal = useCallback((id: string) => {
    setActiveFilePath(null);
    setActiveTerminal(id);
  }, [setActiveFilePath, setActiveTerminal]);

  const focusFile = useCallback((path: string) => {
    setActiveFilePath(path);
  }, [setActiveFilePath]);
  // Script-child terminals are rendered below their parent and bottom-pane
  // shells are rendered in BottomTerminalPane — neither belongs in the main
  // tab bar.
  const terminalList = useMemo(
    () =>
      Array.from(terminals.values())
        .filter((t) => !t.scriptParentId && !t.isShellTerminal)
        .map((t) => t.config),
    [terminals]
  );

  const handleNewTab = () => {
    openNewTerminalModal();
  };

  const handleAddToGrid = (terminalId: string) => {
    addToGrid(terminalId);
    if (!gridMode) {
      toggleGridMode();
    }
  };

  const [splitDropTargetId, setSplitDropTargetId] = useState<string | null>(null);

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

  const handleTabDragOver = useCallback((e: React.DragEvent, tabTerminalId: string) => {
    if (isTerminalDrag(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setSplitDropTargetId(tabTerminalId);
    }
  }, []);

  const handleTabDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setSplitDropTargetId(null);
    }
  }, []);

  const handleTabDrop = useCallback((e: React.DragEvent, tabTerminalId: string) => {
    e.preventDefault();
    setSplitDropTargetId(null);
    const payload = getDragData(e);
    if (!payload || payload.terminalId === tabTerminalId) return;
    setSplitTerminals([tabTerminalId, payload.terminalId]);
    setSplitMode(true);
  }, [setSplitTerminals, setSplitMode]);

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
            <button
              onClick={() => setSplitOrientation(splitOrientation === 'horizontal' ? 'vertical' : 'horizontal')}
              className="flex items-center gap-1 h-6 px-2 rounded-[4px] text-[11px] text-text-secondary hover:bg-white/[0.06] hover:text-text-primary transition-colors"
              title="Toggle orientation"
            >
              <RotateCw size={12} strokeWidth={1.75} />
              {splitOrientation === 'horizontal' ? 'Vertical' : 'Horizontal'}
            </button>
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
      {/* Tab Bar — IntelliJ editor tabs */}
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
          <Reorder.Group
            ref={tabsContainerRef}
            axis="x"
            values={terminalList}
            onReorder={(next) => reorderTerminals(next.map((t) => t.id))}
            className="flex items-center overflow-x-auto scrollbar-none"
          >
            {terminalList.map((terminal) => {
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

              return (
              <Reorder.Item
                key={terminal.id}
                value={terminal}
                className="flex-shrink-0"
              >
                <button
                  onClick={() => focusTerminal(terminal.id)}
                  onAuxClick={(e) => {
                    // Middle-click (mouse wheel) closes the tab — same as VS Code.
                    if (e.button === 1) {
                      e.preventDefault();
                      closeTerminal(terminal.id);
                    }
                  }}
                  onDragOver={(e) => handleTabDragOver(e, terminal.id)}
                  onDragLeave={handleTabDragLeave}
                  onDrop={(e) => handleTabDrop(e, terminal.id)}
                  className={`group relative flex items-center gap-2 px-3 h-9 text-[12px] transition-colors ${
                    splitDropTargetId === terminal.id
                      ? 'bg-accent-primary/12 text-accent-primary'
                      : activeTerminalId === terminal.id && !activeFilePath
                        ? 'bg-elevation-0 text-text-primary'
                        : 'hover:bg-white/[0.045] text-text-secondary'
                  } ${isWorking && !isActiveTab ? 'ct-working-tab' : ''}`}
                >
                  {/* IntelliJ-style bottom underline for active tab */}
                  {((activeTerminalId === terminal.id && !activeFilePath) || splitDropTargetId === terminal.id) && (
                    <span className="absolute left-2 right-2 bottom-0 h-[2px] rounded-t bg-accent-primary" />
                  )}
                  {splitDropTargetId === terminal.id && (
                    <SplitSquareHorizontal size={12} className="text-accent-primary flex-shrink-0 animate-pulse" />
                  )}
                  {unreadTerminalIds.has(terminal.id) && activeTerminalId !== terminal.id && (
                    <div className="w-1.5 h-1.5 rounded-full bg-accent-primary flex-shrink-0" />
                  )}
                  {sessionState !== 'idle' && (
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
                  {isWorktree && (
                    <GitBranch size={10} className="text-cyan-400 flex-shrink-0" />
                  )}
                  {loopInfo && (
                    <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse flex-shrink-0" title={`Loop: ${loopInfo.interval}`} />
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
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSplitWith(terminal.id);
                        }}
                        className="p-0.5 rounded hover:bg-white/[0.08] text-text-tertiary hover:text-text-secondary transition-colors"
                        title="Split with active terminal"
                      >
                        <SplitSquareHorizontal size={12} />
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDuplicate(terminal.id);
                      }}
                      className="p-0.5 rounded hover:bg-white/[0.08] text-text-tertiary hover:text-text-secondary transition-colors"
                      title="Duplicate terminal"
                    >
                      <Copy size={12} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAddToGrid(terminal.id);
                      }}
                      className={`p-0.5 rounded hover:bg-white/[0.08] transition-colors ${
                        gridTerminalIds.includes(terminal.id) ? 'text-accent-primary' : 'text-text-tertiary hover:text-text-secondary'
                      }`}
                      title="Add to grid"
                    >
                      <Grid3X3 size={12} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTerminal(terminal.id);
                      }}
                      className="p-0.5 rounded hover:bg-white/[0.08] text-text-tertiary hover:text-text-secondary"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </button>
              </Reorder.Item>
              );
            })}
          </Reorder.Group>

          {/* File tabs — rendered inline next to terminal tabs, VS Code style */}
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
                    <button
                      key={tab.path}
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
                      title={tab.path}
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
                        title={dirty ? 'Unsaved changes' : 'Close'}
                      >
                        {dirty ? (
                          <span className="w-2 h-2 rounded-full bg-accent-primary" />
                        ) : (
                          <X size={12} />
                        )}
                      </span>
                    </button>
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
          <button
            onClick={handleNewTab}
            className="w-7 h-7 ml-0.5 flex items-center justify-center rounded-[4px] hover:bg-white/[0.06] text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
            title="New Terminal"
          >
            <Plus size={14} strokeWidth={1.75} />
          </button>
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
          <button
            onClick={toggleGridMode}
            className={`flex items-center gap-1.5 h-7 px-2 rounded-[4px] text-[11.5px] font-medium transition-colors ${
              gridTerminalIds.length > 0
                ? 'bg-accent-primary/18 text-accent-primary ring-1 ring-inset ring-accent-primary/30 hover:bg-accent-primary/25'
                : 'hover:bg-white/[0.06] text-text-secondary hover:text-text-primary'
            }`}
            title="Toggle Grid View"
          >
            <Grid3X3 size={13} strokeWidth={1.75} />
            <span className="hidden sm:inline">Grid</span>
          </button>
        </div>
      </div>

      {/* Content area — terminal stays mounted so scrollback survives the
          switch; the file editor overlays on top when a file tab is active. */}
      <div className="flex-1 relative">
        {activeTerminalId && (() => {
          const scriptChildId = scriptChildren.get(activeTerminalId);
          const scriptInst = scriptChildId ? terminals.get(scriptChildId) : null;
          return (
            <div
              key={activeTerminalId}
              className="absolute inset-0 flex flex-col"
              style={{ visibility: activeFilePath ? 'hidden' : 'visible' }}
              aria-hidden={!!activeFilePath}
            >
              <div className="flex-1 min-h-0 flex flex-col">
                <TerminalView terminalId={activeTerminalId} />
              </div>
              {(() => {
                const inst = terminals.get(activeTerminalId);
                if (inst?.config.status === 'Stopped' && inst?.sessionSummary) {
                  return <SessionInsights summary={inst.sessionSummary} />;
                }
                return null;
              })()}
              {scriptInst && scriptChildId && (
                <ScriptChildPane
                  parentId={activeTerminalId}
                  childId={scriptChildId}
                  scriptName={scriptInst.scriptName ?? ''}
                  status={scriptInst.config.status}
                  onClose={() => { void closeScript(activeTerminalId); }}
                />
              )}
            </div>
          );
        })()}
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
                <button
                  onClick={handleNewTab}
                  className="flex items-center gap-2 bg-accent-primary hover:bg-accent-secondary text-white h-8 px-4 rounded-[6px] text-[12.5px] font-medium transition-colors shadow-[0_1px_0_rgba(255,255,255,0.08)_inset]"
                >
                  <Plus size={14} strokeWidth={2.25} />
                  New Terminal
                </button>
                {terminalList.length > 0 && (
                  <button
                    onClick={toggleGridMode}
                    className="flex items-center gap-2 ring-1 ring-inset ring-[var(--ij-divider)] hover:bg-white/[0.05] text-text-primary h-8 px-4 rounded-[6px] text-[12.5px] font-medium transition-colors"
                  >
                    <Grid3X3 size={14} strokeWidth={1.75} />
                    Grid View
                  </button>
                )}
              </div>
            </div>
        )}
      </div>

      <BottomTerminalPane />
    </div>
  );
}
