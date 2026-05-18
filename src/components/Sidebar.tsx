import { useCallback, useEffect, useRef } from 'react';
import { ChevronsLeft, ChevronsRight, FolderTree } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { FileTreePanel } from './FileTreePanel';
import { SessionsPanel } from './SessionsPanel';

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
        style={{ width: 48 }}
      >
        <button
          onClick={toggleSidebarCollapse}
          className="w-8 h-8 flex items-center justify-center rounded-[6px] hover:bg-white/[0.06] text-text-tertiary hover:text-text-secondary transition-colors"
          title="Expand sidebar"
        >
          <ChevronsRight size={14} strokeWidth={1.75} />
        </button>
      </div>
    );
  }

  // Layout rules for the stacked Sessions / Explorer sections:
  // - A collapsed section is auto-sized to just its header (flex-shrink-0).
  // - When both are expanded, they share space by `sessionsHeightRatio`; a
  //   thin drag handle between them updates the ratio live.
  // - When one is collapsed and the other isn't, the expanded one takes all
  //   remaining space.
  const sessionsExpanded = !sessionsCollapsed;
  const explorerExpanded = !explorerCollapsed && showFileTree;
  const bothExpanded = sessionsExpanded && explorerExpanded;
  const sessionsStyle: React.CSSProperties = !sessionsExpanded
    ? { flex: '0 0 auto' }
    : bothExpanded
    ? { flex: `${sessionsHeightRatio} 1 0`, minHeight: 80 }
    : { flex: '1 1 0' };
  const explorerStyle: React.CSSProperties = !explorerExpanded
    ? { flex: '0 0 auto' }
    : bothExpanded
    ? { flex: `${1 - sessionsHeightRatio} 1 0`, minHeight: 80 }
    : { flex: '1 1 0' };

  return (
    <div className="h-full bg-elevation-1 border-r border-[var(--ij-divider)] flex flex-col">
      <div className="flex items-center justify-between h-[30px] px-3 border-b border-[var(--ij-divider-soft)]">
        <span className="flex items-center gap-1.5 text-text-secondary text-[11px] font-semibold uppercase tracking-[0.06em]">
          <FolderTree size={12} strokeWidth={1.75} />
          Project
        </span>
        <button
          onClick={toggleSidebarCollapse}
          className="w-6 h-6 flex items-center justify-center rounded-[4px] hover:bg-white/[0.06] text-text-tertiary hover:text-text-secondary transition-colors"
          title="Collapse sidebar"
        >
          <ChevronsLeft size={13} strokeWidth={1.75} />
        </button>
      </div>

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
            title="Drag to resize Sessions / Explorer"
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
