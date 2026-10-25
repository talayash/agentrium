import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { requestCloseTerminal } from '../lib/tasks';
import { specFor } from '../lib/agents';
import { sessionDisplayName } from '../lib/sessionContext';
import { closeConfirmWarning, confirmPopoverPosition, useCloseConfirmStore } from '../lib/closeConfirm';
import type { CloseConfirmAnchor } from '../lib/closeConfirm';

function agentDisplayName(kind: Parameters<typeof specFor>[0]): string {
  try {
    return specFor(kind).displayName;
  } catch {
    // A custom agent whose spec was deleted while its session stayed open.
    return 'The agent';
  }
}

/**
 * "Close this session?" popover, anchored to the control that asked for the
 * close (see closeWithConfirm). Enter or Close confirms, Escape, Cancel or a
 * click outside keeps the session. Mounted once in App.
 */
export function CloseSessionConfirm() {
  const pending = useCloseConfirmStore((s) => s.pending);
  if (!pending) return null;
  // Keyed per open: every prompt mounts fresh (checkbox off, placed, focused).
  return <ConfirmPopover key={pending.seq} terminalId={pending.terminalId} anchor={pending.anchor} />;
}

function ConfirmPopover({ terminalId, anchor }: { terminalId: string; anchor: CloseConfirmAnchor | null }) {
  const dismiss = useCloseConfirmStore((s) => s.dismiss);
  const terminal = useTerminalStore((s) => s.terminals.get(terminalId));
  const state = useTerminalStore((s) => s.terminalStates.get(terminalId));
  const [dontAsk, setDontAsk] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Drop the prompt if its session closed meanwhile.
  useEffect(() => {
    if (!terminal) dismiss();
  }, [terminal, dismiss]);

  // Place before paint, straight on the node: no state round trip, so the
  // popover is on screen in the same frame it mounts. Re-placed when the
  // warning line appears or goes and the height changes.
  const hasWarning = state === 'busy' || state === 'waiting';
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const { left, top } = confirmPopoverPosition(
      anchor,
      { width: box.offsetWidth, height: box.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  }, [anchor, hasWarning]);

  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  const cancel = () => {
    dismiss();
    const activeId = useTerminalStore.getState().activeTerminalId;
    if (activeId) useTerminalStore.getState().terminals.get(activeId)?.xterm?.focus();
  };

  const confirm = () => {
    if (dontAsk) useAppStore.getState().setConfirmCloseSession(false);
    dismiss();
    requestCloseTerminal(terminalId).catch((err) => {
      toast.error('Close failed', 'Could not close the session.');
      reportInvokeFailure('close_terminal', err);
    });
  };

  // Escape / outside click / window resize. Capture phase so the terminal
  // never sees the Escape. Handlers only read store state, so binding once
  // per mount is enough.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    };
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) dismiss();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', dismiss);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!terminal) return null;

  const name = sessionDisplayName(terminal);
  const warning = closeConfirmWarning(agentDisplayName(terminal.config.agent), state);

  return createPortal(
    <div
      ref={boxRef}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="close-session-confirm-title"
      aria-describedby="close-session-confirm-body"
      className="fixed z-[90] w-[268px] material-popover rounded-xl p-3 select-none ct-pop-in"
      style={{ transformOrigin: 'top right' }}
    >
      <h3 id="close-session-confirm-title" className="text-[13px] font-semibold text-text-primary truncate">
        Close &quot;{name}&quot;?
      </h3>
      <p id="close-session-confirm-body" className="mt-0.5 text-[12px] text-text-secondary">
        The terminal and its agent process will stop.
      </p>
      {warning && (
        <div role="status" className="mt-2 flex items-start gap-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-[11.5px] text-warning">
          <AlertTriangle size={12} strokeWidth={2} className="mt-[2px] flex-shrink-0" />
          <span>{warning}</span>
        </div>
      )}
      <div className="mt-3 flex items-center gap-1.5">
        <label className="mr-auto flex items-center gap-1.5 text-[11.5px] text-text-tertiary whitespace-nowrap cursor-pointer">
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e) => setDontAsk(e.target.checked)}
            className="accent-accent-primary"
          />
          Don&apos;t ask again
        </label>
        <button
          type="button"
          onClick={cancel}
          className="h-7 px-2.5 rounded-md text-[12px] font-medium text-text-primary bg-fill-hover hover:bg-fill-active ring-1 ring-inset ring-seam-strong transition-colors"
        >
          Cancel
        </button>
        <button
          ref={closeBtnRef}
          type="button"
          onClick={confirm}
          className="h-7 px-2.5 rounded-md text-[12px] font-semibold text-white bg-error hover:bg-error/90 transition-colors"
        >
          Close
        </button>
      </div>
    </div>,
    document.body,
  );
}
