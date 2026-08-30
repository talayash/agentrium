import { X, Copy, Grid3X3, AppWindow } from 'lucide-react';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { createDetachedWindow } from '../lib/tabTransfer';
import { BrandIcon } from './BrandIcon';
import { EmptyState } from './ui/EmptyState';
import { Tooltip } from './ui/Tooltip';
import { useAppStore } from '../store/appStore';
import type { AgentKind } from '../lib/agents';

// Soft per-agent tint for the card badge (Apple-clean, theme-aware via /alpha).
const AGENT_TINT: Record<AgentKind, string> = {
  claude: 'bg-orange-500/15 text-orange-500',
  codex: 'bg-teal-500/15 text-teal-500',
  cursor: 'bg-indigo-500/15 text-indigo-500',
  antigravity: 'bg-sky-500/15 text-sky-500',
};

const STATUS_DOT: Record<string, string> = {
  Running: 'bg-success',
  Idle: 'bg-warning',
  Error: 'bg-error',
  Stopped: 'bg-text-tertiary',
};

function basename(p: string | undefined | null): string {
  if (!p) return '';
  const t = p.replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
  return i === -1 ? t : t.slice(i + 1);
}

function formatCost(usd: number): string | null {
  if (!usd || usd <= 0) return null;
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/**
 * The Sessions navigator body: every open terminal as a card (agent brand,
 * live status, folder, cost). Clicking activates it. This is the ONE session
 * switcher (the old horizontal tab strip is gone), so the card also carries
 * the per-session actions on hover: duplicate, add-to-grid, open in a new
 * window, close. The agent badge slides left as the actions appear - nothing
 * ever overlaps it.
 */
export function SessionCards() {
  const terminals = useTerminalStore((s) => s.terminals);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const metrics = useTerminalStore((s) => s.terminalMetrics);
  const unreadTerminalIds = useTerminalStore((s) => s.unreadTerminalIds);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);
  const closeTerminal = useTerminalStore((s) => s.closeTerminal);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const { addToGrid, gridMode, toggleGridMode, gridTerminalIds } = useAppStore();

  // Exclude script-child runners and plain shell terminals - they render
  // elsewhere (BottomTerminalPane), never in the session list.
  const list = Array.from(terminals.values()).filter(
    (t) => !t.scriptName && !t.scriptParentId && !t.isShellTerminal,
  );

  const closeWithReport = (id: string) => {
    closeTerminal(id).catch((err) => {
      toast.error('Close failed', 'Could not close the session.');
      reportInvokeFailure('close_terminal', err);
    });
  };

  const duplicate = (id: string) => {
    const instance = terminals.get(id);
    if (!instance) return;
    const { label, working_directory, claude_args, env_vars, color_tag, nickname, agent } = instance.config;
    // createTerminal rethrows on spawn failure - catch or the duplicate
    // silently never appears and the rejection goes unhandled.
    createTerminal(
      label, working_directory, claude_args, env_vars,
      color_tag ?? undefined, nickname ?? undefined,
      undefined, undefined, undefined, undefined, agent,
    ).catch((err) => {
      toast.error('Duplicate failed', 'Could not start the new session.');
      reportInvokeFailure('create_terminal', err);
    });
  };

  const openInNewWindow = (id: string) => {
    // Spawn the detached window slightly inset from the current one, in
    // physical pixels (Tauri window positions are physical).
    const scale = window.devicePixelRatio || 1;
    const physX = Math.round((window.screenX + 120) * scale);
    const physY = Math.round((window.screenY + 120) * scale);
    createDetachedWindow([id], physX, physY).catch((err) => {
      toast.error('Detach failed', 'Could not open a new window.');
      reportInvokeFailure('create_detached_window', err);
    });
  };

  if (list.length === 0) {
    return (
      <EmptyState
        title="No sessions yet"
        description="Start an agent session in any folder to see it here."
        action={
          <button
            onClick={() => useAppStore.getState().openNewTerminalModal()}
            className="h-8 px-3 rounded-lg bg-accent-primary text-white text-[12px] font-medium active:scale-[0.97] transition-transform"
          >
            New Session
          </button>
        }
        compact
      />
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 py-2 flex flex-col gap-1.5">
      {list.map((t) => {
        const id = t.config.id;
        const active = id === activeTerminalId;
        const unread = !active && unreadTerminalIds.has(id);
        const inGrid = gridTerminalIds.includes(id);
        const cost = formatCost(metrics.get(id)?.costUsd ?? 0);
        const dir = basename(t.config.working_directory);
        const name = t.config.nickname || t.config.label;
        return (
          <div
            key={id}
            role="button"
            tabIndex={0}
            aria-selected={active}
            onClick={() => setActiveTerminal(id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveTerminal(id); }
            }}
            onAuxClick={(e) => {
              // Middle-click closes - parity with the old tab strip.
              if (e.button === 1) { e.preventDefault(); closeWithReport(id); }
            }}
            className={`group relative rounded-xl px-3 py-2.5 cursor-pointer transition-[background-color,box-shadow] duration-100 ring-1 ${
              active
                ? 'bg-accent-primary/10 ring-accent-primary/30'
                : 'bg-fill-hover ring-seam hover:bg-fill-active'
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`w-[7px] h-[7px] rounded-full flex-shrink-0 ${STATUS_DOT[t.config.status] ?? 'bg-text-tertiary'}`}
                title={t.config.status}
              />
              <span className="text-[13px] font-medium text-text-primary truncate">{name}</span>
              {unread && (
                <span className="w-1.5 h-1.5 rounded-full bg-accent-primary flex-shrink-0" aria-label="Unread output" />
              )}
              {/* Badge first, actions after: when the hover actions appear the
                  badge slides LEFT instead of being covered. */}
              <span
                className={`ml-auto flex items-center gap-1 text-[10px] font-semibold px-1.5 h-[17px] rounded-md flex-shrink-0 ${AGENT_TINT[t.config.agent]}`}
              >
                <BrandIcon kind={t.config.agent} size={10} />
              </span>
              <span className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
                <Tooltip label="Duplicate session">
                  <button
                    onClick={(e) => { e.stopPropagation(); duplicate(id); }}
                    aria-label={`Duplicate ${name}`}
                    className="w-[18px] h-[18px] rounded-md flex items-center justify-center text-text-tertiary hover:bg-fill-active hover:text-text-primary transition-colors"
                  >
                    <Copy size={11} strokeWidth={2} />
                  </button>
                </Tooltip>
                <Tooltip label={inGrid ? 'In grid' : 'Add to grid'}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      addToGrid(id);
                      if (!gridMode) toggleGridMode();
                    }}
                    aria-label={`Add ${name} to grid`}
                    className={`w-[18px] h-[18px] rounded-md flex items-center justify-center transition-colors ${
                      inGrid
                        ? 'text-accent-primary hover:bg-accent-primary/12'
                        : 'text-text-tertiary hover:bg-fill-active hover:text-text-primary'
                    }`}
                  >
                    <Grid3X3 size={11} strokeWidth={2} />
                  </button>
                </Tooltip>
                <Tooltip label="Open in new window">
                  <button
                    onClick={(e) => { e.stopPropagation(); openInNewWindow(id); }}
                    aria-label={`Open ${name} in a new window`}
                    className="w-[18px] h-[18px] rounded-md flex items-center justify-center text-text-tertiary hover:bg-fill-active hover:text-text-primary transition-colors"
                  >
                    <AppWindow size={11} strokeWidth={2} />
                  </button>
                </Tooltip>
                <Tooltip label="Close session">
                  <button
                    onClick={(e) => { e.stopPropagation(); closeWithReport(id); }}
                    aria-label={`Close ${name}`}
                    className="w-[18px] h-[18px] rounded-md flex items-center justify-center text-text-tertiary hover:bg-fill-active hover:text-error transition-colors"
                  >
                    <X size={11} strokeWidth={2} />
                  </button>
                </Tooltip>
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-text-tertiary">
              {dir && <span className="font-mono truncate">{dir}</span>}
              {cost && <span className="ml-auto text-emerald-500 font-medium tabular-nums">{cost}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
