import { useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useInsightModel } from '../../hooks/useInsightFeed';
import { useTerminalDrawer } from '../../hooks/useTerminalDrawer';
import { useTerminalStore } from '../../store/terminalStore';
import { InsightLayer } from './InsightLayer';
import { InsightStatusLine, useSessionEnded } from './InsightStatusLine';
import { PromptBar, type PromptBarHandle } from './PromptBar';

/**
 * Insight mode: an opaque view over the real terminal. It must be rendered as a
 * sibling of the xterm container inside the same `relative` pane; both are
 * `absolute inset-0`, so the terminal keeps the pane's full size behind this
 * view and opening or closing the drawer never changes the xterm box (no fit,
 * no PTY resize). The drawer only hides this view and overlays a header strip.
 *
 * The tailer runs inside InsightLayer, so there is exactly one per terminal.
 */
export function InsightOnlyView({ terminalId }: { terminalId: string }) {
  const model = useInsightModel(terminalId);
  const questionPending = model.pendingQuestion !== null;
  const drawer = useTerminalDrawer(terminalId, true, questionPending);
  const busy = useTerminalStore((s) => s.terminalStates.get(terminalId) === 'busy');
  const isActive = useTerminalStore((s) => s.activeTerminalId === terminalId);
  const ended = useSessionEnded(terminalId);
  const barRef = useRef<PromptBarHandle>(null);

  let disabledReason: string | null = null;
  if (ended) disabledReason = 'Session ended';
  else if (questionPending) disabledReason = 'Answer the question above';
  else if (drawer.open) disabledReason = 'The terminal is open';

  const focusBar = useCallback(() => {
    if (useTerminalStore.getState().activeTerminalId !== terminalId) return;
    barRef.current?.focus();
  }, [terminalId]);

  // Entering Insight mode, selecting this session, and opening or closing the
  // drawer move focus, but only while this is the active terminal so another
  // pane never loses focus. Runs after commit, so the bar is already enabled
  // again when the drawer closes.
  useEffect(() => {
    if (!isActive) return;
    if (drawer.open) useTerminalStore.getState().terminals.get(terminalId)?.xterm?.focus();
    else barRef.current?.focus();
  }, [isActive, drawer.open, terminalId]);

  return (
    <>
      <div
        data-testid="insight-only-view"
        aria-hidden={drawer.open || undefined}
        style={drawer.open ? { visibility: 'hidden' } : undefined}
        className={`absolute inset-0 z-10 flex flex-col bg-bg-primary${drawer.open ? ' pointer-events-none' : ''}`}
      >
        <div className="min-h-0 flex-1">
          <InsightLayer terminalId={terminalId} variant="fill" onEscape={focusBar} />
        </div>
        <InsightStatusLine terminalId={terminalId} />
        <PromptBar
          ref={barRef}
          terminalId={terminalId}
          disabledReason={disabledReason}
          busy={busy}
          onShowTerminal={drawer.openByUser}
        />
      </div>
      {drawer.open && (
        <div
          data-testid="terminal-drawer-header"
          className="absolute left-0 right-0 top-0 z-20 flex h-7 items-center justify-between border-b border-seam bg-elevation-1 pl-3 pr-1 text-[11px] text-text-secondary"
        >
          <span className="uppercase tracking-wide">Terminal</span>
          <button
            type="button"
            onClick={drawer.close}
            aria-label="Close terminal"
            title="Back to insight"
            className="flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:bg-elevation-2 hover:text-text-primary focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent-primary/45"
          >
            <X size={12} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      )}
    </>
  );
}
