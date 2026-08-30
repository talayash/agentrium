import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import appIcon from '../assets/app-icon.png';
import {
  Settings,
  Minus,
  Square,
  X,
  GitBranch,
  ChevronDown,
  Check,
  Loader2,
  Search as SearchIcon,
  Upload,
  FileDiff,
  Users,
  Lightbulb,
  Monitor,
} from 'lucide-react';
import { usePreviewStore } from '../store/previewStore';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { UpdatePill } from './UpdatePill';
import { ToolsMenu } from './titlebar/ToolsMenu';
import { SessionWidget } from './titlebar/SessionWidget';
import { Tooltip } from './ui/Tooltip';
import { ThemeToggle } from './ui/ThemeToggle';
import { ListRow } from './ui/ListRow';
import { pickBreadcrumb } from '../lib/breadcrumb';

const isMac = navigator.platform.toUpperCase().includes('MAC');

export function TitleBar() {
  const {
    toggleSidebar,
    openSettings,
    openCommandPalette,
    triggerChangesRefresh,
  } = useAppStore();
  const { terminals, activeTerminalId, gitInfoCache } = useTerminalStore();
  const fetchGitInfo = useTerminalStore.getState().fetchGitInfo;
  // Inspector triggers - relocated from the retired left ToolStripe rail.
  const changesOpen = useAppStore((s) => s.changesOpen);
  const orchestrationOpen = useAppStore((s) => s.orchestrationOpen);
  const hintsOpen = useAppStore((s) => s.hintsOpen);
  const toggleChanges = useAppStore((s) => s.toggleChanges);
  const toggleOrchestration = useAppStore((s) => s.toggleOrchestration);
  const toggleHints = useAppStore((s) => s.toggleHints);
  const previewOpen = usePreviewStore((s) => s.globalOpen);
  const togglePreview = usePreviewStore((s) => s.toggleGlobal);
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

  // Neutral monochrome styling for the right-side tool cluster.
  // Instant press dip - feedback on pointer-down, not release.
  const toolBtn = (active: boolean) =>
    `no-drag w-7 h-7 flex items-center justify-center rounded-md transition-[background-color,color,transform] duration-100 active:scale-95 ${
      active
        ? 'bg-fill-active text-text-primary'
        : 'text-text-secondary hover:bg-fill-hover hover:text-text-primary'
    }`;

  return (
    <div
      onMouseDown={(e) => { if (e.buttons === 1 && (e.target as HTMLElement).closest('.no-drag') === null) appWindow.startDragging(); }}
      className="h-[var(--h-header)] material-chrome flex items-center justify-between pl-2 pr-0 border-b border-seam-strong drag-region select-none"
    >
      {/* Left cluster - traffic lights (mac), sidebar toggle */}
      <div className="flex items-center gap-1 min-w-0">
        {isMac && (
          <div className="flex items-center gap-1.5 no-drag mr-1">
            <button
              onClick={() => appWindow.close()}
              className="w-3 h-3 rounded-full bg-[#ff5f57] hover:brightness-90 transition-all"
              aria-label="Close"
            />
            <button
              onClick={() => appWindow.minimize()}
              className="w-3 h-3 rounded-full bg-[#febc2e] hover:brightness-90 transition-all"
              aria-label="Minimize"
            />
            <button
              onClick={() => appWindow.toggleMaximize()}
              className="w-3 h-3 rounded-full bg-[#28c840] hover:brightness-90 transition-all"
              aria-label="Maximize"
            />
          </div>
        )}

        <Tooltip label="Toggle Sidebar" shortcut="Ctrl+B">
          <button
            onClick={toggleSidebar}
            className="no-drag w-7 h-7 flex items-center justify-center rounded-md transition-colors text-text-secondary hover:bg-fill-hover hover:text-text-primary"
          >
            <img src={appIcon} alt="Agentrium" className="w-[20px] h-[20px]" />
          </button>
        </Tooltip>

        {/* Project breadcrumb - IntelliJ main-toolbar project widget */}
        <Tooltip label={active?.config.working_directory || 'No active terminal'}>
        <button
          onClick={openCommandPalette}
          className="no-drag group flex items-center gap-1.5 h-7 ml-1 pl-2 pr-2 rounded-md hover:bg-fill-hover transition-colors max-w-[360px]"
        >
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
          <ChevronDown
            size={11}
            strokeWidth={2}
            className="text-text-tertiary group-hover:text-text-secondary flex-shrink-0"
          />
        </button>
        </Tooltip>

        {/* Branch switcher */}
        {gitInfo?.is_git_repo && gitInfo.current_branch && (
          <>
            <span className="w-px h-4 bg-seam mx-0.5" />
            <div className="relative no-drag" ref={branchMenuRef}>
              <Tooltip label="Switch branch" disabled={branchMenuOpen}>
              <button
                onClick={() => (branchMenuOpen ? setBranchMenuOpen(false) : openBranchMenu())}
                className={`flex items-center gap-1.5 h-7 px-2 rounded-md transition-colors ${
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
                  className="absolute left-0 top-full mt-1 z-50 w-[260px] material-popover ct-pop-in rounded-lg overflow-hidden"
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

        {/* Session widget - IntelliJ run-widget analog */}
        <SessionWidget />
      </div>

      {/* Command spine: a prominent ⌘K field at the center of the toolbar -
          the primary way to search or run any action (Apple/Linear). */}
      <div className="flex-1 flex items-center justify-center min-w-0 px-3">
        <button
          onClick={openCommandPalette}
          className="no-drag group flex items-center gap-2.5 h-8 w-full max-w-[440px] px-3 rounded-[10px] bg-fill-hover hover:bg-fill-active ring-1 ring-inset ring-seam text-text-tertiary hover:text-text-secondary transition-colors"
        >
          <SearchIcon size={14} strokeWidth={2} className="flex-shrink-0" />
          <span className="text-[12.5px] truncate">Search or run a command…</span>
          <span className="ml-auto flex items-center gap-1 flex-shrink-0">
            <kbd className="px-1.5 h-[18px] flex items-center rounded-[5px] bg-elevation-3 ring-1 ring-seam text-text-tertiary text-[10.5px] font-sans">
              {isMac ? '⌘' : 'Ctrl'}
            </kbd>
            <kbd className="px-1.5 h-[18px] flex items-center rounded-[5px] bg-elevation-3 ring-1 ring-seam text-text-tertiary text-[10.5px] font-sans">
              P
            </kbd>
          </span>
        </button>
      </div>

      {/* Right cluster - search, run, tool windows, settings, window controls */}
      <div className="flex items-stretch">
        <div className="flex items-center gap-0.5 pr-2 no-drag">
          <UpdatePill />
          <ToolsMenu />

          <div className="w-px h-4 bg-seam-strong mx-1" />

          {/* Inspector triggers (moved out of the old left rail) */}
          <Tooltip label="Git" shortcut="F2">
            <button onClick={toggleChanges} className={toolBtn(changesOpen)}>
              <FileDiff size={15} strokeWidth={1.9} />
            </button>
          </Tooltip>
          <Tooltip label="Agents" shortcut="F4">
            <button onClick={toggleOrchestration} className={toolBtn(orchestrationOpen)}>
              <Users size={15} strokeWidth={1.9} />
            </button>
          </Tooltip>
          <Tooltip label="Commands" shortcut="F1">
            <button onClick={toggleHints} className={toolBtn(hintsOpen)}>
              <Lightbulb size={15} strokeWidth={1.9} />
            </button>
          </Tooltip>
          <Tooltip label="Preview" shortcut="Ctrl+Alt+P">
            <button onClick={togglePreview} className={toolBtn(previewOpen)}>
              <Monitor size={15} strokeWidth={1.9} />
            </button>
          </Tooltip>

          <div className="w-px h-4 bg-seam-strong mx-1" />

          <ThemeToggle />

          <Tooltip label="Settings" shortcut="Ctrl+,">
            <button onClick={openSettings} className={toolBtn(false)}>
              <Settings size={15} strokeWidth={2} />
            </button>
          </Tooltip>
        </div>

        {!isMac && (
          <div className="flex items-stretch no-drag">
            <button
              onClick={() => appWindow.minimize()}
              className="w-[46px] h-[var(--h-header)] flex items-center justify-center hover:bg-fill-hover text-text-secondary transition-colors"
              aria-label="Minimize"
            >
              <Minus size={12} strokeWidth={1.75} />
            </button>
            <button
              onClick={() => appWindow.toggleMaximize()}
              className="w-[46px] h-[var(--h-header)] flex items-center justify-center hover:bg-fill-hover text-text-secondary transition-colors"
              aria-label="Maximize"
            >
              <Square size={11} strokeWidth={1.75} />
            </button>
            <button
              onClick={() => appWindow.close()}
              className="w-[46px] h-[var(--h-header)] flex items-center justify-center hover:bg-[#E04545] text-text-secondary hover:text-white transition-colors"
              aria-label="Close"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
