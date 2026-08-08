import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import {
  Terminal,
  Cpu,
  Bell,
  BellOff,
  ArrowDownCircle,
  Columns,
  LayoutGrid,
  GitBranch,
  GitFork,
} from 'lucide-react';
import { Tooltip } from './ui/Tooltip';
import { ProgressStripe } from './ui/ProgressStripe';

const MODEL_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  opus: { bg: 'bg-purple-500/15', text: 'text-purple-400', label: 'Opus' },
  sonnet: { bg: 'bg-blue-500/15', text: 'text-blue-400', label: 'Sonnet' },
  haiku: { bg: 'bg-green-500/15', text: 'text-green-400', label: 'Haiku' },
};

const STATUS_COLORS: Record<string, string> = {
  Running: 'text-success',
  Idle: 'text-warning',
  Stopped: 'text-text-tertiary',
  Error: 'text-error',
};

const STATUS_DOT_COLORS: Record<string, string> = {
  Running: 'bg-success',
  Idle: 'bg-warning',
  Stopped: 'bg-text-tertiary',
  Error: 'bg-error',
};

export function StatusBar() {
  const { terminals, activeTerminalId, gitInfoCache } = useTerminalStore();
  const {
    toggleSidebar,
    gridMode,
    toggleGridMode,
    notifyOnFinish,
    setNotifyOnFinish,
    openSettings,
  } = useAppStore();
  const unreadCount = useAppStore((s) => s.unreadNotificationCount);
  const clearUnread = useAppStore((s) => s.clearUnreadNotifications);
  const globalBusy = useAppStore((s) => s.globalBusy);
  const activeGitInfo = activeTerminalId ? gitInfoCache.get(activeTerminalId) : null;

  const [appVersion, setAppVersion] = useState('');
  const [claudeVersion, setClaudeVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
    invoke<string>('get_claude_version')
      .then((v) => setClaudeVersion(v))
      .catch(() => setClaudeVersion(null));
  }, []);

  const terminalCount = terminals.size;
  const runningCount = Array.from(terminals.values()).filter(
    (t) => t.config.status === 'Running'
  ).length;

  const activeTerminal = activeTerminalId ? terminals.get(activeTerminalId) : null;
  const activeStatus = activeTerminal?.config.status || 'Stopped';
  const activeModel = activeTerminal?.model;

  // Resolve model display
  const modelKey = activeModel
    ? Object.keys(MODEL_COLORS).find((k) => activeModel.toLowerCase().includes(k))
    : null;
  const modelInfo = modelKey ? MODEL_COLORS[modelKey] : null;

  return (
    <div className="flex flex-col shrink-0">
      {globalBusy && (
        <div title={globalBusy}>
          <ProgressStripe />
        </div>
      )}
      <div className="h-[22px] flex items-center justify-between pl-2 pr-1 bg-elevation-1 border-t border-[var(--ij-divider)] text-[11px] select-none">
      {/* Left side */}
      <div className="flex items-center gap-0.5">
        {/* Terminal count */}
        <Tooltip label="Toggle Sidebar" shortcut="Ctrl+B" side="top">
        <button
          onClick={toggleSidebar}
          className="flex items-center gap-1.5 h-[18px] px-1.5 rounded-[3px] text-text-secondary hover:bg-white/[0.06] hover:text-text-primary transition-colors"
        >
          <Terminal size={11} strokeWidth={1.75} />
          <span>
            {runningCount > 0
              ? `${runningCount}/${terminalCount} running`
              : `${terminalCount} terminal${terminalCount !== 1 ? 's' : ''}`}
          </span>
        </button>
        </Tooltip>

        <span className="text-text-tertiary/50 px-1">·</span>

        {/* Active terminal status */}
        {activeTerminal && (
          <div className="flex items-center gap-1.5 h-[18px] px-1.5">
            <Tooltip label={activeStatus} side="top">
              <div className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT_COLORS[activeStatus]}`} />
            </Tooltip>
            <span className={`${STATUS_COLORS[activeStatus]} font-medium truncate max-w-[180px]`}>
              {activeTerminal.config.nickname || activeTerminal.config.label}
            </span>
          </div>
        )}

        {activeTerminal && <span className="text-text-tertiary/50 px-1">·</span>}

        {/* Git branch chip (active terminal's repo). Sketch showed a
            prominent branch pill in the status bar; matches IntelliJ's
            bottom-right branch widget. */}
        {activeGitInfo?.is_git_repo && activeGitInfo.current_branch && (
          <>
            <Tooltip
              label={
                activeGitInfo.is_worktree
                  ? `Worktree · ${activeGitInfo.current_branch}`
                  : `Branch · ${activeGitInfo.current_branch}`
              }
              side="top"
            >
              <div className="flex items-center gap-1.5 h-[18px] px-1.5 rounded-[3px] text-text-secondary hover:bg-white/[0.06] hover:text-text-primary transition-colors cursor-default">
                {activeGitInfo.is_worktree
                  ? <GitFork size={10} strokeWidth={1.75} className="text-accent-secondary" />
                  : <GitBranch size={10} strokeWidth={1.75} className="text-accent-secondary" />}
                <span className="font-mono truncate max-w-[140px]">
                  {activeGitInfo.current_branch}
                </span>
              </div>
            </Tooltip>
            <span className="text-text-tertiary/50 px-1">·</span>
          </>
        )}

        {/* Grid/Split indicator */}
        <Tooltip label={gridMode ? 'Exit grid mode' : 'Enter grid mode'} side="top">
        <button
          onClick={toggleGridMode}
          className={`flex items-center gap-1 h-[18px] px-1.5 rounded-[3px] transition-colors ${
            gridMode
              ? 'text-accent-primary hover:bg-accent-primary/12'
              : 'text-text-tertiary hover:bg-white/[0.06] hover:text-text-secondary'
          }`}
        >
          {gridMode ? <LayoutGrid size={10} strokeWidth={1.75} /> : <Columns size={10} strokeWidth={1.75} />}
          <span>{gridMode ? 'Grid' : 'Tabs'}</span>
        </button>
        </Tooltip>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-0.5">
        {/* Model indicator */}
        {modelInfo && (
          <div
            className={`flex items-center gap-1 h-[18px] px-1.5 rounded-[3px] ${modelInfo.bg}`}
          >
            <Cpu size={10} className={modelInfo.text} strokeWidth={1.75} />
            <span className={`${modelInfo.text} font-medium`}>
              {modelInfo.label}
            </span>
          </div>
        )}

        {/* Notifications toggle */}
        <Tooltip
          label={
            unreadCount > 0
              ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`
              : notifyOnFinish ? 'Notifications on' : 'Notifications off'
          }
          side="top"
        >
          <button
            onClick={() => {
              setNotifyOnFinish(!notifyOnFinish);
              if (unreadCount > 0) clearUnread();
            }}
            className={`relative flex items-center h-[18px] w-[22px] justify-center rounded-[3px] transition-colors hover:bg-white/[0.06] ${
              notifyOnFinish ? 'text-text-secondary hover:text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {notifyOnFinish ? <Bell size={11} strokeWidth={1.75} /> : <BellOff size={11} strokeWidth={1.75} />}
            {unreadCount > 0 && (
              <span
                aria-hidden
                className="absolute top-[1px] right-[2px] w-[6px] h-[6px] rounded-full bg-accent-primary"
              />
            )}
          </button>
        </Tooltip>

        {/* Claude version */}
        {claudeVersion && (
          <Tooltip label="Open Settings" side="top">
            <button
              onClick={openSettings}
              className="flex items-center gap-1 h-[18px] px-1.5 rounded-[3px] text-text-tertiary hover:bg-white/[0.06] hover:text-text-secondary transition-colors"
            >
              <ArrowDownCircle size={10} strokeWidth={1.75} />
              <span>Claude {claudeVersion}</span>
            </button>
          </Tooltip>
        )}

        {/* App version */}
        <Tooltip label={`ClaudeTerminal v${appVersion}`} side="top">
          <span className="text-text-tertiary px-1.5 font-mono">v{appVersion}</span>
        </Tooltip>
      </div>
      </div>
    </div>
  );
}
