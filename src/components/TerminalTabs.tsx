import { useMemo, useCallback, useEffect } from 'react';
import { X, Grid3X3, SplitSquareHorizontal, RotateCw, GitBranch, File as FileIcon } from 'lucide-react';
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
import { WelcomeScreen } from './WelcomeScreen';
import { ScriptsMenu } from './ScriptsMenu';
import { ScriptChildPane } from './ScriptChildPane';
import { BottomTerminalPane } from './BottomTerminalPane';
import { useNowTick } from '../hooks/useNowTick';
import { getLastOutputAt } from '../lib/terminalActivity';
import { StateDot } from './StateDot';
import { BrandIcon } from './BrandIcon';
import { specFor } from '../lib/agents';
import { getAnyModelBadgeClasses, getModelBadgeLabel } from '../lib/agentModels';
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

/**
 * The session-first main area. Session switching lives in the sidebar's
 * SessionCards (the old horizontal tab strip is gone - one switcher, not
 * two); this component renders a clean session HEADER for the active
 * session (agent · name · folder · branch · status · cost), the open-file
 * pills, and the terminal content underneath. Grid and split modes replace
 * the whole area when active.
 */
export function TerminalTabs() {
  const { terminals, activeTerminalId, scriptChildren, closeScript, closeTerminal } = useTerminalStore();
  const { gridMode, toggleGridMode, gridTerminalIds, splitMode, splitTerminalIds, splitOrientation, splitRatio, setSplitOrientation, setSplitRatio, clearSplit, openFiles, activeFilePath, setActiveFilePath, closeFileTab, showFileTree, showTabActivity } = useAppStore();
  const now = useNowTick();
  const terminalStates = useTerminalStore((s) => s.terminalStates);
  const terminalMetrics = useTerminalStore((s) => s.terminalMetrics);
  const gitInfoCache = useTerminalStore((s) => s.gitInfoCache);

  const focusFile = useCallback((path: string) => {
    setActiveFilePath(path);
  }, [setActiveFilePath]);

  // Close the active session from the header (#59). Mirrors the sidebar
  // SessionCards' `closeWithReport` so error handling + telemetry stay
  // consistent with the existing close paths (per CLAUDE.md's frontend
  // error-handling rules).
  const closeActiveSession = useCallback(() => {
    const id = activeTerminalId;
    if (!id) return;
    closeTerminal(id).catch((err) => {
      toast.error('Close failed', 'Could not close the session.');
      reportInvokeFailure('close_terminal', err);
    });
  }, [activeTerminalId, closeTerminal]);

  // Script-child terminals are rendered below their parent and bottom-pane
  // shells are rendered in BottomTerminalPane - neither belongs in the main
  // content stack.
  const terminalList = useMemo(
    () =>
      Array.from(terminals.values())
        .filter((t) => !t.scriptParentId && !t.isShellTerminal)
        .map((t) => t.config),
    [terminals]
  );

  // Keep keyboard focus on the active terminal across session switches. Every
  // terminal is permanently mounted (so its xterm + scrollback survive a
  // switch - see the content area below), which means switching only flips
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
        <div className="py-1.5 px-3 border-b border-seam flex items-center justify-between">
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
              className="flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px] text-text-secondary hover:bg-fill-hover hover:text-text-primary transition-colors"
            >
              <RotateCw size={12} strokeWidth={1.75} />
              {splitOrientation === 'horizontal' ? 'Vertical' : 'Horizontal'}
            </button>
            </Tooltip>
            <button
              onClick={clearSplit}
              className="flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px] text-text-secondary hover:bg-fill-hover hover:text-text-primary transition-colors"
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

  const activeInst = activeTerminalId ? terminals.get(activeTerminalId) : null;
  const activeConfig = activeInst?.config;
  const showHeader = Boolean(activeConfig) || openFiles.length > 0;

  // Live session state for the header dot: prefer the poller's classified
  // state; fall back to the live activity timer so the dot lights up
  // instantly on first output before the first poll tick lands.
  let headerState: SessionState = 'idle';
  if (activeConfig) {
    const lastOutputAt = getLastOutputAt(activeConfig.id);
    const liveBusy = lastOutputAt != null && now - lastOutputAt < 2000;
    headerState = terminalStates.get(activeConfig.id) ?? (liveBusy ? 'busy' : 'idle');
  }
  const headerCost = activeConfig ? formatCost(terminalMetrics.get(activeConfig.id)?.costUsd ?? 0) : '';
  const headerGit = activeConfig ? gitInfoCache.get(activeConfig.id) : undefined;

  return (
    <div className="h-full flex flex-col">
      {/* Clean session header - identity of the ACTIVE session only. Switching
          sessions happens in the sidebar's SessionCards; open files render as
          pills after the divider. */}
      {showHeader && (
        <div className="py-1.5 px-2.5 border-b border-seam flex items-center gap-2 min-w-0">
          {activeConfig && (
            <div
              className={`flex items-center gap-2 min-w-0 ${activeFilePath ? 'opacity-60' : ''}`}
              data-session-header
            >
              {headerState !== 'idle' && showTabActivity && <StateDot state={headerState} />}
              <Tooltip label={`Agent: ${specFor(activeConfig.agent).displayName}`}>
                <span className="flex-shrink-0 flex items-center">
                  <BrandIcon kind={activeConfig.agent} size={15} />
                </span>
              </Tooltip>
              <span className="text-[13px] font-medium text-text-primary max-w-[220px] truncate">
                {activeConfig.nickname || activeConfig.label}
              </span>
              {activeConfig.working_directory && (
                <span className="text-[11px] text-text-tertiary max-w-[160px] truncate">
                  {fileBasename(activeConfig.working_directory)}
                </span>
              )}
              {/* Branch deliberately absent: the interactive branch switcher
                  lives in the titlebar directly above and the status bar
                  carries the rich chip (dirty/ahead/behind) - a third static
                  copy here was duplication. Worktree sessions still get a
                  subtle fork glyph. */}
              {headerGit?.is_worktree && (
                <Tooltip label={`Worktree · ${headerGit.current_branch ?? ''}`}>
                  <GitBranch size={11} className="text-purple-400 flex-shrink-0" />
                </Tooltip>
              )}
              {activeInst?.model && (
                <span className={`text-[9px] px-1.5 h-[16px] flex items-center rounded-md font-medium flex-shrink-0 ${getAnyModelBadgeClasses(activeInst.model)}`}>
                  {getModelBadgeLabel(activeInst.model)}
                </span>
              )}
              {headerCost && (
                <Tooltip label="Estimated session cost (live)">
                  <span className="text-[9px] px-1.5 h-[16px] flex items-center rounded-md font-medium flex-shrink-0 bg-emerald-500/15 text-emerald-400 tabular-nums">
                    {headerCost}
                  </span>
                </Tooltip>
              )}
              {activeInst?.loopInfo && (
                <Tooltip label={`Loop: ${activeInst.loopInfo.interval}`}>
                  <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse flex-shrink-0" />
                </Tooltip>
              )}
            </div>
          )}

          {/* Open-file pills */}
          {openFiles.length > 0 && (
            <>
              {activeConfig && (
                <span className="w-px h-5 bg-seam-strong mx-1 flex-shrink-0" aria-hidden />
              )}
              <div className="flex items-center gap-1 min-w-0 overflow-x-auto scrollbar-none">
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
                      className={`group relative flex items-center gap-1.5 px-2.5 h-7 rounded-[10px] text-[12px] transition-colors flex-shrink-0 ${
                        isActive
                          ? 'bg-fill-active text-text-primary ring-1 ring-inset ring-seam-strong'
                          : 'hover:bg-fill-hover text-text-secondary'
                      }`}
                    >
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
                        className="p-0.5 rounded hover:bg-fill-active text-text-tertiary hover:text-text-primary transition-colors flex items-center justify-center"
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

          {/* Right cluster: project scripts + grid toggle + close active */}
          <div className="ml-auto flex items-center gap-1 flex-shrink-0">
            {showFileTree && activeTerminalId && !activeFilePath && (() => {
              const inst = terminals.get(activeTerminalId);
              if (!inst || inst.scriptParentId) return null;
              return <ScriptsMenu terminalId={activeTerminalId} cwd={inst.config.working_directory} />;
            })()}
            {gridTerminalIds.length > 0 && (
              <span className="text-[10.5px] text-text-tertiary mr-1 uppercase tracking-wide">
                {gridTerminalIds.length} in grid
              </span>
            )}
            <Tooltip label="Toggle Grid View">
              <button
                onClick={toggleGridMode}
                className={`flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11.5px] font-medium transition-colors ${
                  gridTerminalIds.length > 0
                    ? 'bg-accent-primary/18 text-accent-primary ring-1 ring-inset ring-accent-primary/30 hover:bg-accent-primary/25'
                    : 'hover:bg-fill-hover text-text-secondary hover:text-text-primary'
                }`}
              >
                <Grid3X3 size={13} strokeWidth={1.75} />
                <span className="hidden sm:inline">Grid</span>
              </button>
            </Tooltip>
            {/* Close active session (#59). Only visible while a real terminal
                is focused - hidden while browsing a file, and hidden entirely
                when there is no active session. Mirrors the sidebar card X,
                which also closes without a confirm. */}
            {activeConfig && !activeFilePath && (
              <Tooltip label="Close Session">
                <button
                  onClick={closeActiveSession}
                  aria-label="Close Session"
                  aria-keyshortcuts="Control+W"
                  className="flex items-center justify-center h-7 w-7 rounded-lg text-[11.5px] font-medium hover:bg-fill-hover text-text-secondary hover:text-text-primary transition-colors"
                >
                  <X size={13} strokeWidth={1.75} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      )}

      {/* Content area - EVERY terminal stays mounted so its xterm instance and
          scrollback survive session switches; only the active one is visible
          (the rest are `visibility: hidden`, which keeps their layout box sized
          so xterm's fit stays correct, and makes them non-interactive). This
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
        {!activeTerminalId && !activeFilePath && <WelcomeScreen />}
      </div>

      <BottomTerminalPane />
    </div>
  );
}
