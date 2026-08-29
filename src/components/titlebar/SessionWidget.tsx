import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronDown, GitBranch, GitFork, Plus, Play } from 'lucide-react';
import { useTerminalStore } from '../../store/terminalStore';
import { useAppStore } from '../../store/appStore';
import { StateDot } from '../StateDot';
import { ListRow } from '../ui/ListRow';
import type { SessionState } from '../../lib/terminalState';

const STATE_ORDER: Record<SessionState, number> = { waiting: 0, busy: 1, idle: 2, stopped: 3 };
const STATE_LABEL: Record<SessionState, string> = {
  waiting: 'Waiting', busy: 'Working', idle: 'Idle', stopped: 'Stopped',
};

/**
 * IntelliJ run-widget analog: shows the active terminal's name + live session
 * state in the titlebar; the dropdown switches between terminals. Replaces the
 * old right-cluster RecentTerminalsMenu.
 */
export function SessionWidget() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { terminals, activeTerminalId, setActiveTerminal, gitInfoCache } = useTerminalStore();
  const terminalStates = useTerminalStore((s) => s.terminalStates);
  const openNewTerminalModal = useAppStore((s) => s.openNewTerminalModal);
  const openCommandPalette = useAppStore((s) => s.openCommandPalette);

  const items = useMemo(() => {
    const list = Array.from(terminals.values())
      .filter((t) => !t.scriptParentId && !t.isShellTerminal);
    return list
      .sort((a, b) => {
        const sa = STATE_ORDER[terminalStates.get(a.config.id) ?? 'idle'];
        const sb = STATE_ORDER[terminalStates.get(b.config.id) ?? 'idle'];
        if (sa !== sb) return sa - sb;                       // waiting first
        return a.config.created_at < b.config.created_at ? 1 : -1; // then recent
      })
      .slice(0, 20);
  }, [terminals, terminalStates]);

  // Sessions other than the focused one that need input - the one glanceable
  // signal the (possibly collapsed) sidebar can't give.
  const waitingElsewhere = useMemo(
    () =>
      Array.from(terminals.values()).filter(
        (t) =>
          !t.scriptParentId &&
          !t.isShellTerminal &&
          t.config.id !== activeTerminalId &&
          terminalStates.get(t.config.id) === 'waiting',
      ).length,
    [terminals, terminalStates, activeTerminalId],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (items.length === 0) return null;

  const active = activeTerminalId ? terminals.get(activeTerminalId) : null;
  const activeState: SessionState = active
    ? terminalStates.get(active.config.id) ?? 'idle'
    : 'idle';
  const activeName = active ? active.config.nickname || active.config.label : 'Sessions';

  return (
    <>
      <span className="w-px h-4 bg-[var(--ij-divider-soft)] mx-0.5" />
      <div className="relative no-drag" ref={ref}>
        <button
          onClick={() => setOpen(!open)}
          aria-haspopup="menu"
          aria-expanded={open}
          className={`flex items-center gap-1.5 h-7 px-2 rounded-[6px] transition-colors ${
            open ? 'bg-fill-active' : 'hover:bg-fill-hover'
          }`}
        >
          <span className="relative inline-flex items-center">
            {/* Sketch showed a play icon for the run/session widget. Colored
                by session state so the icon carries the same signal as the
                previous StateDot (green/amber/red/gray). */}
            <Play
              size={10}
              strokeWidth={2}
              className={
                activeState === 'busy' ? 'text-success fill-success' :
                activeState === 'waiting' ? 'text-warning fill-warning' :
                activeState === 'stopped' ? 'text-error fill-error' :
                'text-text-tertiary fill-text-tertiary'
              }
            />
            {waitingElsewhere > 0 && (
              <span className="absolute -top-2 -right-2 min-w-[14px] h-[14px] px-[3px] rounded-full bg-amber-400 text-black text-[9px] font-bold leading-[14px] text-center">
                {waitingElsewhere}
              </span>
            )}
          </span>
          <span className="text-text-primary text-[12px] font-medium truncate max-w-[160px]">
            {activeName}
          </span>
          <ChevronDown size={11} strokeWidth={2} className="text-text-tertiary" />
        </button>

        {open && (
          <div className="absolute left-0 top-full mt-1 z-50 w-[300px] bg-elevation-3 ring-1 ring-seam-strong rounded-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--ij-divider-soft)] text-text-tertiary text-[10px] uppercase tracking-wider font-semibold">
              Sessions
            </div>
            <div className="max-h-[360px] overflow-y-auto py-1">
              {items.map((t) => {
                const isActive = t.config.id === activeTerminalId;
                const gitInfo = gitInfoCache.get(t.config.id);
                return (
                  <ListRow
                    key={t.config.id}
                    selected={isActive}
                    onClick={() => { setActiveTerminal(t.config.id); setOpen(false); }}
                    className="py-1.5 items-start"
                    leading={
                      <span className="mt-1">
                        <StateDot state={terminalStates.get(t.config.id) ?? 'idle'} size={6} />
                      </span>
                    }
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12px] font-medium truncate text-text-primary">
                          {t.config.nickname || t.config.label}
                        </span>
                        <span className="text-[9px] text-text-tertiary flex-shrink-0">
                          {STATE_LABEL[terminalStates.get(t.config.id) ?? 'idle']}
                        </span>
                        {gitInfo?.is_git_repo && gitInfo.current_branch && (
                          <span className="flex items-center gap-0.5 text-[10px] font-mono text-text-tertiary flex-shrink-0">
                            {gitInfo.is_worktree ? <GitFork size={9} /> : <GitBranch size={9} />}
                            {gitInfo.current_branch}
                          </span>
                        )}
                      </div>
                      <div className="text-[10.5px] text-text-tertiary truncate">
                        {t.config.working_directory}
                      </div>
                    </div>
                  </ListRow>
                );
              })}
            </div>
            <div className="border-t border-[var(--ij-divider-soft)]">
              <button
                onClick={() => { setOpen(false); openNewTerminalModal(); }}
                className="w-full flex items-center gap-1.5 px-3 py-2 text-[11.5px] text-accent-primary hover:bg-accent-primary/10 transition-colors"
              >
                <Plus size={12} strokeWidth={2} />
                New Terminal
              </button>
              <button
                onClick={() => { setOpen(false); openCommandPalette(); }}
                className="w-full text-left px-3 py-2 text-[11.5px] text-text-secondary hover:bg-fill-hover transition-colors border-t border-[var(--ij-divider-soft)]"
              >
                Open Command Palette for full search&hellip;
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
