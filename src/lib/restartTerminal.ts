import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from './errorReporter';
import { viewModeOf } from './viewMode';

/** Close a session and start a fresh one with the same settings, keeping its
 *  view mode. Failures are toasted and reported, never silent. */
export async function restartTerminal(id: string): Promise<void> {
  const { terminals, closeTerminal, createTerminal } = useTerminalStore.getState();
  const instance = terminals.get(id);
  if (!instance) return;
  const { label, working_directory, claude_args, env_vars, color_tag, nickname, agent } = instance.config;
  const viewMode = viewModeOf(instance.config);
  try {
    await closeTerminal(id);
    await createTerminal(label, working_directory, claude_args, env_vars, color_tag || undefined, nickname || undefined, undefined, undefined, undefined, undefined, agent, undefined, undefined, { viewMode });
  } catch (err) {
    // A failure here can leave the user with no terminal at all - never silent.
    toast.error('Restart failed', 'Could not restart the terminal.');
    reportInvokeFailure('restart_terminal', err);
  }
}
