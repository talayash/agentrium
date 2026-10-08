// CI repair loop: from a PR with failing checks, start an agent in a fresh
// task worktree branched off the PR branch, with a brief built from the
// failing checks, their logs, the PR description, the changed files and the
// latest commit. Nothing here pushes: the user reviews the task, finishes it
// into the PR branch through the normal finish dialog, and pushes from there.

import { invoke } from '@tauri-apps/api/core';
import type { AgentKind } from './agents';
import { terminalPrTarget, type PrTarget } from './pullRequestActions';
import {
  ciRepairTaskTitle, type CiRepairContext, type PrContext, type PullRequestDetails,
} from './pullRequests';
import { launchTask, needsStaging, repoPathForTerminal } from './tasks';
import { useAppStore } from '../store/appStore';
import { useCiRepairStore, worktreeKey, type CiRepair } from '../store/ciRepairStore';
import { usePrStore } from '../store/prStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';

export interface LoadedCiRepair {
  target: PrTarget;
  repoPath: string;
  context: CiRepairContext;
  /** Brief sections that could not be loaded, for the review dialog. */
  unavailable: string[];
}

/** Whether a terminal's branch has an open PR with failing CI right now. */
export function canRepairCi(terminalId: string): boolean {
  const target = terminalPrTarget(terminalId);
  const status = target ? usePrStore.getState().statuses[target.key] : undefined;
  return !!status && status.state === 'open' && status.ci.state === 'failure';
}

/** Entry point for the command palette: opens the review dialog for the
 *  given session, or explains why it cannot. */
export function openCiRepairForTerminal(terminalId: string | null): void {
  if (!terminalId || !canRepairCi(terminalId)) {
    toast.info('No failing checks', 'Open a session whose branch has a pull request with failing CI.');
    return;
  }
  useAppStore.getState().openCiRepair(terminalId);
}

export async function loadCiRepairContext(terminalId: string): Promise<LoadedCiRepair> {
  const target = terminalPrTarget(terminalId);
  const status = target ? usePrStore.getState().statuses[target.key] : undefined;
  if (!target || !status || status.state !== 'open' || status.ci.state !== 'failure') {
    throw new Error('CI is not failing on this pull request right now.');
  }
  const repoPath = repoPathForTerminal(terminalId);
  if (!repoPath) throw new Error('This session is not in a git repository.');

  // Every piece is optional context: the brief names what is missing, and
  // the backend's wrap_cmd already reported any internal failure.
  const [logs, details] = await Promise.all([
    invoke<string | null>('get_failing_check_logs', { path: target.path, branch: target.branch }).catch(() => null),
    invoke<PullRequestDetails | null>('get_pull_request_details', { path: target.path, branch: target.branch }).catch(() => null),
  ]);
  const changes = details?.base_branch
    ? await invoke<PrContext>('get_pr_context', { path: target.path, base: details.base_branch }).catch(() => null)
    : null;

  const unavailable: string[] = [];
  if (!logs) unavailable.push('failed job logs');
  if (!details) unavailable.push('pull request description');
  if (!changes) unavailable.push('changed files and latest commit');
  return { target, repoPath, context: { status, branch: target.branch, logs, details, changes }, unavailable };
}

/** Open terminal working in a repair's worktree, if any. */
export function terminalForRepair(repair: CiRepair): string | null {
  const key = worktreeKey(repair.worktreePath);
  for (const [id, t] of useTerminalStore.getState().terminals) {
    if (t.config.task && worktreeKey(t.config.task.worktreePath) === key) return id;
  }
  return null;
}

/** The newest repair for a PR whose task session is still open. */
export function openRepairFor(repairs: Record<string, CiRepair>, prKey: string): { repair: CiRepair; terminalId: string } | null {
  const candidates = Object.values(repairs).filter(r => r.prKey === prKey).sort((a, b) => b.startedAt - a.startedAt);
  for (const repair of candidates) {
    const terminalId = terminalForRepair(repair);
    if (terminalId) return { repair, terminalId };
  }
  return null;
}

export function focusTerminal(id: string): void {
  const app = useAppStore.getState();
  app.setSplitMode(false);
  if (app.gridMode) app.toggleGridMode();
  useTerminalStore.getState().setActiveTerminal(id);
}

export interface LaunchCiRepairResult {
  terminalId: string;
  /** True when the brief waits in the prompt editor instead of reaching the
   *  agent at spawn. */
  staged: boolean;
}

/** Start the repair task. `launchTask` rolls the fresh worktree back if the
 *  agent cannot start, so a failure here leaves nothing behind. */
export async function launchCiRepair(loaded: LoadedCiRepair, agent: AgentKind, brief: string): Promise<LaunchCiRepairResult> {
  if (!brief.trim()) throw new Error('Add a repair brief before starting.');
  const { target, repoPath, context } = loaded;
  const terminalId = await launchTask({
    repoPath, title: ciRepairTaskTitle(context.status), baseBranch: target.branch,
    agent, titleAsPrompt: false, promptText: brief, deliverPromptAtSpawn: true,
  });
  const task = useTerminalStore.getState().terminals.get(terminalId)?.config.task;
  if (task) {
    useCiRepairStore.getState().addRepair({
      prKey: target.key, prNumber: context.status.number, prUrl: context.status.url,
      branch: target.branch, worktreePath: task.worktreePath,
    });
  }
  const staged = needsStaging(useTerminalStore.getState().terminals.get(terminalId)?.config.prompt_delivery);
  focusTerminal(terminalId);
  if (staged) useAppStore.getState().openPromptEditor(terminalId, brief);
  return { terminalId, staged };
}
