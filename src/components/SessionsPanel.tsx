import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ChevronRight,
  ChevronDown,
  RefreshCw,
  MessageSquare,
  ExternalLink,
  ArrowRightCircle,
  FolderOpen,
} from 'lucide-react';
import { homeDir } from '@tauri-apps/api/path';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';

const isMac = navigator.platform.toUpperCase().includes('MAC');
const REVEAL_LABEL = isMac ? 'Reveal in Finder' : 'Show in File Explorer';

interface ClaudeSessionInfo {
  id: string;
  modified_at: string;
  preview: string | null;
}

interface ContextMenuState {
  x: number;
  y: number;
  session: ClaudeSessionInfo;
}

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Pick a Windows-friendly encoded folder name for `~/.claude/projects/<X>`.
 *  Mirrors the Rust encoder (`\`, `/`, `:`, space → `-`). Used to assemble
 *  the absolute `.jsonl` path the user can reveal in Explorer. */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[\\/:\s]/g, '-');
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function SessionsPanel() {
  const collapsed = useAppStore((s) => s.sessionsCollapsed);
  const toggleCollapsed = useAppStore((s) => s.toggleSessionsCollapsed);
  const pinnedRepoPath = useAppStore((s) => s.pinnedRepoPath);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const terminals = useTerminalStore((s) => s.terminals);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const closeTerminal = useTerminalStore((s) => s.closeTerminal);

  const activeTerminal = activeTerminalId ? terminals.get(activeTerminalId) : null;
  const activeCwd = activeTerminal?.config.working_directory ?? null;
  const activeSessionId = activeTerminal?.config.claude_session_id ?? null;

  // The Explorer's pinned repo wins, mirroring FileTreePanel.
  const cwd = pinnedRepoPath ?? activeCwd;

  const [sessions, setSessions] = useState<ClaudeSessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const fetchSessions = useCallback(async () => {
    if (!cwd) {
      setSessions([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<ClaudeSessionInfo[]>('list_claude_sessions', { cwd });
      setSessions(data);
    } catch (err) {
      setError(typeof err === 'string' ? err : 'Failed to list sessions');
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (collapsed) return;
    fetchSessions();
  }, [cwd, collapsed, fetchSessions]);

  // Close the context menu on outside click / Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-context-menu="sessions"]')) return;
      setContextMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  const openInNewTab = useCallback(async (session: ClaudeSessionInfo) => {
    if (!cwd) return;
    const label = `Resumed ${session.id.slice(0, 8)}`;
    try {
      await createTerminal(
        label,
        cwd,
        [],          // no extra args - user can re-add flags via the New Terminal dialog
        {},
        undefined,
        undefined,
        undefined,
        session.id,  // resumeSessionId → backend prepends --resume <id>
      );
    } catch (err) {
      toast.error('Could not open session', String(err));
    }
  }, [cwd, createTerminal]);

  const resumeInCurrentTerminal = useCallback(async (session: ClaudeSessionInfo) => {
    if (!cwd || !activeTerminalId || !activeTerminal) return;
    const ok = window.confirm(
      `Replace the current Claude in "${activeTerminal.config.nickname || activeTerminal.config.label}" with session ${session.id.slice(0, 8)}?\n\n` +
        `If Claude is mid-response, that work will be cancelled. The session you're leaving is saved on disk and resumable.`,
    );
    if (!ok) return;
    // Snapshot the current terminal's user-facing config so the replacement
    // keeps the same label / nickname / color and isn't visually a new tab.
    const cfg = activeTerminal.config;
    try {
      await closeTerminal(activeTerminalId);
      await createTerminal(
        cfg.label,
        cfg.working_directory,
        cfg.claude_args,
        cfg.env_vars,
        cfg.color_tag ?? undefined,
        cfg.nickname ?? undefined,
        undefined,
        session.id,
      );
    } catch (err) {
      toast.error('Could not resume session', String(err));
    }
  }, [cwd, activeTerminalId, activeTerminal, closeTerminal, createTerminal]);

  const revealJsonl = useCallback(async (session: ClaudeSessionInfo) => {
    if (!cwd) return;
    try {
      const home = await homeDir();
      const sep = home.includes('\\') ? '\\' : '/';
      const path = [home.replace(/[\\/]+$/, ''), '.claude', 'projects', encodeCwd(cwd), `${session.id}.jsonl`].join(sep);
      await invoke('reveal_in_file_manager', { path });
    } catch (err) {
      toast.error('Reveal failed', String(err));
    }
  }, [cwd]);

  const openContextMenu = useCallback((e: React.MouseEvent, session: ClaudeSessionInfo) => {
    e.preventDefault();
    e.stopPropagation();
    const margin = 4;
    const menuWidth = 220;
    const menuHeight = 140;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - margin);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - margin);
    setContextMenu({ x: Math.max(margin, x), y: Math.max(margin, y), session });
  }, []);

  const headerCwdLabel = useMemo(() => {
    if (!cwd) return '';
    return basename(cwd);
  }, [cwd]);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between h-[26px] px-3 flex-shrink-0">
        <button
          onClick={toggleCollapsed}
          className="flex items-center gap-1.5 text-text-secondary hover:text-text-primary transition-colors"
          title={collapsed ? 'Expand Sessions' : 'Collapse Sessions'}
        >
          {collapsed ? (
            <ChevronRight size={11} strokeWidth={2} />
          ) : (
            <ChevronDown size={11} strokeWidth={2} />
          )}
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em]">
            Sessions
          </span>
          {sessions.length > 0 && !collapsed && (
            <span className="text-text-tertiary text-[10.5px] tabular-nums">
              {sessions.length}
            </span>
          )}
        </button>
        {!collapsed && (
          <button
            onClick={fetchSessions}
            disabled={loading}
            className="w-5 h-5 flex items-center justify-center rounded-[4px] hover:bg-white/[0.06] text-text-tertiary hover:text-text-secondary transition-colors disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} strokeWidth={1.75} />
          </button>
        )}
      </div>

      {/* Body - only when expanded */}
      {!collapsed && (
        <>
          {cwd ? (
            <div className="px-3 pb-1 flex-shrink-0">
              <p className="text-text-tertiary text-[10.5px] font-mono truncate" title={cwd}>
                {headerCwdLabel}
              </p>
            </div>
          ) : (
            <div className="px-3 py-2 text-text-tertiary text-[11px]">No active terminal</div>
          )}

          {cwd && (
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pb-1">
              {error && (
                <div className="px-3 py-2 text-red-400 text-[11px]">{error}</div>
              )}
              {!error && sessions.length === 0 && !loading && (
                <div className="px-3 py-2 text-text-tertiary text-[11px]">
                  No saved sessions in this folder yet.
                </div>
              )}
              {sessions.map((s) => {
                const isActive = activeSessionId === s.id;
                return (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={isActive}
                    onOpenInNewTab={openInNewTab}
                    onContextMenu={openContextMenu}
                  />
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Context menu */}
      {contextMenu && (
        <SessionContextMenu
          state={contextMenu}
          activeSessionId={activeSessionId}
          hasActiveTerminal={!!activeTerminalId}
          onOpenInNewTab={openInNewTab}
          onResumeInCurrent={resumeInCurrentTerminal}
          onReveal={revealJsonl}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

interface SessionRowProps {
  session: ClaudeSessionInfo;
  active: boolean;
  onOpenInNewTab: (s: ClaudeSessionInfo) => void;
  onContextMenu: (e: React.MouseEvent, s: ClaudeSessionInfo) => void;
}

function SessionRow({ session, active, onOpenInNewTab, onContextMenu }: SessionRowProps) {
  return (
    <button
      type="button"
      onClick={() => { if (!active) onOpenInNewTab(session); }}
      onContextMenu={(e) => onContextMenu(e, session)}
      title={session.preview || session.id}
      className={`w-full text-left px-3 py-1.5 group flex items-start gap-2 transition-colors ${
        active
          ? 'bg-accent-primary/10'
          : 'hover:bg-white/[0.045]'
      }`}
    >
      <MessageSquare
        size={11}
        strokeWidth={1.75}
        className={`mt-0.5 shrink-0 ${active ? 'text-accent-primary' : 'text-text-tertiary'}`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`text-[12px] truncate ${
              active ? 'text-accent-primary font-medium' : 'text-text-primary'
            }`}
          >
            {session.preview || `Session ${session.id.slice(0, 8)}`}
          </span>
          <span className="text-[10.5px] text-text-tertiary tabular-nums shrink-0">
            {formatRelativeTime(session.modified_at)}
          </span>
        </div>
        {session.preview && (
          <div className="text-[10.5px] text-text-tertiary font-mono truncate">
            {session.id.slice(0, 8)}{active && ' · active'}
          </div>
        )}
      </div>
    </button>
  );
}

interface SessionContextMenuProps {
  state: ContextMenuState;
  activeSessionId: string | null;
  hasActiveTerminal: boolean;
  onOpenInNewTab: (s: ClaudeSessionInfo) => void;
  onResumeInCurrent: (s: ClaudeSessionInfo) => void;
  onReveal: (s: ClaudeSessionInfo) => void;
  onClose: () => void;
}

function SessionContextMenu({
  state,
  activeSessionId,
  hasActiveTerminal,
  onOpenInNewTab,
  onResumeInCurrent,
  onReveal,
  onClose,
}: SessionContextMenuProps) {
  const { x, y, session } = state;
  const isActive = activeSessionId === session.id;
  return (
    <div
      role="menu"
      data-context-menu="sessions"
      className="fixed z-[80] min-w-[220px] bg-bg-elevated ring-1 ring-white/[0.08] rounded-md py-1 select-none"
      style={{ left: x, top: y }}
    >
      <MenuItem
        icon={<ExternalLink size={13} strokeWidth={1.75} />}
        label="Open in new tab"
        disabled={isActive}
        onClick={() => { onClose(); onOpenInNewTab(session); }}
      />
      <MenuItem
        icon={<ArrowRightCircle size={13} strokeWidth={1.75} />}
        label="Resume in current terminal"
        disabled={!hasActiveTerminal || isActive}
        onClick={() => { onClose(); onResumeInCurrent(session); }}
      />
      <div className="my-1 border-t border-white/[0.06]" />
      <MenuItem
        icon={<FolderOpen size={13} strokeWidth={1.75} />}
        label={REVEAL_LABEL}
        onClick={() => { onClose(); onReveal(session); }}
      />
    </div>
  );
}

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

function MenuItem({ icon, label, onClick, disabled }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] transition-colors ${
        disabled
          ? 'text-text-tertiary/50 cursor-not-allowed'
          : 'text-text-primary hover:bg-white/[0.06]'
      }`}
    >
      <span className={disabled ? 'opacity-50' : 'text-text-tertiary'}>{icon}</span>
      <span className="flex-1">{label}</span>
    </button>
  );
}
