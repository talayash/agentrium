import { useCallback } from 'react';
import { ChevronRight, GitBranch, XCircle } from 'lucide-react';
import { useTerminalStore } from '../../store/terminalStore';
import { useAppStore } from '../../store/appStore';
import { toast } from '../../store/toastStore';
import { reportInvokeFailure } from '../../lib/errorReporter';
import { closeWithConfirm } from '../../lib/closeConfirm';
import { useNowTick } from '../../hooks/useNowTick';
import { getLastOutputAt } from '../../lib/terminalActivity';
import { specFor } from '../../lib/agents';
import { getAnyModelBadgeClasses, getModelBadgeLabel } from '../../lib/agentModels';
import type { SessionState } from '../../lib/terminalState';
import { StateDot } from '../StateDot';
import { BrandIcon } from '../BrandIcon';
import { Tooltip } from '../ui/Tooltip';
import { ViewModeSwitch } from '../insight/ViewModeSwitch';
import { ContextMeter } from '../ContextMeter';
import { TaskBadge } from '../TaskBadge';
import { CiRepairBadge } from '../CiRepairBadge';
import { PrChip } from '../PrChip';
import { ScriptsMenu } from '../ScriptsMenu';

function formatCost(usd: number): string {
  if (usd <= 0) return '';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** True when the toolbar should carry the active session's identity and
 *  actions. Grid and split modes have their own headers, so the toolbar
 *  falls back to the plain project breadcrumb there. */
export function useSessionHeaderVisible(): boolean {
  const gridMode = useAppStore((s) => s.gridMode);
  const splitMode = useAppStore((s) => s.splitMode);
  const splitIds = useAppStore((s) => s.splitTerminalIds);
  const hasActive = useTerminalStore((s) => (s.activeTerminalId ? s.terminals.has(s.activeTerminalId) : false));
  const splitActive = useTerminalStore(
    (s) => splitMode && !!splitIds && s.terminals.has(splitIds[0]) && s.terminals.has(splitIds[1]),
  );
  return hasActive && !gridMode && !splitActive;
}

/**
 * Identity of the ACTIVE session, rendered inline in the toolbar after the
 * project breadcrumb (agent · name · title · badges · cost · context).
 * It used to be a second header row in TerminalTabs; merging it into the
 * toolbar gives that row's height back to the terminal. The working
 * directory basename is omitted because the breadcrumb right before it
 * already shows it.
 */
export function SessionIdentity() {
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const inst = useTerminalStore((s) => (s.activeTerminalId ? s.terminals.get(s.activeTerminalId) : undefined));
  const stateFromPoller = useTerminalStore((s) => (activeTerminalId ? s.terminalStates.get(activeTerminalId) : undefined));
  const costUsd = useTerminalStore((s) => (activeTerminalId ? s.terminalMetrics.get(activeTerminalId)?.costUsd ?? 0 : 0));
  const git = useTerminalStore((s) => (activeTerminalId ? s.gitInfoCache.get(activeTerminalId) : undefined));
  const showTabActivity = useAppStore((s) => s.showTabActivity);
  const browsingFile = useAppStore((s) => Boolean(s.activeFilePath));
  const now = useNowTick();

  if (!inst) return null;
  const config = inst.config;
  const name = config.nickname || config.label;
  const title = inst.sessionContext?.title;

  // Prefer the poller's classified state; fall back to the live activity
  // timer so the dot lights up on first output before the first poll tick.
  const lastOutputAt = getLastOutputAt(config.id);
  const liveBusy = lastOutputAt != null && now - lastOutputAt < 2000;
  const state: SessionState = stateFromPoller ?? (liveBusy ? 'busy' : 'idle');
  const cost = formatCost(costUsd);

  return (
    <div
      className={`flex items-center gap-1.5 min-w-0 pr-1.5 ${browsingFile ? 'opacity-60' : ''}`}
      data-session-header
    >
      <ChevronRight size={12} strokeWidth={2} className="text-text-tertiary flex-shrink-0 -ml-1" aria-hidden />
      {state !== 'idle' && showTabActivity && <StateDot state={state} />}
      <Tooltip label={`Agent: ${specFor(config.agent).displayName}`}>
        <span className="flex-shrink-0 flex items-center">
          <BrandIcon kind={config.agent} size={14} />
        </span>
      </Tooltip>
      <span className="text-[12px] font-medium text-text-primary max-w-[180px] truncate">{name}</span>
      {title && title !== name && (
        <span className="hidden xl:inline text-[12px] text-text-secondary max-w-[220px] truncate" title={title}>
          · {title}
        </span>
      )}
      {config.task ? (
        <>
          <TaskBadge terminalId={config.id} task={config.task} />
          <CiRepairBadge terminalId={config.id} task={config.task} />
        </>
      ) : git?.is_worktree && (
        <Tooltip label={`Worktree · ${git.current_branch ?? ''}`}>
          <GitBranch size={11} className="text-purple-400 flex-shrink-0" />
        </Tooltip>
      )}
      <PrChip terminalId={config.id} />
      {inst.model && (
        <span className={`hidden lg:flex text-[9px] px-1.5 h-[16px] items-center rounded-md font-medium flex-shrink-0 ${getAnyModelBadgeClasses(inst.model)}`}>
          {getModelBadgeLabel(inst.model)}
        </span>
      )}
      {cost && (
        <Tooltip label="Estimated session cost (live)">
          <span className="hidden lg:flex text-[9px] px-1.5 h-[16px] items-center rounded-md font-medium flex-shrink-0 bg-emerald-500/15 text-emerald-400 tabular-nums">
            {cost}
          </span>
        </Tooltip>
      )}
      <ContextMeter terminalId={config.id} />
      {inst.loopInfo && (
        <Tooltip label={`Loop: ${inst.loopInfo.interval}`}>
          <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse flex-shrink-0" />
        </Tooltip>
      )}
    </div>
  );
}

/**
 * Session actions for the toolbar's trailing side: project scripts, the
 * CLI/Mixed/Insight switch (icon-only) and Close session. All hidden while a
 * file is focused, matching the old session strip.
 */
export function SessionActions() {
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const inst = useTerminalStore((s) => (s.activeTerminalId ? s.terminals.get(s.activeTerminalId) : undefined));
  const showFileTree = useAppStore((s) => s.showFileTree);
  const browsingFile = useAppStore((s) => Boolean(s.activeFilePath));

  // Mirrors the sidebar SessionCards' close path so error handling and
  // telemetry stay consistent with the other close entry points.
  const closeActiveSession = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (!activeTerminalId) return;
    closeWithConfirm(activeTerminalId, e.currentTarget).catch((err) => {
      toast.error('Close failed', 'Could not close the session.');
      reportInvokeFailure('close_terminal', err);
    });
  }, [activeTerminalId]);

  if (!inst || !activeTerminalId || browsingFile) return null;

  return (
    <>
    {/* Divides the session's identity (breadcrumb, branch) from its controls
        inside the session tab. Rendered here so it disappears together with
        the controls and never dangles on its own. */}
    <span data-session-divider className="w-px h-4 bg-seam-strong mx-1 flex-shrink-0" aria-hidden />
    <div className="toolbar-group h-8 px-0.5 gap-0.5">
      {showFileTree && !inst.scriptParentId && (
        <ScriptsMenu terminalId={activeTerminalId} cwd={inst.config.working_directory} />
      )}
      <ViewModeSwitch terminalId={activeTerminalId} compact />
      {/* Circled glyph, separated from the caption buttons by the tools
          group, so it never reads as the window's close X. */}
      <Tooltip label="Close this session" shortcut="Ctrl+W">
        <button
          onClick={closeActiveSession}
          aria-label="Close Session"
          data-close-session-anchor
          aria-keyshortcuts="Control+W"
          className="tone-danger no-drag w-7 h-7 flex items-center justify-center rounded-full text-text-secondary transition-[background-color,color,transform] duration-100 active:scale-95"
        >
          <XCircle size={15} strokeWidth={1.9} />
        </button>
      </Tooltip>
    </div>
    </>
  );
}
