import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Package, Circle, GripHorizontal } from 'lucide-react';
import { TerminalView } from './TerminalView';
import type { TerminalConfig } from '../store/terminalStore';

interface ScriptChildPaneProps {
  parentId: string;
  childId: string;
  scriptName: string;
  status: TerminalConfig['status'];
  onClose: () => void;
}

/**
 * Renders the script-child terminal below the parent terminal, VS Code style.
 * The pane has a drag-to-resize handle at its top so the user can trade space
 * between the parent (Claude) and the script output.
 */
export function ScriptChildPane({ parentId: _parentId, childId, scriptName, status, onClose }: ScriptChildPaneProps) {
  const [height, setHeight] = useState(240); // px
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  const onDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    startYRef.current = e.clientY;
    startHeightRef.current = height;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [height]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = startYRef.current - e.clientY;
      // Clamp height: at least 80px (header + one row), at most 800px.
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

  const statusDot = status === 'Running'
    ? 'bg-success'
    : status === 'Error'
      ? 'bg-error'
      : 'bg-text-tertiary';

  return (
    <>
      {/* Drag handle - same styling as the Sidebar splitter for consistency */}
      <div
        role="separator"
        aria-orientation="horizontal"
        onMouseDown={onDown}
        className="group h-1.5 shrink-0 cursor-row-resize flex items-center justify-center bg-transparent hover:bg-accent-primary/50 active:bg-accent-primary/70 transition-colors"
        title="Drag to resize script output"
      >
        <GripHorizontal size={10} className="text-text-tertiary opacity-0 group-hover:opacity-100 transition-opacity" strokeWidth={1.5} />
      </div>

      <div
        className="shrink-0 flex flex-col border-t border-[var(--ij-divider)] bg-bg-primary"
        style={{ height }}
      >
        {/* Script terminal header */}
        <div className="h-7 flex items-center justify-between px-3 bg-elevation-0 border-b border-[var(--ij-divider-soft)] flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Package size={12} className="text-accent-primary flex-shrink-0" strokeWidth={1.75} />
            <span className="text-[11.5px] font-medium text-text-primary truncate">
              npm run <span className="font-mono text-accent-primary">{scriptName}</span>
            </span>
            <div className="flex items-center gap-1 ml-1">
              <Circle size={7} className={`${statusDot} rounded-full`} fill="currentColor" strokeWidth={0} />
              <span className="text-[10px] text-text-tertiary uppercase tracking-wide">{status}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-0.5 rounded hover:bg-white/[0.08] text-text-tertiary hover:text-text-primary transition-colors"
            title="Stop and close script"
          >
            <X size={13} strokeWidth={1.75} />
          </button>
        </div>

        {/* Child xterm */}
        <div className="flex-1 min-h-0">
          <TerminalView terminalId={childId} />
        </div>
      </div>
    </>
  );
}
