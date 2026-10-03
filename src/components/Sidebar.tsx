import { Terminal, FolderTree, History, Plus, ChevronsRight, ChevronsLeft, Settings, Bell, GitBranch, Flag, UserCog } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import type { SidebarNav } from '../store/appStore';
import { FileTreePanel } from './FileTreePanel';
import { SessionsPanel } from './SessionsPanel';
import { SessionCards } from './SessionCards';
import { RaceSidebarGroups } from './RaceSidebarGroups';
import { RaceHistory } from './RaceHistory';
import { useTerminalStore } from '../store/terminalStore';
import { Tooltip } from './ui/Tooltip';
import { AttentionInbox } from './AttentionInbox';
import { useAttentionStore } from '../store/attentionStore';

interface NavItem {
  id: SidebarNav;
  label: string;
  Icon: LucideIcon;
}

const NAV: NavItem[] = [
  { id: 'sessions', label: 'Sessions', Icon: Terminal },
  { id: 'files', label: 'Files', Icon: FolderTree },
  { id: 'history', label: 'History', Icon: History },
  { id: 'attention', label: 'Attention inbox', Icon: Bell },
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
  const openNewTaskModal = useAppStore((s) => s.openNewTaskModal);
  const openNewRaceModal = useAppStore((s) => s.openNewRaceModal);
  const sessionFilter = useAppStore((s) => s.sessionFilter);
  const setSessionFilter = useAppStore((s) => s.setSessionFilter);
  const taskCount = useTerminalStore((s) => {
    let n = 0;
    for (const t of s.terminals.values()) if (t.config.task) n++;
    return n;
  });
  const openSettings = useAppStore((s) => s.openSettings);
  const openProfileModal = useAppStore((s) => s.openProfileModal);
  const sessionCount = useTerminalStore((s) => s.terminals.size);
  const attentionCount = useAttentionStore((s) => s.items.length);

  if (sidebarCollapsed) {
    return (
      <div className="h-full material-chrome flex flex-col items-center py-2 gap-1" style={{ width: 'var(--w-rail)' }}>
        {NAV.map(({ id, label, Icon }) => (
          <Tooltip key={id} label={label} side="right">
            <button
              onClick={() => { setNav(id); toggleSidebarCollapse(); }}
              aria-label={id === 'attention' ? `${label} (${attentionCount})` : label}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-text-tertiary hover:text-text-primary hover:bg-fill-hover transition-colors"
            >
              <Icon size={16} strokeWidth={1.75} />
              {id === 'attention' && attentionCount > 0 && <span className="text-[10px] text-accent-primary">{attentionCount}</span>}
            </button>
          </Tooltip>
        ))}
        <div className="mt-auto flex flex-col items-center gap-1">
          <Tooltip label="Profiles" side="right">
            <button
              onClick={() => openProfileModal()}
              aria-label="Profiles"
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-fill-hover text-text-tertiary hover:text-text-secondary transition-colors"
            >
              <UserCog size={15} strokeWidth={1.75} />
            </button>
          </Tooltip>
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
                aria-label={id === 'attention' ? `${label} (${attentionCount})` : label}
                className={`flex-1 h-9 rounded-lg flex items-center justify-center transition-[background-color,color,transform] duration-100 active:scale-[0.96] ${
                  on
                    ? 'bg-accent-primary text-white shadow-[0_3px_8px_var(--accent-glow-md)]'
                    : 'text-text-tertiary hover:text-text-primary hover:bg-fill-hover'
                }`}
              >
                <Icon size={16} strokeWidth={on ? 2 : 1.75} />
                {id === 'attention' && attentionCount > 0 && <span className="ml-1 text-[10px]">{attentionCount}</span>}
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
              <div className="ml-auto flex gap-0.5 normal-case tracking-normal font-medium" role="radiogroup" aria-label="Session filter">
                {(['all', 'tasks'] as const).map((f) => (
                  <button
                    key={f}
                    role="radio"
                    aria-checked={sessionFilter === f}
                    onClick={() => setSessionFilter(f)}
                    className={`px-1.5 h-[18px] rounded-md text-[10.5px] transition-colors ${
                      sessionFilter === f ? 'bg-fill-active text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
                    }`}
                  >
                    {f === 'all' ? 'All' : `Tasks${taskCount > 0 ? ` ${taskCount}` : ''}`}
                  </button>
                ))}
              </div>
            </div>
            <RaceSidebarGroups />
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
        {nav === 'history' && (
          <div className="flex-1 min-h-0 flex flex-col">
            <RaceHistory />
            <SessionsPanel />
          </div>
        )}
        {nav === 'attention' && <AttentionInbox />}
      </div>

      {/* Prominent primary action + profiles + settings */}
      <div className="p-2 flex flex-col gap-1.5">
        <button
          onClick={(e) => {
            // Blur the trigger BEFORE the modal opens - without this, the modal's
            // focus trap releases back to this button on close, and if the user
            // then presses Enter (expecting it to reach the newly-created
            // terminal) the browser dispatches a synthetic click and re-opens
            // the modal. Focus travels through the modal's own auto-focus and
            // eventually into xterm; the blur just makes sure the button isn't
            // the default target if some path skips that. See #58.
            e.currentTarget.blur();
            openNewTerminalModal();
          }}
          className="w-full h-9 rounded-xl bg-accent-primary text-white text-[13px] font-semibold flex items-center justify-center gap-2 shadow-[0_4px_12px_var(--accent-glow-md)] hover:bg-accent-secondary active:scale-[0.98] transition-[background-color,transform] duration-100"
        >
          <Plus size={15} strokeWidth={2.5} />
          New Session
        </button>
        {/* One style per row: filled primary, ringed secondary creates, ghost navigation. */}
        <div className="flex gap-1.5">
          <button
            onClick={(e) => { e.currentTarget.blur(); openNewTaskModal(); }}
            aria-label="New Task"
            aria-keyshortcuts="Control+Shift+T"
            className="flex-1 min-w-0 h-[34px] rounded-xl ring-1 ring-seam text-text-primary hover:bg-fill-hover text-[12.5px] font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-[background-color,transform] duration-100"
          >
            <GitBranch size={14} strokeWidth={1.9} />
            Task
          </button>
          <button
            onClick={(e) => { e.currentTarget.blur(); openNewRaceModal(); }}
            aria-label="New Race"
            aria-keyshortcuts="Control+Shift+R"
            className="flex-1 min-w-0 h-[34px] rounded-xl ring-1 ring-seam text-text-primary hover:bg-fill-hover text-[12.5px] font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-[background-color,transform] duration-100"
          >
            <Flag size={14} strokeWidth={1.9} />
            Race
          </button>
        </div>
        <div className="h-px bg-seam mx-1" aria-hidden="true" />
        <div className="flex gap-1.5">
          <button
            // No-arg call opens the profile manager list; passing the click event
            // through would be read as a profileId and open the focused editor.
            onClick={(e) => { e.currentTarget.blur(); openProfileModal(); }}
            className="flex-1 min-w-0 h-8 rounded-xl text-text-secondary hover:text-text-primary hover:bg-fill-hover text-[12.5px] font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-[background-color,color,transform] duration-100"
          >
            <UserCog size={14} strokeWidth={1.9} />
            Profiles
          </button>
          <button
            onClick={openSettings}
            aria-keyshortcuts="Control+,"
            className="flex-1 min-w-0 h-8 rounded-xl text-text-secondary hover:text-text-primary hover:bg-fill-hover text-[12.5px] font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition-[background-color,color,transform] duration-100"
          >
            <Settings size={14} strokeWidth={1.9} />
            Settings
          </button>
        </div>
      </div>
    </div>
  );
}
