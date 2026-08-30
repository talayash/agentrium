import { Terminal, FolderTree, History, Plus, ChevronsRight, ChevronsLeft, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import type { SidebarNav } from '../store/appStore';
import { FileTreePanel } from './FileTreePanel';
import { SessionsPanel } from './SessionsPanel';
import { SessionCards } from './SessionCards';
import { useTerminalStore } from '../store/terminalStore';
import { Tooltip } from './ui/Tooltip';

interface NavItem {
  id: SidebarNav;
  label: string;
  Icon: LucideIcon;
}

const NAV: NavItem[] = [
  { id: 'sessions', label: 'Sessions', Icon: Terminal },
  { id: 'files', label: 'Files', Icon: FolderTree },
  { id: 'history', label: 'History', Icon: History },
];

/**
 * Unified adaptive sidebar (Apple/Xcode navigator model). A segmented switcher
 * at the top swaps a single column between Sessions (open terminals as cards),
 * Files (explorer tree), and History (resumable sessions on disk). Replaces
 * the old icon-rail + stacked Sessions/Explorer layout.
 */
export function Sidebar() {
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebarCollapse = useAppStore((s) => s.toggleSidebarCollapse);
  const showFileTree = useAppStore((s) => s.showFileTree);
  const nav = useAppStore((s) => s.sidebarNav);
  const setNav = useAppStore((s) => s.setSidebarNav);
  const openNewTerminalModal = useAppStore((s) => s.openNewTerminalModal);
  const openSettings = useAppStore((s) => s.openSettings);
  const sessionCount = useTerminalStore((s) => s.terminals.size);

  if (sidebarCollapsed) {
    return (
      <div className="h-full material-chrome flex flex-col items-center py-2 gap-1" style={{ width: 'var(--w-rail)' }}>
        {NAV.map(({ id, label, Icon }) => (
          <Tooltip key={id} label={label} side="right">
            <button
              onClick={() => { setNav(id); toggleSidebarCollapse(); }}
              aria-label={label}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-text-tertiary hover:text-text-primary hover:bg-fill-hover transition-colors"
            >
              <Icon size={16} strokeWidth={1.75} />
            </button>
          </Tooltip>
        ))}
        <div className="mt-auto flex flex-col items-center gap-1">
          <Tooltip label="Settings" side="right">
            <button
              onClick={openSettings}
              aria-label="Settings"
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-fill-hover text-text-tertiary hover:text-text-secondary transition-colors"
            >
              <Settings size={15} strokeWidth={1.75} />
            </button>
          </Tooltip>
          <Tooltip label="Expand Sidebar" side="right">
            <button
              onClick={toggleSidebarCollapse}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-fill-hover text-text-tertiary hover:text-text-secondary transition-colors"
            >
              <ChevronsRight size={15} strokeWidth={1.75} />
            </button>
          </Tooltip>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full material-chrome flex flex-col">
      {/* Navigator switcher + collapse control (the collapse affordance lives
          IN the sidebar - the titlebar logo is a brand mark, not a toggle). */}
      <div className="flex gap-1 p-2 items-center">
        {NAV.map(({ id, label, Icon }) => {
          const on = nav === id;
          return (
            <Tooltip key={id} label={label}>
              <button
                onClick={() => setNav(id)}
                aria-pressed={on}
                aria-label={label}
                className={`flex-1 h-9 rounded-lg flex items-center justify-center transition-[background-color,color,transform] duration-100 active:scale-[0.96] ${
                  on
                    ? 'bg-accent-primary text-white shadow-[0_3px_8px_var(--accent-glow-md)]'
                    : 'text-text-tertiary hover:text-text-primary hover:bg-fill-hover'
                }`}
              >
                <Icon size={16} strokeWidth={on ? 2 : 1.75} />
              </button>
            </Tooltip>
          );
        })}
        <Tooltip label="Collapse Sidebar">
          <button
            onClick={toggleSidebarCollapse}
            aria-label="Collapse Sidebar"
            className="w-7 h-9 flex items-center justify-center rounded-lg text-text-tertiary hover:text-text-secondary hover:bg-fill-hover transition-colors flex-shrink-0"
          >
            <ChevronsLeft size={14} strokeWidth={1.75} />
          </button>
        </Tooltip>
      </div>

      {/* Body - one navigator at a time */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {nav === 'sessions' && (
          <>
            <div className="flex items-center gap-1.5 px-4 pt-1 pb-1.5 text-text-tertiary text-[11px] font-semibold uppercase tracking-[0.06em]">
              Sessions
              {sessionCount > 0 && (
                <span className="text-text-tertiary/70 text-[10.5px] tabular-nums normal-case tracking-normal font-normal">
                  {sessionCount}
                </span>
              )}
            </div>
            <SessionCards />
          </>
        )}
        {nav === 'files' && (
          showFileTree ? (
            <FileTreePanel />
          ) : (
            <div className="flex-1 flex items-center justify-center px-4 text-center">
              <p className="text-text-tertiary text-[12px]">
                Explorer is disabled. Enable it in Settings &rarr; Appearance &amp; Behavior.
              </p>
            </div>
          )
        )}
        {nav === 'history' && <SessionsPanel />}
      </div>

      {/* Prominent primary action + settings */}
      <div className="p-2 flex flex-col gap-1.5">
        <button
          onClick={() => openNewTerminalModal()}
          className="w-full h-10 rounded-xl bg-accent-primary text-white text-[13px] font-semibold flex items-center justify-center gap-2 shadow-[0_4px_12px_var(--accent-glow-md)] hover:bg-accent-secondary active:scale-[0.98] transition-[background-color,transform] duration-100"
        >
          <Plus size={15} strokeWidth={2.5} />
          New Session
        </button>
        <button
          onClick={openSettings}
          aria-keyshortcuts="Control+,"
          className="w-full h-9 rounded-xl text-text-secondary hover:text-text-primary hover:bg-fill-hover text-[12.5px] font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-[background-color,color,transform] duration-100"
        >
          <Settings size={14} strokeWidth={1.9} />
          Settings
        </button>
      </div>
    </div>
  );
}
