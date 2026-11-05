import { Loader2, RotateCw } from 'lucide-react';
import { useTerminalStore } from '../../store/terminalStore';
import { restartTerminal } from '../../lib/restartTerminal';

/** True once the session's process is gone (terminal status Stopped or Error,
 *  or the state detector saw the process exit). */
export function useSessionEnded(terminalId: string): boolean {
  const status = useTerminalStore((s) => s.terminals.get(terminalId)?.config.status);
  const state = useTerminalStore((s) => s.terminalStates.get(terminalId));
  return status === 'Stopped' || status === 'Error' || state === 'stopped';
}

/** Thin live-progress line above the prompt bar in Insight mode. */
export function InsightStatusLine({ terminalId }: { terminalId: string }) {
  const state = useTerminalStore((s) => s.terminalStates.get(terminalId));
  const ended = useSessionEnded(terminalId);

  let content;
  if (ended) {
    content = (
      <>
        <span className="text-text-secondary">Session ended</span>
        <button
          type="button"
          onClick={() => void restartTerminal(terminalId)}
          className="ml-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-text-secondary hover:bg-elevation-2 hover:text-text-primary focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent-primary/45"
        >
          <RotateCw size={11} strokeWidth={1.75} aria-hidden />
          Restart
        </button>
      </>
    );
  } else if (state === 'busy') {
    content = (
      <>
        <Loader2 size={11} strokeWidth={1.75} className="animate-spin text-accent-primary" aria-hidden data-testid="insight-status-spinner" />
        <span className="text-text-secondary">Working...</span>
      </>
    );
  } else if (state === 'waiting') {
    content = <span className="text-text-primary">Waiting for you</span>;
  } else {
    content = <span className="text-text-tertiary">Idle</span>;
  }

  return (
    <div role="status" className="flex h-6 shrink-0 items-center gap-1.5 border-t border-seam bg-bg-primary px-3 text-[11px]">
      {content}
    </div>
  );
}
