import { useTerminalStore } from '../../store/terminalStore';
import { readBufferTail } from '../../hooks/useSessionStateDetection';
import { hasOptionMenu } from '../../lib/terminalState';

const TAIL_ROWS = 15;

/** Body for agents without a transcript: session state only, no scraped data.
 *  State comes from the shared poller via the store; the buffer tail is read
 *  on render, and only while the session is waiting. */
export function InsightFallback({ terminalId }: { terminalId: string }) {
  const sessionState = useTerminalStore((s) => s.terminalStates.get(terminalId)) ?? 'idle';
  const xterm = useTerminalStore.getState().terminals.get(terminalId)?.xterm;
  const menuOpen = sessionState === 'waiting' && !!xterm && hasOptionMenu(readBufferTail(xterm, TAIL_ROWS));

  return (
    <div className="flex flex-col gap-1 px-2 py-2 text-[11px] text-text-tertiary">
      <div className="flex items-center gap-2">
        <span className="rounded border border-seam px-1.5 py-0.5 text-text-secondary">{sessionState}</span>
        {menuOpen && <span className="text-text-secondary">An option menu is open in the terminal</span>}
      </div>
      <div>No structured data for this agent</div>
    </div>
  );
}
