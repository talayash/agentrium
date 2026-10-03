import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from './errorReporter';
import { confirmAction } from './confirmDialog';
import { writePromptToTerminal } from './promptSend';
import { reopenContender, type Race, type RaceContender } from './races';
import type { RaceRow } from '../hooks/useRaceRows';

// User actions shared by the race header and the sidebar group. Kept out of
// the component files so React Fast Refresh keeps working on them.

export function focusTerminal(id: string) {
  const app = useAppStore.getState();
  app.setActiveFilePath(null);
  useTerminalStore.getState().setActiveTerminal(id);
}

/** Reopen a contender's session from the race UI (user action). */
export async function reopenFromUi(race: Race, c: RaceContender): Promise<void> {
  try {
    const id = await reopenContender(race, c);
    focusTerminal(id);
  } catch (err) {
    // createTerminal already reported the IPC failure.
    toast.error('Could not reopen the session', String(err));
  }
}


/** Send the staged task to every contender still waiting for it. The user
 *  confirms first: the CLIs must be past any trust/login prompt. */
export async function sendToAllWaiting(race: Race, rows: RaceRow[]): Promise<void> {
  const waiting = rows.filter((r) => r.waiting && r.terminal);
  if (waiting.length === 0) return;
  const ok = await confirmAction(
    `Send the task to ${waiting.length} waiting contender(s)? Make sure each CLI is ready for input (past any trust or login prompt).`,
    { okLabel: 'Send' },
  );
  if (!ok) return;
  for (const r of waiting) {
    const id = r.terminal!.config.id;
    try {
      await writePromptToTerminal(id, race.prompt, true);
    } catch (err) {
      toast.error('Could not send the task', `${r.contender.label}: ${String(err)}`);
      reportInvokeFailure('write_to_terminal', err);
    }
  }
}
