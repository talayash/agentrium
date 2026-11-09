import { useEffect, useRef, useState } from 'react';
import { Terminal, FolderTree, History, Plus, ChevronsRight, ChevronsLeft, ChevronDown, Settings, GitBranch, Flag, UserCog } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import type { SidebarNav } from '../store/appStore';
import { FileTreePanel } from './FileTreePanel';
import { SessionsPanel } from './SessionsPanel';
import { SessionCards } from './SessionCards';
import { RaceSidebarGroups } from './RaceSidebarGroups';
import { RaceHistory } from './RaceHistory';
import { useTerminalStore } from '../store/terminalStore';
import { IconTile } from './ui/IconTile';
import { Tooltip } from './ui/Tooltip';

interface NavItem {
  id: SidebarNav;
  label: string;
  Icon: LucideIcon;
  /** Glyph hue: `--nav-<hue>` in index.css. One colour per navigator so the
   *  three read apart at a glance. */
  hue: 'sessions' | 'files' | 'history';
}

const NAV: NavItem[] = [
  { id: 'sessions', label: 'Sessions', Icon: Terminal, hue: 'sessions' },
  { id: 'files', label: 'Files', Icon: FolderTree, hue: 'files' },
  { id: 'history', label: 'History', Icon: History, hue: 'history' },
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

  if (sidebarCollapsed) {
    return (
      <div className="h-full flex flex-col items-center py-2 gap-1" style={{ width: 'var(--w-rail)' }}>
        {NAV.map(({ id, label, Icon, hue }) => (
          <Tooltip key={id} label={label} side="right">
            <button
              onClick={() => { setNav(id); toggleSidebarCollapse(); }}
              aria-label={label}
              data-hue={hue}
              className="sidebar-nav-rail w-8 h-8 flex items-center justify-center rounded-lg"
            >
              <Icon size={16} strokeWidth={1.75} />
            </button>
          </Tooltip>
        ))}
        <div className="mt-auto flex flex-col items-center gap-1">
          <Tooltip label="Profiles" side="right">
            <button
              onClick={() => openProfileModal()}
              aria-label="Profiles"
              data-tone="user"
              className="tone-btn w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
            >
              <UserCog size={15} strokeWidth={1.75} />
            </button>
          </Tooltip>
          <Tooltip label="Settings" side="right">
            <button
              onClick={openSettings}
              aria-label="Settings"
              data-tone="user"
              className="tone-btn w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
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
    <div className="h-full flex flex-col">
      {/* Navigator switcher + collapse control (the collapse affordance lives
          IN the sidebar - the titlebar logo is a brand mark, not a toggle). */}
      <div className="flex gap-1 p-2 items-center">
        {/* Same recessed track + raised thumb as the toolbar's view switch,
            but each glyph keeps its own hue (`.sidebar-nav*` in index.css). */}
        <div className="sidebar-nav flex-1 min-w-0" role="group" aria-label="Navigator">
          {NAV.map(({ id, label, Icon, hue }) => {
            const on = nav === id;
            return (
              <Tooltip key={id} label={label}>
                <button
                  onClick={() => setNav(id)}
                  aria-pressed={on}
                  aria-label={label}
                  data-hue={hue}
                  className="sidebar-nav-tab"
                >
                  <Icon size={15} strokeWidth={on ? 2 : 1.75} />
                  <span className="sidebar-nav-label">{label}</span>
                </button>
              </Tooltip>
            );
          })}
        </div>
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
      </div>

      {/* One row: split New Session (Task / Race in its menu) + Profiles and
          Settings as icons, so the session list keeps the vertical space. */}
      <div className="sidebar-footer p-2 flex items-center gap-1.5">
        <NewSessionSplitButton
          onNewSession={openNewTerminalModal}
          onNewTask={openNewTaskModal}
          onNewRace={openNewRaceModal}
        />
        <Tooltip label="Profiles">
          <button
            // No-arg call opens the profile manager list; passing the click event
            // through would be read as a profileId and open the focused editor.
            onClick={(e) => { e.currentTarget.blur(); openProfileModal(); }}
            aria-label="Profiles"
            data-tone="user"
            className="tone-btn w-9 h-9 flex items-center justify-center rounded-full flex-shrink-0 transition-colors"
          >
            <UserCog size={16} strokeWidth={1.75} />
          </button>
        </Tooltip>
        <Tooltip label="Settings">
          <button
            onClick={openSettings}
            aria-label="Settings"
            aria-keyshortcuts="Control+,"
            data-tone="user"
            className="tone-btn w-9 h-9 flex items-center justify-center rounded-full flex-shrink-0 transition-colors"
          >
            <Settings size={16} strokeWidth={1.75} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

interface SplitProps {
  onNewSession: () => void;
  onNewTask: () => void;
  onNewRace: () => void;
}

/**
 * Primary "New Session" with a caret that opens Task / Race above it. Every
 * trigger blurs itself before its modal opens: otherwise the modal's focus
 * trap hands focus back to the button on close, and an Enter meant for the new
 * terminal re-clicks it and reopens the modal (#58).
 */
function NewSessionSplitButton({ onNewSession, onNewTask, onNewRace }: SplitProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (e: React.MouseEvent<HTMLButtonElement>, action: () => void) => {
    e.currentTarget.blur();
    setOpen(false);
    action();
  };

  const itemClass =
    'w-full h-9 px-2 rounded-lg flex items-center gap-2.5 whitespace-nowrap text-[12.5px] font-medium text-text-primary hover:bg-fill-hover transition-colors';

  return (
    <div ref={rootRef} className="relative flex-1 min-w-0">
      {open && (
        <div role="menu" aria-label="Start something new" className="material-popover absolute bottom-full left-0 right-0 mb-1.5 rounded-xl p-1 z-20">
          <button role="menuitem" aria-label="New Task" aria-keyshortcuts="Control+Shift+T" onClick={(e) => pick(e, onNewTask)} className={itemClass}>
            <IconTile icon={GitBranch} tone="green" size={18} />
            Task
            <kbd className="split-menu-kbd ml-auto pl-2 text-[10px] font-mono text-text-tertiary">Ctrl+Shift+T</kbd>
          </button>
          <button role="menuitem" aria-label="New Race" aria-keyshortcuts="Control+Shift+R" onClick={(e) => pick(e, onNewRace)} className={itemClass}>
            <IconTile icon={Flag} tone="orange" size={18} />
            Race
            <kbd className="split-menu-kbd ml-auto pl-2 text-[10px] font-mono text-text-tertiary">Ctrl+Shift+R</kbd>
          </button>
        </div>
      )}
      <div className="glass-capsule glass-capsule-accent w-full h-9">
        <button
          onClick={(e) => { e.currentTarget.blur(); setOpen(false); onNewSession(); }}
          aria-label="New Session"
          className="flex-1 min-w-0 h-8 rounded-full flex items-center justify-center gap-1.5 whitespace-nowrap overflow-hidden text-white text-[13px] font-semibold active:translate-y-px transition-transform duration-100"
        >
          <Plus size={15} strokeWidth={2.5} className="flex-shrink-0" />
          <span>New<span className="new-session-word"> Session</span></span>
        </button>
        <span className="w-px h-5 bg-white/30 flex-shrink-0" aria-hidden="true" />
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="More ways to start"
          aria-haspopup="menu"
          aria-expanded={open}
          className="w-7 h-8 rounded-full flex items-center justify-center text-white/90 hover:text-white flex-shrink-0"
        >
          <ChevronDown size={14} strokeWidth={2.25} className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
    </div>
  );
}
