import { create } from 'zustand';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { requestCloseTerminal } from './tasks';
import type { SessionState } from './terminalState';

/** Viewport rect of the control that asked to close (the card X, the header
 *  "Close session" button). Null for Ctrl+W, which has no control. */
export interface CloseConfirmAnchor {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface CloseConfirmState {
  /** `seq` changes on every open, so the popover remounts with fresh state. */
  pending: { terminalId: string; anchor: CloseConfirmAnchor | null; seq: number } | null;
  open: (terminalId: string, anchor: CloseConfirmAnchor | null) => void;
  dismiss: () => void;
}

let seq = 0;

export const useCloseConfirmStore = create<CloseConfirmState>((set) => ({
  pending: null,
  open: (terminalId, anchor) => set({ pending: { terminalId, anchor, seq: ++seq } }),
  dismiss: () => set({ pending: null }),
}));

function anchorOf(el: Element | null | undefined): CloseConfirmAnchor | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}

/**
 * Single-session close entry point for user-initiated closes (card X,
 * middle-click, context menu, header button, Ctrl+W). Asks first via the
 * CloseSessionConfirm popover unless the user turned confirmation off. Task
 * sessions skip the popover: requestCloseTerminal already opens the finish
 * dialog for them, which is its own confirmation.
 *
 * Resolves immediately when the popover opens; the close itself runs when
 * the user confirms. Rejects only when the close runs right away and fails,
 * so callers keep their existing toast + report handling.
 */
export function closeWithConfirm(id: string, anchorEl?: Element | null): Promise<void> {
  const terminal = useTerminalStore.getState().terminals.get(id);
  if (!terminal) return Promise.resolve();
  if (terminal.config.task || !useAppStore.getState().confirmCloseSession) {
    return requestCloseTerminal(id);
  }
  // The header button is the natural anchor for Ctrl+W when it is on screen.
  const anchor = anchorOf(anchorEl ?? document.querySelector('[data-close-session-anchor]'));
  useCloseConfirmStore.getState().open(id, anchor);
  return Promise.resolve();
}

/** Warning line for a session that would lose work, named after its agent
 *  (Claude Code, Codex, a custom agent...). Null when the agent is idle. */
export function closeConfirmWarning(agentName: string, state: SessionState | undefined): string | null {
  if (state === 'busy') return `${agentName} is still working on a response.`;
  if (state === 'waiting') return `${agentName} is waiting for your input.`;
  return null;
}

const MARGIN = 8;
const GAP = 6;

/**
 * Where to put the popover: under the anchor, right edges aligned, flipped
 * above when it would run off the bottom, clamped inside the viewport.
 * Without an anchor it sits centred near the top of the window.
 */
export function confirmPopoverPosition(
  anchor: CloseConfirmAnchor | null,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const clampX = (x: number) => Math.min(Math.max(x, MARGIN), viewport.width - size.width - MARGIN);
  if (!anchor) return { left: clampX((viewport.width - size.width) / 2), top: 64 };
  const left = clampX(anchor.right - size.width);
  const below = anchor.bottom + GAP;
  const top = below + size.height + MARGIN <= viewport.height
    ? below
    : Math.max(MARGIN, anchor.top - GAP - size.height);
  return { left, top };
}
