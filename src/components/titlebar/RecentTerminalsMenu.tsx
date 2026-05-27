import { useState, useRef, useEffect, useMemo } from 'react';
import { Layers, ChevronDown, GitBranch, GitFork } from 'lucide-react';
import { useTerminalStore } from '../../store/terminalStore';
import { useAppStore } from '../../store/appStore';

const STATUS_DOT: Record<string, string> = {
  Running: 'bg-success',
  Idle: 'bg-warning',
  Error: 'bg-error',
  Stopped: 'bg-text-tertiary',
};

export function RecentTerminalsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { terminals, activeTerminalId, setActiveTerminal, gitInfoCache } = useTerminalStore();
  const openCommandPalette = useAppStore((s) => s.openCommandPalette);

  const items = useMemo(() => {
    return Array.from(terminals.values())
      .filter((t) => !t.scriptParentId && !t.isShellTerminal)
      .sort((a, b) => (a.config.created_at < b.config.created_at ? 1 : -1))
      .slice(0, 20);
  }, [terminals]);

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

  return (
    <div className="relative no-drag" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 h-7 px-2 rounded-[6px] transition-colors ${
          open ? 'bg-white/[0.08]' : 'hover:bg-white/[0.06]'
        }`}
        title="Recent Terminals"
        aria-label="Recent Terminals"
      >
        <Layers size={13} strokeWidth={2} className="text-pink-400" />
        <ChevronDown size={10} strokeWidth={2} className="text-text-tertiary" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-[300px] bg-elevation-3 ring-1 ring-white/[0.08] rounded-lg shadow-elevation-3 overflow-hidden">
          <div className="px-3 py-2 border-b border-[var(--ij-divider-soft)] text-text-tertiary text-[10px] uppercase tracking-wider font-semibold">
            Recent Terminals
          </div>
          <div className="max-h-[360px] overflow-y-auto py-1">
            {items.length === 0 && (
              <div className="px-3 py-3 text-text-tertiary text-[12px]">No terminals.</div>
            )}
            {items.map((t) => {
              const isActive = t.config.id === activeTerminalId;
              const gitInfo = gitInfoCache.get(t.config.id);
              return (
                <button
                  key={t.config.id}
                  onClick={() => { setActiveTerminal(t.config.id); setOpen(false); }}
                  className={`w-full flex items-start gap-2 px-3 py-1.5 text-left transition-colors ${
                    isActive ? 'bg-accent-primary/15 text-text-primary' : 'hover:bg-white/[0.05] text-text-secondary'
                  }`}
                >
                  <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[t.config.status]}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] font-medium truncate text-text-primary">
                        {t.config.nickname || t.config.label}
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
                </button>
              );
            })}
          </div>
          <div className="border-t border-[var(--ij-divider-soft)]">
            <button
              onClick={() => { setOpen(false); openCommandPalette(); }}
              className="w-full text-left px-3 py-2 text-[11.5px] text-accent-primary hover:bg-accent-primary/10 transition-colors"
            >
              Open Command Palette for full search&hellip;
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
