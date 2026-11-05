import { useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useInsightModel } from '../../hooks/useInsightFeed';
import { useTerminalDrawer } from '../../hooks/useTerminalDrawer';
import { useInsightStore } from '../../store/insightStore';
import { useTerminalStore } from '../../store/terminalStore';
import { effectiveViewMode } from '../../lib/viewMode';
import { Tooltip } from '../ui/Tooltip';
import { InsightLayer } from './InsightLayer';
import { InsightStatusLine, useSessionEnded } from './InsightStatusLine';
import { PromptBar, type PromptBarHandle } from './PromptBar';

/** A key in the prompt bar this recently means the user is typing: an
 *  auto-opened drawer then must not move their keystrokes into the terminal. */
export const TYPING_GRACE_MS = 1000;

/**
 * Insight mode: an opaque view over the real terminal. It must be rendered as a
 * sibling of the xterm container inside the same `relative` pane; both are
 * `absolute inset-0`, so the terminal keeps the pane's full size behind this
 * view and opening or closing the drawer never changes the xterm box (no fit,
 * no PTY resize). The drawer only hides this view and overlays a small
 * floating close button, so no terminal row is covered.
 *
 * The tailer runs inside InsightLayer, so there is exactly one per terminal.
 */
export function InsightOnlyView({ terminalId }: { terminalId: string }) {
  const model = useInsightModel(terminalId);
  const pendingQuestion = model.pendingQuestion?.questions[0] ?? null;
  const drawer = useTerminalDrawer(terminalId, true, pendingQuestion);
  const questionShown = model.pendingQuestion !== null && drawer.questionShown;
  const busy = useTerminalStore((s) => s.terminalStates.get(terminalId) === 'busy');
  const isActive = useTerminalStore((s) => s.activeTerminalId === terminalId);
  const ended = useSessionEnded(terminalId);
  const barRef = useRef<PromptBarHandle>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // The agent waits in the hidden terminal and the user closed the drawer:
  // typing in the bar would go nowhere useful, so the bar stays disabled.
  const terminalNeedsYou = drawer.needs && !drawer.open;

  let disabledReason: string | null = null;
  if (ended) disabledReason = 'Session ended';
  else if (questionShown) disabledReason = 'Answer the question above';
  else if (drawer.open) disabledReason = 'The terminal is open';
  else if (terminalNeedsYou) disabledReason = 'The agent is waiting in the terminal';
  const disabledRef = useRef(disabledReason !== null);
  disabledRef.current = disabledReason !== null;

  const focusBar = useCallback(() => {
    if (useTerminalStore.getState().activeTerminalId !== terminalId) return;
    barRef.current?.focus();
  }, [terminalId]);

  // Publish the drawer state so focusTerminalInput and the file drop can route
  // input outside this tree. Cleared on unmount (leaving Insight mode).
  useEffect(() => {
    useInsightStore.getState().setDrawerOpen(terminalId, drawer.open);
  }, [terminalId, drawer.open]);
  useEffect(() => () => {
    useInsightStore.getState().setDrawerOpen(terminalId, false);
    // Leaving Insight mode (to Mixed or CLI) unmounts the bar: hand focus to
    // the terminal, but only for the active session that is still open.
    const ts = useTerminalStore.getState();
    const instance = ts.terminals.get(terminalId);
    if (ts.activeTerminalId === terminalId && instance?.config && effectiveViewMode(instance) !== 'insight') {
      instance.xterm?.focus();
    }
  }, [terminalId]);

  // Entering Insight mode, selecting this session, and opening or closing the
  // drawer move focus, but only while this is the active terminal so another
  // pane never loses focus. Runs after commit, so the bar is already enabled
  // again when the drawer closes.
  useEffect(() => {
    if (!isActive) return;
    const xterm = useTerminalStore.getState().terminals.get(terminalId)?.xterm;
    if (drawer.open) {
      // An auto-open while the user is typing in the bar must not redirect the
      // rest of their keystrokes into the PTY: park focus on the close button.
      const typing = drawer.openedBy === 'auto'
        && Date.now() - (barRef.current?.lastKeyAt() ?? 0) < TYPING_GRACE_MS;
      if (typing) closeRef.current?.focus();
      else xterm?.focus();
      return;
    }
    if (!disabledRef.current) {
      barRef.current?.focus();
      return;
    }
    // The bar is disabled (question, ended, terminal needs you): never leave
    // focus in the hidden xterm. Park it on the question box or the view, and
    // let the bar take it back once it is enabled again.
    xterm?.blur();
    barRef.current?.focus();
    const box = viewRef.current?.querySelector<HTMLElement>('[data-question-box]');
    (box ?? viewRef.current)?.focus({ preventScroll: true });
    // openedBy only changes together with open, so it adds no extra runs.
  }, [isActive, drawer.open, drawer.openedBy, terminalId]);

  return (
    <>
      <div
        ref={viewRef}
        tabIndex={-1}
        data-focus-parking=""
        data-testid="insight-only-view"
        aria-hidden={drawer.open || undefined}
        style={drawer.open ? { visibility: 'hidden' } : undefined}
        className={`absolute inset-0 z-10 flex flex-col bg-bg-primary focus:outline-none${drawer.open ? ' pointer-events-none' : ''}`}
      >
        <div className="min-h-0 flex-1">
          <InsightLayer terminalId={terminalId} variant="fill" onEscape={focusBar} questionShown={questionShown} />
        </div>
        <InsightStatusLine terminalId={terminalId} />
        <PromptBar
          ref={barRef}
          terminalId={terminalId}
          disabledReason={disabledReason}
          busy={busy}
          onShowTerminal={drawer.openByUser}
          terminalNeedsYou={terminalNeedsYou}
        />
      </div>
      {drawer.open && (
        <div data-testid="terminal-drawer-close" className="absolute right-2 top-2 z-20">
          <Tooltip label="Back to insight" side="left">
            <button
              ref={closeRef}
              type="button"
              onClick={drawer.close}
              aria-label="Close terminal"
              className="flex h-6 w-6 items-center justify-center rounded-md border border-seam bg-elevation-1 text-text-tertiary shadow-sm hover:bg-elevation-2 hover:text-text-primary focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent-primary/45"
            >
              <X size={12} strokeWidth={1.75} aria-hidden />
            </button>
          </Tooltip>
        </div>
      )}
    </>
  );
}
