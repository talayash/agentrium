import { useMemo, useCallback, useEffect } from 'react';
import { X, SplitSquareHorizontal, RotateCw, File as FileIcon, Flag } from 'lucide-react';
import { useTerminalStore } from '../store/terminalStore';
import { focusTerminalInput } from '../lib/terminalFocus';
import { useAppStore } from '../store/appStore';
import { confirmAction } from '../lib/confirmDialog';
import { TerminalView } from './TerminalView';
import { TerminalGrid } from './TerminalGrid';
import { SplitView } from './SplitView';
import { SessionInsights } from './SessionInsights';
import { SessionMetricsPanel } from './SessionMetricsPanel';
import { FileEditorView } from './FileEditorView';
import { WelcomeScreen } from './WelcomeScreen';
import { ScriptChildPane } from './ScriptChildPane';
import { BottomTerminalPane } from './BottomTerminalPane';
import { Tooltip } from './ui/Tooltip';
import { RaceGridHeader } from './RaceHeader';
import { RaceCompareView } from './RaceCompareView';

function fileBasename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * The session-first main area. Session switching lives in the sidebar's
 * SessionCards (the old horizontal tab strip is gone - one switcher, not
 * two); the active session's identity and actions live in the TitleBar
 * row (titlebar/SessionHeader.tsx). This component renders the open-file
 * pills and the terminal content underneath. Grid and split modes replace
 * the whole area when active.
 */
export function TerminalTabs() {
  const { terminals, activeTerminalId, scriptChildren, closeScript } = useTerminalStore();
  const { gridMode, splitMode, splitTerminalIds, splitOrientation, splitRatio, setSplitOrientation, setSplitRatio, clearSplit, openFiles, activeFilePath, setActiveFilePath, closeFileTab } = useAppStore();
  const terminalMetrics = useTerminalStore((s) => s.terminalMetrics);

  const focusFile = useCallback((path: string) => {
    setActiveFilePath(path);
  }, [setActiveFilePath]);

  const requestCloseFile = async (path: string) => {
    const tab = useAppStore.getState().openFiles.find(t => t.path === path);
    if (tab && tab.content !== tab.original) {
      const ok = await confirmAction(`Discard unsaved changes in ${fileBasename(path)}?`, { okLabel: 'Discard' });
      if (!ok) return;
    }
    closeFileTab(path);
  };

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
      // Insight mode routes to the prompt bar, never the hidden PTY.
      focusTerminalInput(id);
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
    return (
      <div className="h-full flex flex-col">
        <RaceGridHeader />
        <div className="flex-1 min-h-0">
          <TerminalGrid />
        </div>
      </div>
    );
  }


  return (
    <div className="h-full flex flex-col">
      {/* Open-file pills. The active session identity and actions live in the
          TitleBar row above (one merged band), so this strip only appears
          while files are open. */}
      {openFiles.length > 0 && (
        <div className="py-1 px-2.5 bg-elevation-1 border-b border-seam-strong flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1 min-w-0 overflow-x-auto scrollbar-none">
            {openFiles.map((tab) => {
              const isActive = activeFilePath === tab.path;
              const isRace = tab.mode === 'race';
              const dirty = !isRace && tab.content !== tab.original;
              return (
                <Tooltip key={tab.path} label={isRace ? `Race: ${tab.content}` : tab.path}>
                <button
                  onClick={() => focusFile(tab.path)}
                  onAuxClick={(e) => {
                    if (e.button !== 1) return;
                    e.preventDefault();
                    requestCloseFile(tab.path);
                  }}
                  className={`group relative flex items-center gap-1.5 px-2.5 h-7 rounded-[10px] text-[12px] transition-colors flex-shrink-0 ${
                    isActive
                      ? 'bg-fill-active text-text-primary ring-1 ring-inset ring-seam-strong'
                      : 'hover:bg-fill-hover text-text-secondary'
                  }`}
                >
                  {isRace
                    ? <Flag size={11} className="text-accent-primary flex-shrink-0" strokeWidth={1.75} />
                    : <FileIcon size={11} className="text-text-tertiary flex-shrink-0" strokeWidth={1.75} />}
                  <span className="max-w-[140px] truncate">{isRace ? tab.content : fileBasename(tab.path)}</span>
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      requestCloseFile(tab.path);
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        requestCloseFile(tab.path);
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
          <div key={`file:${activeFilePath}`} className="absolute inset-0 z-10 bg-elevation-0">
            {openFiles.find((t) => t.path === activeFilePath)?.mode === 'race'
              ? <RaceCompareView raceId={activeFilePath.slice('race:'.length)} />
              : <FileEditorView path={activeFilePath} />}
          </div>
        )}
        {!activeTerminalId && !activeFilePath && <WelcomeScreen />}
      </div>

      <BottomTerminalPane />
    </div>
  );
}
