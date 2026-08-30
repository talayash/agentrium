import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
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
import { PanelHeader } from './ui/PanelHeader';
import { ListRow } from './ui/ListRow';
import { EmptyState } from './ui/EmptyState';
import { listAgentSessions, type AgentSessionInfo } from '../lib/agentSessions';
import type { AgentKind } from '../lib/agents';

const isMac = navigator.platform.toUpperCase().includes('MAC');
const REVEAL_LABEL = isMac ? 'Reveal in Finder' : 'Show in File Explorer';

interface ContextMenuState {
  x: number;
  y: number;
  session: AgentSessionInfo;
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
  const activeAgent: AgentKind = activeTerminal?.config.agent ?? 'claude';

  // The Explorer's pinned repo wins, mirroring FileTreePanel.
  const cwd = pinnedRepoPath ?? activeCwd;

  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
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
      const data = await listAgentSessions(activeAgent, cwd);
      setSessions(data);
    } catch (err) {
      setError(typeof err === 'string' ? err : 'Failed to list sessions');
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [cwd, activeAgent]);

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

  const openInNewTab = useCallback(async (session: AgentSessionInfo) => {
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
        session.id,  // resumeSessionId → backend prepends the right resume form
        undefined,   // continueRecent
        undefined,   // previewInit
        activeAgent, // agent must match the picker's source, or the wrong CLI gets the id
      );
    } catch (err) {
      toast.error('Could not open session', String(err));
    }
  }, [cwd, createTerminal, activeAgent]);

  const resumeInCurrentTerminal = useCallback(async (session: AgentSessionInfo) => {
    if (!cwd || !activeTerminalId || !activeTerminal) return;
    const agentLabel = activeAgent === 'claude' ? 'Claude'
      : activeAgent === 'codex' ? 'Codex'
      : activeAgent === 'cursor' ? 'Cursor'
      : 'Antigravity';
    const ok = window.confirm(
      `Replace the current ${agentLabel} in "${activeTerminal.config.nickname || activeTerminal.config.label}" with session ${session.id.slice(0, 8)}?\n\n` +
        `If the agent is mid-response, that work will be cancelled. The session you're leaving is saved on disk and resumable.`,
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
        undefined,   // continueRecent
        undefined,   // previewInit
        cfg.agent,   // match the terminal being replaced
      );
    } catch (err) {
      toast.error('Could not resume session', String(err));
    }
  }, [cwd, activeAgent, activeTerminalId, activeTerminal, closeTerminal, createTerminal]);

  const revealJsonl = useCallback(async (session: AgentSessionInfo) => {
    if (!cwd) return;
    if (activeAgent !== 'claude') {
      toast.error('Reveal not supported', 'File-manager reveal is only implemented for Claude sessions today.');
      return;
    }
    try {
      const home = await homeDir();
      const sep = home.includes('\\') ? '\\' : '/';
      const path = [home.replace(/[\\/]+$/, ''), '.claude', 'projects', encodeCwd(cwd), `${session.id}.jsonl`].join(sep);
      await invoke('reveal_in_file_manager', { path });
    } catch (err) {
      toast.error('Reveal failed', String(err));
    }
  }, [cwd, activeAgent]);

  const openContextMenu = useCallback((e: React.MouseEvent, session: AgentSessionInfo) => {
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
      <PanelHeader
        title="Sessions"
        count={collapsed ? undefined : sessions.length}
        collapsible
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        progress={{ active: !collapsed && loading }}
        actions={
          !collapsed ? (
            <button
              onClick={fetchSessions}
              disabled={loading}
              className="w-5 h-5 flex items-center justify-center rounded-md hover:bg-fill-hover text-text-tertiary hover:text-text-secondary transition-colors disabled:opacity-40"
              title="Refresh"
            >
              <RefreshCw size={11} className={loading ? 'animate-spin' : ''} strokeWidth={1.75} />
            </button>
          ) : undefined
        }
      />

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
                activeAgent === 'antigravity' ? (
                  <EmptyState
                    icon={<MessageSquare size={20} strokeWidth={1.75} />}
                    title="No local session index"
                    description="Antigravity conversations are server-side. Use --continue when you open a new terminal to resume the most recent."
                    compact
                  />
                ) : (
                  <EmptyState
                    icon={<MessageSquare size={20} strokeWidth={1.75} />}
                    title="No sessions yet"
                    description="Resumable sessions in this folder will appear here."
                    compact
                  />
                )
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
          activeAgent={activeAgent}
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
  session: AgentSessionInfo;
  active: boolean;
  onOpenInNewTab: (s: AgentSessionInfo) => void;
  onContextMenu: (e: React.MouseEvent, s: AgentSessionInfo) => void;
}

function SessionRow({ session, active, onOpenInNewTab, onContextMenu }: SessionRowProps) {
  return (
    <ListRow
      selected={active}
      onClick={() => { if (!active) onOpenInNewTab(session); }}
      onContextMenu={(e) => onContextMenu(e, session)}
      title={session.preview || session.id}
      leading={
        <MessageSquare
          size={11}
          strokeWidth={1.75}
          className={`shrink-0 ${active ? 'text-accent-primary' : 'text-text-tertiary'}`}
        />
      }
      trailing={
        <span className="text-[10.5px] text-text-tertiary tabular-nums">
          {formatRelativeTime(session.modified_at)}
        </span>
      }
    >
      <span
        className={`text-[12px] truncate ${
          active ? 'text-accent-primary font-medium' : 'text-text-primary'
        }`}
      >
        {session.preview || `Session ${session.id.slice(0, 8)}`}
      </span>
    </ListRow>
  );
}

interface SessionContextMenuProps {
  state: ContextMenuState;
  activeSessionId: string | null;
  activeAgent: AgentKind;
  hasActiveTerminal: boolean;
  onOpenInNewTab: (s: AgentSessionInfo) => void;
  onResumeInCurrent: (s: AgentSessionInfo) => void;
  onReveal: (s: AgentSessionInfo) => void;
  onClose: () => void;
}

function SessionContextMenu({
  state,
  activeSessionId,
  activeAgent,
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
      className="fixed z-[80] min-w-[220px] material-popover rounded-md py-1 select-none"
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
      <div className="my-1 border-t border-seam" />
      <MenuItem
        icon={<FolderOpen size={13} strokeWidth={1.75} />}
        label={REVEAL_LABEL}
        disabled={activeAgent !== 'claude'}
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
          : 'text-text-primary hover:bg-fill-hover'
      }`}
    >
      <span className={disabled ? 'opacity-50' : 'text-text-tertiary'}>{icon}</span>
      <span className="flex-1">{label}</span>
    </button>
  );
}
