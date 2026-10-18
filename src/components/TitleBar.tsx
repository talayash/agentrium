import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import appIcon from '../assets/app-icon.png';
import {
  GitBranch,
  ChevronDown,
  Check,
  Loader2,
  Search as SearchIcon,
  Upload,
  PanelRight,
} from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { UpdatePill } from './UpdatePill';
import { WaitingPill } from './titlebar/WaitingPill';
import { TrafficLights, CaptionButtons, isMac } from './titlebar/WindowControls';
import { HeaderAuth } from './HeaderAuth';
import { SyncStatusChip } from './SyncStatusChip';
import { Tooltip } from './ui/Tooltip';
import { ThemeToggle } from './ui/ThemeToggle';
import { ListRow } from './ui/ListRow';
import { pickBreadcrumb } from '../lib/breadcrumb';


/**
 * Concentric Toolbar: there is no title bar. This renders an absolutely
 * positioned row of glass capsules that floats over the top edge of the
 * content cards (App.tsx reserves --h-toolbar at the top of each card). The
 * row itself is the window drag region; only its controls are no-drag.
 */
export function TitleBar() {
  const { triggerChangesRefresh } = useAppStore();
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const { terminals, activeTerminalId, gitInfoCache } = useTerminalStore();
  const fetchGitInfo = useTerminalStore.getState().fetchGitInfo;
  // Inspector state - one titlebar toggle; the tab switcher lives inside
  // the Inspector itself.
  const changesOpen = useAppStore((s) => s.changesOpen);
  const workspacesOpen = useAppStore((s) => s.workspacesOpen);
  const hintsOpen = useAppStore((s) => s.hintsOpen);
  const toggleChanges = useAppStore((s) => s.toggleChanges);
  const toggleWorkspaces = useAppStore((s) => s.toggleWorkspaces);
  const toggleHints = useAppStore((s) => s.toggleHints);
  const learnOpen = useAppStore((s) => s.learnOpen);
  const learnEnabled = useAppStore((s) => s.learnEnabled);
  const toggleLearn = useAppStore((s) => s.toggleLearn);
  const inspectorOpen = changesOpen || workspacesOpen || hintsOpen || (learnOpen && learnEnabled);
  const toggleInspector = () => {
    if (changesOpen) toggleChanges();
    else if (workspacesOpen) toggleWorkspaces();
    else if (hintsOpen) toggleHints();
    else if (learnOpen) toggleLearn();
    else toggleChanges();
  };
  const appWindow = getCurrentWindow();
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [checkoutTarget, setCheckoutTarget] = useState<string | null>(null);
  const [branchFilter, setBranchFilter] = useState('');
  const branchMenuRef = useRef<HTMLDivElement>(null);

  const active = activeTerminalId ? terminals.get(activeTerminalId) : null;
  const gitInfo = activeTerminalId ? gitInfoCache.get(activeTerminalId) : null;
  const breadcrumb = useMemo(
    () => pickBreadcrumb(active?.config.working_directory),
    [active?.config.working_directory]
  );

  const openBranchMenu = useCallback(async () => {
    if (!active?.config.working_directory) return;
    setBranchMenuOpen(true);
    setBranchFilter('');
    setBranchesLoading(true);
    try {
      const list = await invoke<string[]>('get_repo_branches', {
        path: active.config.working_directory,
      });
      setBranches(list);
    } catch (err) {
      toast.error('Branches', typeof err === 'string' ? err : 'Failed to list branches');
      setBranchMenuOpen(false);
    } finally {
      setBranchesLoading(false);
    }
  }, [active?.config.working_directory]);

  const handleCheckout = useCallback(async (branch: string) => {
    if (!active?.config.working_directory || !activeTerminalId) return;
    if (branch === gitInfo?.current_branch) { setBranchMenuOpen(false); return; }
    setCheckoutTarget(branch);
    try {
      await invoke('checkout_branch', {
        path: active.config.working_directory,
        branch,
      });
      toast.success('Checkout', `Switched to ${branch}`);
      setBranchMenuOpen(false);
      await fetchGitInfo(activeTerminalId);
      triggerChangesRefresh();
    } catch (err) {
      toast.error('Checkout failed', typeof err === 'string' ? err : 'Unknown error');
    } finally {
      setCheckoutTarget(null);
    }
  }, [active?.config.working_directory, activeTerminalId, gitInfo?.current_branch, fetchGitInfo, triggerChangesRefresh]);

  // Close on outside click + Escape
  useEffect(() => {
    if (!branchMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (branchMenuRef.current && !branchMenuRef.current.contains(e.target as Node)) {
        setBranchMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBranchMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [branchMenuOpen]);

  const filteredBranches = useMemo(() => {
    const q = branchFilter.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.toLowerCase().includes(q));
  }, [branches, branchFilter]);
  const statusDot = !active
    ? 'bg-text-tertiary'
    : active.config.status === 'Running'
    ? 'bg-success'
    : active.config.status === 'Idle'
    ? 'bg-warning'
    : active.config.status === 'Error'
    ? 'bg-error'
    : 'bg-text-tertiary';

  // Neutral monochrome styling for the tool capsule.
  // Instant press dip - feedback on pointer-down, not release.
  const toolBtn = (active: boolean) =>
    `no-drag w-7 h-7 flex items-center justify-center rounded-full transition-[background-color,color,transform] duration-100 active:scale-95 ${
      active
        ? 'bg-fill-active text-text-primary'
        : 'text-text-secondary hover:bg-fill-hover hover:text-text-primary'
    }`;

  return (
    <div
      onMouseDown={(e) => {
        // Portal events bubble through the React tree even when their DOM
        // nodes are outside the title bar. Starting a native drag there
        // consumes mouseup/click, leaving dialog buttons unresponsive.
        const target = e.target;
        if (
          e.buttons === 1 &&
          target instanceof Element &&
          e.currentTarget.contains(target) &&
          target.closest('.no-drag') === null
        ) {
          appWindow.startDragging();
        }
      }}
      className="absolute inset-x-0 top-0 z-20 h-[var(--h-toolbar)] flex items-center justify-between gap-2 px-1.5 drag-region select-none"
      data-toolbar
    >
      {/* Leading: window controls + brand only while the sidebar (their
          normal home) is hidden, then the context capsule. */}
      <div className="flex items-center gap-2 min-w-0">
        {!sidebarOpen && isMac && <span className="pl-2"><TrafficLights /></span>}
        {!sidebarOpen && (
          <span className="flex items-center gap-2 flex-shrink-0">
            <img src={appIcon} alt="" className="w-[26px] h-[26px]" draggable={false} />
            <span className="text-[13px] font-semibold text-text-primary tracking-tight">Agentrium</span>
          </span>
        )}

        <div className="glass-capsule h-8 pr-0.5 min-w-0">
        {/* Project breadcrumb - static status display, not a control (user
            decision: no click target, no chevron). */}
        <Tooltip label={active?.config.working_directory || 'No active session'}>
        <div className="flex items-center gap-1.5 h-7 pl-2.5 pr-2 max-w-[360px] min-w-0 cursor-default select-none">
          <span className={`w-1.5 h-1.5 rounded-full ${statusDot} flex-shrink-0`} />
          {breadcrumb.sub && (
            <>
              <span className="text-text-tertiary text-[12px] truncate max-w-[100px]">
                {breadcrumb.sub}
              </span>
              <span className="text-text-tertiary/60 text-[11px]">/</span>
            </>
          )}
          <span className="text-text-primary text-[12px] font-medium truncate">
            {breadcrumb.project}
          </span>
        </div>
        </Tooltip>

        {/* Branch switcher */}
        {gitInfo?.is_git_repo && gitInfo.current_branch && (
          <>
            <span className="w-px h-4 bg-seam mx-0.5" />
            <div className="relative no-drag" ref={branchMenuRef}>
              <Tooltip label="Switch branch" disabled={branchMenuOpen}>
              <button
                onClick={() => (branchMenuOpen ? setBranchMenuOpen(false) : openBranchMenu())}
                className={`flex items-center gap-1.5 h-7 px-2 rounded-full transition-colors ${
                  branchMenuOpen ? 'bg-fill-active' : 'hover:bg-fill-hover'
                }`}
              >
                <GitBranch size={12} strokeWidth={1.75} className="text-text-secondary" />
                <span className="text-text-primary text-[12px] font-mono truncate max-w-[140px]">
                  {gitInfo.current_branch}
                </span>
                <ChevronDown size={11} strokeWidth={2} className="text-text-tertiary" />
              </button>
              </Tooltip>

              {branchMenuOpen && (
                <div
                  // Flat New UI popover (#61): opaque `--elevation-4` surface
                  // with a plain 1px `--seam-strong` hairline and a standard
                  // float shadow - no `backdrop-filter`, no `edge-light` rim.
                  // Matches the flat treatment CLAUDE.md documents for the
                  // IntelliJ 2026.1 language.
                  className="absolute left-0 top-full mt-1 z-50 w-[260px] bg-elevation-4 ring-1 ring-inset ring-seam-strong shadow-elevation-3 ct-pop-in rounded-lg overflow-hidden"
                  style={{ transformOrigin: 'top left' }}
                >
                  <div className="p-2 border-b border-seam">
                    <div className="relative">
                      <SearchIcon size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary" strokeWidth={1.75} />
                      <input
                        autoFocus
                        type="text"
                        value={branchFilter}
                        onChange={(e) => setBranchFilter(e.target.value)}
                        placeholder="Filter branches…"
                        className="w-full bg-elevation-0 ring-1 ring-inset ring-seam rounded-md h-7 pl-7 pr-2 text-[12px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45"
                      />
                    </div>
                  </div>
                  <div className="max-h-[320px] overflow-y-auto py-1">
                    {branchesLoading && (
                      <div className="flex items-center gap-2 px-3 py-2 text-text-tertiary text-[12px]">
                        <Loader2 size={12} className="animate-spin" />
                        Loading branches…
                      </div>
                    )}
                    {!branchesLoading && filteredBranches.length === 0 && (
                      <div className="px-3 py-2 text-text-tertiary text-[12px]">
                        {branches.length === 0 ? 'No branches' : 'No match'}
                      </div>
                    )}
                    {!branchesLoading && filteredBranches.map((b) => {
                      const isCurrent = b === gitInfo.current_branch;
                      const isChecking = checkoutTarget === b;
                      return (
                        <ListRow
                          key={b}
                          variant="compact"
                          selected={isCurrent}
                          disabled={isChecking || isCurrent}
                          onClick={() => handleCheckout(b)}
                          trailing={
                            isChecking ? (
                              <Loader2 size={11} className="animate-spin text-text-tertiary" />
                            ) : isCurrent ? (
                              <Check size={12} className="text-accent-primary" />
                            ) : null
                          }
                        >
                          <span className={`truncate font-mono text-[12px] ${isCurrent ? 'text-accent-primary' : 'text-text-primary'}`}>
                            {b}
                          </span>
                        </ListRow>
                      );
                    })}
                  </div>
                  <div className="border-t border-seam">
                    <button
                      onClick={() => {
                        const path = active?.config.working_directory;
                        if (path) {
                          setBranchMenuOpen(false);
                          useAppStore.getState().openPushModal(path);
                        }
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-accent-primary hover:bg-accent-primary/10 transition-colors"
                      aria-keyshortcuts="Control+Shift+K"
                    >
                      <Upload size={12} strokeWidth={2} />
                      Push to remote…
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* Only shows when another session is blocked on the user. */}
        <WaitingPill />
        </div>
      </div>

      {/* Trailing: tools capsule, caption buttons. */}
      <div className="flex items-center gap-1.5 no-drag flex-shrink-0">
        <UpdatePill />

        <div className="glass-capsule h-8 px-0.5">
          {/* ONE inspector toggle - the Changes/Agents/Commands switcher
              lives inside the Inspector itself. Reopens on the Changes tab. */}
          <Tooltip label={inspectorOpen ? 'Close Inspector' : 'Open Inspector'}>
            <button onClick={toggleInspector} className={toolBtn(inspectorOpen)}>
              <PanelRight size={15} strokeWidth={1.9} />
            </button>
          </Tooltip>
          <ThemeToggle />
          <SyncStatusChip />
          <HeaderAuth />
        </div>

        {!isMac && <CaptionButtons />}
      </div>
    </div>
  );
}
