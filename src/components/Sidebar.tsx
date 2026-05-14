import { ChevronsLeft, ChevronsRight, FolderTree } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { FileTreePanel } from './FileTreePanel';

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebarCollapse, showFileTree } = useAppStore();

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

      <div className="flex-1 min-h-0 flex flex-col">
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
  );
}
