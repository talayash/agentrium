import { useCallback, useEffect, useRef, useState } from 'react';
import { X, GripHorizontal, Plus, TerminalSquare, ChevronDown } from 'lucide-react';
import { useTerminalStore } from '../store/terminalStore';
import { TerminalView } from './TerminalView';

const STATUS_DOT: Record<string, string> = {
  Running: 'bg-success',
  Idle: 'bg-warning',
  Error: 'bg-error',
  Stopped: 'bg-text-tertiary',
};

/**
 * Bottom terminal pane - a tabbed area below the main terminal view that
 * hosts plain interactive shells (no claude). One tab per shell, drag-to-
 * resize handle on top, +/x to add and remove tabs. Mirrors the placement
 * of ScriptChildPane but is global (not scoped to a parent terminal) and
 * stays mounted across active-terminal switches.
 */
export function BottomTerminalPane() {
  const bottomTerminalIds = useTerminalStore((s) => s.bottomTerminalIds);
  const activeBottomTerminalId = useTerminalStore((s) => s.activeBottomTerminalId);
  const terminals = useTerminalStore((s) => s.terminals);
  const setActiveBottomTerminal = useTerminalStore((s) => s.setActiveBottomTerminal);
  const closeShellTerminal = useTerminalStore((s) => s.closeShellTerminal);
  const openShellTerminal = useTerminalStore((s) => s.openShellTerminal);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);

  const [height, setHeight] = useState(280);
  const [collapsed, setCollapsed] = useState(false);
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      startYRef.current = e.clientY;
      startHeightRef.current = height;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [height],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = startYRef.current - e.clientY;
      const next = Math.min(800, Math.max(80, startHeightRef.current + delta));
      setHeight(next);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const handleAddShell = useCallback(async () => {
    // The "+" button opens another shell at the same cwd as the currently-
    // active bottom shell (or the main active terminal as a fallback).
    let cwd: string | null = null;
    let label = 'Shell';
    if (activeBottomTerminalId) {
      const inst = terminals.get(activeBottomTerminalId);
      if (inst) {
        cwd = inst.config.working_directory;
        label = inst.config.label;
      }
    }
    if (!cwd && activeTerminalId) {
      const inst = terminals.get(activeTerminalId);
      if (inst) {
        cwd = inst.config.working_directory;
        label = inst.config.label;
      }
    }
    if (!cwd) return;
    try {
      await openShellTerminal(label, cwd);
    } catch {
      /* errors surface via toast in callers; nothing more to do here */
    }
  }, [activeBottomTerminalId, activeTerminalId, terminals, openShellTerminal]);

  if (bottomTerminalIds.length === 0) return null;

  return (
    <>
      {/* Drag handle - same styling as the ScriptChildPane handle */}
      <div
        role="separator"
        aria-orientation="horizontal"
        onMouseDown={onDragStart}
        className="group h-1.5 shrink-0 cursor-row-resize flex items-center justify-center bg-transparent hover:bg-accent-primary/50 active:bg-accent-primary/70 transition-colors"
        title="Drag to resize bottom terminals"
      >
        <GripHorizontal
          size={10}
          className="text-text-tertiary opacity-0 group-hover:opacity-100 transition-opacity"
          strokeWidth={1.5}
        />
      </div>

      <div
        className="shrink-0 flex flex-col border-t border-seam-strong bg-bg-primary"
        style={{ height: collapsed ? 28 : height }}
      >
        {/* Tab strip */}
        <div className="h-7 flex items-center border-b border-seam bg-elevation-0 flex-shrink-0">
          <div className="flex-1 min-w-0 flex items-center overflow-x-auto">
            {bottomTerminalIds.map((id) => {
              const inst = terminals.get(id);
              if (!inst) return null;
              const isActive = id === activeBottomTerminalId;
              const dotClass = STATUS_DOT[inst.config.status] ?? 'bg-text-tertiary';
              return (
                <div
                  key={id}
                  onClick={() => {
                    setActiveBottomTerminal(id);
                    if (collapsed) setCollapsed(false);
                  }}
                  className={`group/tab flex items-center gap-1.5 h-7 px-2.5 cursor-pointer border-r border-seam text-[11.5px] flex-shrink-0 transition-colors ${
                    isActive
                      ? 'bg-bg-primary text-text-primary'
                      : 'text-text-secondary hover:bg-fill-hover hover:text-text-primary'
                  }`}
                  title={inst.config.working_directory}
                >
                  <TerminalSquare size={11} strokeWidth={1.75} className="text-accent-primary flex-shrink-0" />
                  <span className="truncate max-w-[180px]">{inst.config.label}</span>
                  <span
                    className={`w-[6px] h-[6px] rounded-full flex-shrink-0 ${dotClass}`}
                    title={inst.config.status}
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeShellTerminal(id);
                    }}
                    className="ml-0.5 p-0.5 rounded hover:bg-fill-active text-text-tertiary hover:text-text-primary opacity-0 group-hover/tab:opacity-100 transition-opacity"
                    title="Close terminal"
                  >
                    <X size={11} strokeWidth={1.75} />
                  </button>
                </div>
              );
            })}
            <button
              onClick={handleAddShell}
              className="h-7 px-2 flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-fill-hover transition-colors flex-shrink-0"
              title="New shell terminal at the active terminal's working directory"
            >
              <Plus size={12} strokeWidth={2} />
            </button>
          </div>
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="h-7 px-2 flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-fill-hover transition-colors flex-shrink-0 border-l border-seam"
            title={collapsed ? 'Expand bottom terminals' : 'Collapse bottom terminals'}
          >
            <ChevronDown
              size={12}
              strokeWidth={1.75}
              className={`transition-transform ${collapsed ? '' : 'rotate-180'}`}
            />
          </button>
        </div>

        {/* Active terminal view - only one is mounted at a time. Each tab has
            its own xterm instance via TerminalView, scrollback survives by
            being driven from the store buffers. */}
        {!collapsed && (
          <div className="flex-1 min-h-0 relative">
            {bottomTerminalIds.map((id) => (
              <div
                key={id}
                className="absolute inset-0"
                style={{ display: id === activeBottomTerminalId ? 'block' : 'none' }}
              >
                <TerminalView terminalId={id} />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
