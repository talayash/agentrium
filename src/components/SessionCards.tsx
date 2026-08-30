import { useEffect, useMemo, useState } from 'react';
import { Reorder } from 'framer-motion';
import { X, Copy, Grid3X3, AppWindow, Pin, PinOff, SplitSquareHorizontal } from 'lucide-react';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { createDetachedWindow } from '../lib/tabTransfer';
import { orderTabsPinnedFirst } from '../lib/pinnedTabOrder';
import { idsToCloseForOthers, idsToCloseForAllButPinned } from '../lib/closeTabActions';
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

interface CardContextMenuState {
  x: number;
  y: number;
  terminalId: string;
}

/**
 * The Sessions navigator body: every open terminal as a card. This is the ONE
 * session switcher, so it carries everything the retired tab strip used to:
 *   - click to activate, middle-click to close
 *   - drag to reorder (Framer Reorder, vertical; commits `reorderTerminals`)
 *   - hover actions: duplicate / add-to-grid / open-in-new-window / close
 *   - right-click menu: pin, split with active, close others / all-but-pinned
 * Pinned cards sort to the top (render-only partition - store order is
 * untouched, exactly like the old strip), so a drag can't visually cross the
 * pinned/unpinned boundary.
 */
export function SessionCards() {
  const terminals = useTerminalStore((s) => s.terminals);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const metrics = useTerminalStore((s) => s.terminalMetrics);
  const unreadTerminalIds = useTerminalStore((s) => s.unreadTerminalIds);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);
  const closeTerminal = useTerminalStore((s) => s.closeTerminal);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const reorderTerminals = useTerminalStore((s) => s.reorderTerminals);
  const { addToGrid, gridMode, toggleGridMode, gridTerminalIds, setSplitTerminals, setSplitMode } = useAppStore();
  const pinnedTabIds = useAppStore((s) => s.pinnedTabIds);
  const toggleTabPin = useAppStore((s) => s.toggleTabPin);
  const [contextMenu, setContextMenu] = useState<CardContextMenuState | null>(null);

  // Exclude script-child runners and plain shell terminals - they render
  // elsewhere (BottomTerminalPane), never in the session list.
  const list = useMemo(
    () =>
      Array.from(terminals.values()).filter(
        (t) => !t.scriptName && !t.scriptParentId && !t.isShellTerminal,
      ),
    [terminals],
  );

  // Pinned-first render order (render-only; store insertion order is the
  // source of truth for everything else, as with the old tab strip).
  const orderedIds = useMemo(() => {
    const ids = list.map((t) => t.config.id);
    return pinnedTabIds.length === 0 ? ids : orderTabsPinnedFirst(ids, pinnedTabIds);
  }, [list, pinnedTabIds]);
  const byId = useMemo(() => new Map(list.map((t) => [t.config.id, t] as const)), [list]);

  // Close the context menu on outside click / Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-context-menu="session-cards"]')) return;
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

  const splitWithActive = (id: string) => {
    if (activeTerminalId && id !== activeTerminalId) {
      setSplitTerminals([activeTerminalId, id]);
      setSplitMode(true);
    }
  };

  const openContextMenu = (e: React.MouseEvent, terminalId: string) => {
    e.preventDefault();
    e.stopPropagation();
    // Clamp against the viewport so the menu never renders off-screen when
    // the right-click lands near the window edges.
    const margin = 4;
    const menuWidth = 220;
    const menuHeight = 260;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - margin);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - margin);
    setContextMenu({ x: Math.max(margin, x), y: Math.max(margin, y), terminalId });
  };

  const handleReorder = (newOrder: string[]) => {
    // The store appends any ids we don't render (shell/script terminals), so
    // committing just the visible order is safe. The pinned-first partition
    // reapplies on render, keeping pins glued to the top.
    reorderTerminals(newOrder);
  };

  if (list.length === 0) {
    // No action button here - the sidebar's prominent New Session button sits
    // right below this empty state.
    return (
      <EmptyState
        title="No sessions yet"
        description="Start an agent session in any folder to see it here."
        compact
      />
    );
  }

  return (
    <>
    <Reorder.Group
      axis="y"
      as="div"
      values={orderedIds}
      onReorder={handleReorder}
      className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 py-2 flex flex-col gap-1.5"
    >
      {orderedIds.map((id) => {
        const t = byId.get(id);
        if (!t) return null;
        const active = id === activeTerminalId;
        const unread = !active && unreadTerminalIds.has(id);
        const isPinned = pinnedTabIds.includes(id);
        const inGrid = gridTerminalIds.includes(id);
        const cost = formatCost(metrics.get(id)?.costUsd ?? 0);
        const dir = basename(t.config.working_directory);
        const name = t.config.nickname || t.config.label;
        return (
          <Reorder.Item
            key={id}
            value={id}
            as="div"
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
            onContextMenu={(e) => openContextMenu(e, id)}
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
              {isPinned && (
                <Pin size={10} className="text-accent-primary flex-shrink-0" aria-label="Pinned" />
              )}
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
              {dir && <span className="truncate">{dir}</span>}
              {cost && <span className="ml-auto text-emerald-500 font-medium tabular-nums">{cost}</span>}
            </div>
          </Reorder.Item>
        );
      })}
    </Reorder.Group>

    {contextMenu && (() => {
      const ctxId = contextMenu.terminalId;
      const ctxPinned = pinnedTabIds.includes(ctxId);
      const allIds = list.map((t) => t.config.id);
      const canSplit = Boolean(activeTerminalId) && ctxId !== activeTerminalId;
      return (
        <div
          role="menu"
          data-context-menu="session-cards"
          className="fixed z-[80] min-w-[220px] material-popover rounded-lg py-1 select-none ct-pop-in"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <CardMenuItem
            icon={ctxPinned ? <PinOff size={13} strokeWidth={1.75} /> : <Pin size={13} strokeWidth={1.75} />}
            label={ctxPinned ? 'Unpin' : 'Pin'}
            onClick={() => { setContextMenu(null); toggleTabPin(ctxId); }}
          />
          <CardMenuItem
            icon={<SplitSquareHorizontal size={13} strokeWidth={1.75} />}
            label="Split with active session"
            disabled={!canSplit}
            onClick={() => { setContextMenu(null); splitWithActive(ctxId); }}
          />
          <CardMenuItem
            icon={<AppWindow size={13} strokeWidth={1.75} />}
            label="Open in New Window"
            onClick={() => { setContextMenu(null); openInNewWindow(ctxId); }}
          />
          <div className="my-1 border-t border-seam" />
          <CardMenuItem
            icon={<X size={13} strokeWidth={1.75} />}
            label="Close"
            onClick={() => { setContextMenu(null); closeWithReport(ctxId); }}
          />
          <CardMenuItem
            icon={<X size={13} strokeWidth={1.75} />}
            label="Close Others"
            disabled={allIds.length <= 1}
            onClick={() => {
              setContextMenu(null);
              idsToCloseForOthers(allIds, ctxId).forEach(closeWithReport);
            }}
          />
          <CardMenuItem
            icon={<X size={13} strokeWidth={1.75} />}
            label="Close All But Pinned"
            disabled={idsToCloseForAllButPinned(allIds, pinnedTabIds).length === 0}
            onClick={() => {
              setContextMenu(null);
              idsToCloseForAllButPinned(allIds, pinnedTabIds).forEach(closeWithReport);
            }}
          />
        </div>
      );
    })()}
    </>
  );
}

interface CardMenuItemProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

function CardMenuItem({ icon, label, onClick, disabled }: CardMenuItemProps) {
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
