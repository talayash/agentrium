import { X } from 'lucide-react';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { BrandIcon } from './BrandIcon';
import { EmptyState } from './ui/EmptyState';
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
 * live status, folder, cost). Clicking activates it; the hover close button
 * ends it. Replaces the horizontal tab strip as the primary way to move
 * between many parallel sessions.
 */
export function SessionCards() {
  const terminals = useTerminalStore((s) => s.terminals);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const metrics = useTerminalStore((s) => s.terminalMetrics);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);
  const closeTerminal = useTerminalStore((s) => s.closeTerminal);

  // Exclude script-child runners and plain shell terminals - they render
  // elsewhere (BottomTerminalPane), never in the session list.
  const list = Array.from(terminals.values()).filter(
    (t) => !t.scriptName && !t.scriptParentId && !t.isShellTerminal,
  );

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
              <span
                className={`ml-auto flex items-center gap-1 text-[10px] font-semibold px-1.5 h-[17px] rounded-md flex-shrink-0 ${AGENT_TINT[t.config.agent]}`}
              >
                <BrandIcon kind={t.config.agent} size={10} />
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-text-tertiary">
              {dir && <span className="font-mono truncate">{dir}</span>}
              {cost && <span className="ml-auto text-emerald-500 font-medium tabular-nums">{cost}</span>}
            </div>
            {/* Hover close */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTerminal(id).catch((err) => {
                  toast.error('Close failed', 'Could not close the session.');
                  reportInvokeFailure('close_terminal', err);
                });
              }}
              aria-label={`Close ${name}`}
              className="absolute top-1.5 right-1.5 w-5 h-5 rounded-md flex items-center justify-center text-text-tertiary opacity-0 group-hover:opacity-100 hover:bg-fill-active hover:text-text-secondary transition-[opacity,background-color]"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
