// Store-aware PR helpers shared by the tab chip, context menus, the command
// palette and the poller. Kept apart from `pullRequests.ts` because appStore
// imports that module, and these import appStore.

import { invoke } from '@tauri-apps/api/core';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { usePrStore } from '../store/prStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from './errorReporter';
import { buildFailingChecksPrompt, prKey } from './pullRequests';

export interface PrTarget {
  terminalId: string;
  /** Terminal cwd: a trusted path for every PR command. */
  path: string;
  root: string;
  branch: string;
  key: string;
}

/** The branch a terminal is on, as a PR key. Null for shells, script
 *  children, non-repos and detached HEADs. */
export function terminalPrTarget(terminalId: string): PrTarget | null {
  const { terminals, gitInfoCache } = useTerminalStore.getState();
  const t = terminals.get(terminalId);
  if (!t || t.isShellTerminal || t.scriptParentId) return null;
  const git = gitInfoCache.get(terminalId);
  const branch = git?.current_branch;
  if (!git?.is_git_repo || !branch || branch === 'HEAD') return null;
  const root = git.worktree_root ?? t.config.working_directory;
  return { terminalId, path: t.config.working_directory, root, branch, key: prKey(root, branch) };
}

export function openPullRequestUrl(url: string): void {
  invoke('open_external_url', { url }).catch((err) => {
    toast.error('Could not open the pull request', String(err));
    reportInvokeFailure('open_external_url', err);
  });
}

/** Entry point for the palette, tab menu and commit toolbar. */
export function openCreatePrForTerminal(terminalId: string | null): void {
  if (!terminalId) {
    toast.info('Create pull request', 'Open a session in a git repository first.');
    return;
  }
  const t = useTerminalStore.getState().terminals.get(terminalId);
  const git = useTerminalStore.getState().gitInfoCache.get(terminalId);
  if (!t?.config.working_directory || !git?.is_git_repo) {
    toast.info('Create pull request', 'This session is not in a git repository.');
    return;
  }
  useAppStore.getState().openCreatePrModal(t.config.working_directory, terminalId);
}

/** Stage a prompt with the failing checks (and gh's failed-job log when it
 *  can read one) in the terminal's prompt editor. Never sends it. */
export async function sendFailingChecksToAgent(terminalId: string): Promise<void> {
  const target = terminalPrTarget(terminalId);
  const status = target ? usePrStore.getState().statuses[target.key] : undefined;
  if (!target || !status || status.ci.state !== 'failure') {
    toast.info('No failing checks', 'CI is not failing on this pull request right now.');
    return;
  }
  let logs: string | null = null;
  try {
    logs = await invoke<string | null>('get_failing_check_logs', { path: target.path, branch: target.branch });
  } catch {
    // Logs are an optional extra: the prompt still names every failing check
    // and links to it, and the backend already reported any internal error.
  }
  const prompt = buildFailingChecksPrompt(status, logs);
  const app = useAppStore.getState();
  app.setPromptDraft(terminalId, prompt);
  useTerminalStore.getState().setActiveTerminal(terminalId);
  app.openPromptEditor(terminalId, prompt);
}
