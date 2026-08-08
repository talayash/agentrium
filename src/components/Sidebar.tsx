import { useCallback, useEffect, useRef } from 'react';
import { ChevronsLeft, ChevronsRight, FolderTree } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { computeSidebarSectionStyles } from '../lib/sidebarLayout';
import { FileTreePanel } from './FileTreePanel';
import { SessionsPanel } from './SessionsPanel';
import { Tooltip } from './ui/Tooltip';
import { PanelHeader } from './ui/PanelHeader';

export function Sidebar() {
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebarCollapse = useAppStore((s) => s.toggleSidebarCollapse);
  const showFileTree = useAppStore((s) => s.showFileTree);
  const sessionsCollapsed = useAppStore((s) => s.sessionsCollapsed);
  const explorerCollapsed = useAppStore((s) => s.explorerCollapsed);
  const sessionsHeightRatio = useAppStore((s) => s.sessionsHeightRatio);
  const setSessionsHeightRatio = useAppStore((s) => s.setSessionsHeightRatio);

  const stackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const onSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const el = stackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.height <= 0) return;
      const y = e.clientY - rect.top;
      setSessionsHeightRatio(y / rect.height);
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
  }, [setSessionsHeightRatio]);

  if (sidebarCollapsed) {
    return (
      <div
        className="h-full bg-elevation-1 border-r border-[var(--ij-divider)] flex flex-col items-center py-2 gap-0.5"
        style={{ width: 'var(--w-rail)' }}
      >
        <Tooltip label="Expand Sidebar" side="right">
          <button
            onClick={toggleSidebarCollapse}
            className="w-8 h-8 flex items-center justify-center rounded-[6px] hover:bg-white/[0.06] text-text-tertiary hover:text-text-secondary transition-colors"
          >
            <ChevronsRight size={14} strokeWidth={1.75} />
          </button>
        </Tooltip>
      </div>
    );
  }

  // Layout rules for the stacked Sessions / Explorer sections live in
  // `lib/sidebarLayout.ts` (unit-tested). `showFileTree` gating stays here
  // because it's a store lookup; we pass the resolved boolean into the helper.
  const sessionsExpanded = !sessionsCollapsed;
  const explorerExpanded = !explorerCollapsed && showFileTree;
  const bothExpanded = sessionsExpanded && explorerExpanded;
  const { sessionsStyle, explorerStyle } = computeSidebarSectionStyles({
    sessionsExpanded,
    explorerExpanded,
    sessionsHeightRatio,
  });

  return (
    <div className="h-full bg-elevation-1 border-r border-[var(--ij-divider)] flex flex-col">
      <PanelHeader
        title={
          <>
            <FolderTree size={12} strokeWidth={1.75} />
            Project
          </>
        }
        actions={
          <Tooltip label="Collapse Sidebar">
            <button
              onClick={toggleSidebarCollapse}
              className="w-6 h-6 flex items-center justify-center rounded-[4px] hover:bg-white/[0.06] text-text-tertiary hover:text-text-secondary transition-colors"
            >
              <ChevronsLeft size={13} strokeWidth={1.75} />
            </button>
          </Tooltip>
        }
      />

      <div ref={stackRef} className="flex-1 min-h-0 flex flex-col">
        <div
          style={sessionsStyle}
          className="flex flex-col min-h-0 overflow-hidden border-b border-[var(--ij-divider-soft)]"
        >
          <SessionsPanel />
        </div>

        {bothExpanded && (
          <div
            onMouseDown={onSplitterMouseDown}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Drag to resize Sessions / Explorer"
            className="h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-accent-primary/50 active:bg-accent-primary/70 transition-colors"
          />
        )}

        <div style={explorerStyle} className="flex flex-col min-h-0 overflow-hidden">
          {showFileTree ? (
            <FileTreePanel />
          ) : (
            <div className="flex-1 flex items-center justify-center px-4 text-center">
              <p className="text-text-tertiary text-[12px]">
                Explorer is disabled. Enable it in Settings &rarr; Appearance &amp; Behavior.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
