import { invoke } from '@tauri-apps/api/core';
import { allAgentSpecs, defaultArgsFor, filterArgsForAgent, type AgentKind, type BuiltinAgentKind } from './agents';
import type { CredentialBinding } from './credentials';
import { reportInvokeFailure } from './errorReporter';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore, type MergeStrategy } from '../store/appStore';
import { useAgentRegistryStore } from '../store/agentRegistryStore';

/** Task metadata carried on a terminal (`TerminalConfig.task`). Mirrors
 *  `tasks::TaskInfo` in Rust, which serializes camelCase. */
export interface TaskInfo {
  title: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  repoPath: string;
  /** Set when the task is one contender of a race (`races.rs`). */
  raceId?: string | null;
}

export interface StartTaskResult {
  worktree_path: string;
  branch: string;
  base_branch: string;
  repo_path: string;
  copied_files: string[];
}

export interface TaskStatus {
  task: TaskInfo;
  exists: boolean;
  uncommitted: { path: string; status: string }[];
  ahead: number;
  behind: number;
  changed_files: string[];
  base_worktree: string | null;
  base_dirty: boolean;
}

export interface FinishTaskResult {
  merged: boolean;
  worktree_removed: boolean;
  branch_deleted: boolean;
  warning: string | null;
}

export interface ManagedTaskWorktree {
  task: TaskInfo;
  exists: boolean;
  orphaned: boolean;
}

export type MergeMode = 'fast-forward' | 'squash';
export type FinishChoice = 'merge' | 'keep' | 'discard';
export type FinishAction =
  | { kind: 'merge'; mode: MergeMode; message: string | null }
  | { kind: 'keep' }
  | { kind: 'discard'; confirm_unmerged: boolean };

export type NewTerminalIsolation = 'ask' | 'always' | 'never';

export const DEFAULT_SETUP_FILES = ['.env', '.env.local'];

export function setupFilesFor(repoPath: string, perRepo: Record<string, string[]>): string[] {
  return perRepo[repoPath] ?? DEFAULT_SETUP_FILES;
}

/** Restored rows come from SQLite JSON written by any past build; accept only
 *  a complete task so a truncated row can't produce a half-task terminal. */
export function normalizeTask(raw: unknown): TaskInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const keys = ['title', 'branch', 'baseBranch', 'worktreePath', 'repoPath'] as const;
  if (!keys.every(k => typeof t[k] === 'string' && (t[k] as string).length > 0)) return null;
  const task: TaskInfo = { title: t.title as string, branch: t.branch as string, baseBranch: t.baseBranch as string,
    worktreePath: t.worktreePath as string, repoPath: t.repoPath as string };
  if (typeof t.raceId === 'string' && t.raceId) task.raceId = t.raceId;
  return task;
}

export function taskFromStart(title: string, r: StartTaskResult): TaskInfo {
  return { title: title.trim(), branch: r.branch, baseBranch: r.base_branch, worktreePath: r.worktree_path, repoPath: r.repo_path };
}

/** Seed the finish dialog from the Git "default merge strategy" setting:
 *  FF-only users get fast-forward when it is possible, everyone else squash. */
export function defaultMergeMode(strategy: MergeStrategy, behind: number): MergeMode {
  return strategy === 'ff-only' && behind === 0 ? 'fast-forward' : 'squash';
}

export function buildSquashMessage(title: string, files: string[]): string {
  const head = title.trim();
  if (files.length === 0) return head;
  const shown = files.slice(0, 50).map(f => `- ${f}`);
  if (files.length > 50) shown.push(`- ...and ${files.length - 50} more`);
  return `${head}\n\n${shown.join('\n')}`;
}

/** Why a merge cannot run right now, or null. Mirrors the backend refusals so
 *  the dialog can explain before the user clicks. */
export function mergeBlockReason(status: TaskStatus, mode: MergeMode): string | null {
  const { task } = status;
  if (status.base_dirty) {
    return `${task.baseBranch} has uncommitted changes${status.base_worktree ? ` in ${status.base_worktree}` : ''}. Commit or stash them first.`;
  }
  if (status.ahead === 0) {
    return status.uncommitted.length > 0
      ? 'The task has no commits yet. Commit its changes first.'
      : 'The task branch has no commits to merge.';
  }
  if (mode === 'fast-forward' && status.behind > 0) {
    return `${task.baseBranch} moved on by ${status.behind} commit(s). Fast-forward is impossible; use squash.`;
  }
  if (mode === 'squash' && !status.base_worktree) {
    return `${task.baseBranch} is not checked out anywhere. Check it out to squash-merge.`;
  }
  return null;
}

/** Map a dialog choice to the backend action. Discarding unmerged commits
 *  needs an explicit second confirmation. */
export function finishActionFor(
  choice: FinishChoice,
  opts: { mode: MergeMode; message: string; ahead: number; confirmedDiscard: boolean },
): FinishAction | 'needs-confirmation' {
  if (choice === 'merge') return { kind: 'merge', mode: opts.mode, message: opts.message.trim() || null };
  if (choice === 'keep') return { kind: 'keep' };
  if (opts.ahead > 0 && !opts.confirmedDiscard) return 'needs-confirmation';
  return { kind: 'discard', confirm_unmerged: opts.ahead > 0 };
}

/** The subset of a saved profile (`get_profiles`) a task launch uses. */
export interface TaskProfile {
  id: string;
  name: string;
  working_directory: string;
  agent: AgentKind;
  claude_args: string[];
  env_vars: Record<string, string>;
  agent_args?: Partial<Record<AgentKind, string[]>>;
  credential_bindings?: CredentialBinding[];
  is_default?: boolean;
}

export interface LaunchConfig {
  args: string[];
  envVars: Record<string, string>;
  bindings: CredentialBinding[];
}

/** Same resolution as New Session: args are profile.agent_args[agent], else
 *  the legacy claude_args when the agent is the profile's own, else the
 *  global defaults; profile key pins win over agent defaults, and a bound
 *  env var is never also passed as plaintext. Without a profile, defaults. */
export function resolveLaunchConfig(
  agent: AgentKind,
  profile: TaskProfile | null | undefined,
  defaultAgentArgs: Record<BuiltinAgentKind, string[]>,
  agentDefaultBindings: CredentialBinding[],
): LaunchConfig {
  if (!profile) return { args: defaultArgsFor(agent, defaultAgentArgs), envVars: {}, bindings: agentDefaultBindings };
  const saved = profile.agent_args?.[agent];
  const legacy = agent === profile.agent && profile.claude_args.length > 0 ? profile.claude_args : undefined;
  const args = filterArgsForAgent(agent, saved && saved.length > 0 ? saved : legacy ?? defaultArgsFor(agent, defaultAgentArgs));
  const merged = new Map<string, CredentialBinding>();
  for (const b of agentDefaultBindings) merged.set(b.env, b);
  for (const b of profile.credential_bindings ?? []) merged.set(b.env, b);
  const envVars = { ...(profile.env_vars ?? {}) };
  for (const env of merged.keys()) delete envVars[env];
  return { args, envVars, bindings: [...merged.values()] };
}

export interface StartTaskParams {
  repoPath: string;
  title: string;
  baseBranch?: string | null;
  branchName?: string | null;
}

export async function startTask(p: StartTaskParams): Promise<StartTaskResult> {
  const app = useAppStore.getState();
  return invoke<StartTaskResult>('start_task', {
    request: {
      repo_path: p.repoPath,
      title: p.title,
      base_branch: p.baseBranch?.trim() || null,
      branch_name: p.branchName?.trim() || null,
      worktree_root: app.taskWorktreeRoot.trim() || null,
      setup_files: setupFilesFor(p.repoPath, app.taskSetupFiles),
    },
  });
}

export interface LaunchTaskParams extends StartTaskParams {
  agent: AgentKind;
  /** Stage the title in the prompt editor (never typed into the PTY). */
  titleAsPrompt: boolean;
  /** Extra text staged instead of the title (handoff brief on fork). */
  promptText?: string;
  /** Launch with this saved profile's args, env vars and key pins. */
  profile?: TaskProfile | null;
}

/** Create the task worktree, then a terminal working in it. If the terminal
 *  cannot start, the fresh worktree and branch are rolled back. */
export async function launchTask(p: LaunchTaskParams): Promise<string> {
  if (!p.title.trim()) throw new Error('Give the task a title.');
  if (!allAgentSpecs().some(spec => spec.kind === p.agent)) throw new Error('The selected agent is no longer available.');
  const result = await startTask(p);
  const task = taskFromStart(p.title, result);
  const launch = resolveLaunchConfig(
    p.agent, p.profile, useAppStore.getState().defaultAgentArgs,
    useAgentRegistryStore.getState().defaultBindingsFor(p.agent),
  );
  let id: string;
  try {
    id = await useTerminalStore.getState().createTerminal(
      task.title, task.worktreePath, launch.args, launch.envVars,
      undefined, task.title, undefined, undefined, false, undefined, p.agent,
      launch.bindings, task,
    );
  } catch (err) {
    // Fresh branch, no commits: discarding loses nothing.
    await invoke('finish_task', { worktreePath: task.worktreePath, action: { kind: 'discard', confirm_unmerged: false } })
      .catch((e) => reportInvokeFailure('finish_task', e));
    throw err;
  }
  const prompt = p.promptText ?? (p.titleAsPrompt ? task.title : '');
  if (prompt) {
    // A new CLI may still be showing a trust or login prompt: stage the text
    // as the terminal's prompt-editor draft instead of writing it into the
    // PTY. The editor is not opened here; the user opens it (Ctrl+Shift+E or
    // the status-bar pencil) once the agent is ready. Handoff opens it itself.
    useAppStore.getState().setPromptDraft(id, prompt);
  }
  return id;
}

export async function getTaskStatus(worktreePath: string): Promise<TaskStatus> {
  return invoke<TaskStatus>('get_task_status', { worktreePath });
}

export async function finishTask(worktreePath: string, action: FinishAction): Promise<FinishTaskResult> {
  return invoke<FinishTaskResult>('finish_task', { worktreePath, action });
}

export async function commitTaskChanges(worktreePath: string, message: string): Promise<void> {
  await invoke('commit_task_changes', { worktreePath, message });
}

/** Repository root a terminal belongs to: its task's repo, else the main
 *  repo of its git checkout (a linked worktree resolves to the main repo). */
export function repoPathForTerminal(id: string | null): string | null {
  if (!id) return null;
  const { terminals, gitInfoCache } = useTerminalStore.getState();
  const t = terminals.get(id);
  if (t?.config.task) return t.config.task.repoPath;
  const info = gitInfoCache.get(id);
  if (!info?.is_git_repo) return null;
  return (info.is_worktree ? info.main_repo_path : info.worktree_root) ?? null;
}

/** Distinct repos of all open sessions, active session first. */
export function knownRepoPaths(): string[] {
  const { terminals, activeTerminalId } = useTerminalStore.getState();
  const ids = [activeTerminalId, ...terminals.keys()];
  const key = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const out: string[] = [];
  for (const id of ids) {
    const repo = repoPathForTerminal(id);
    if (repo && !out.some(r => key(r) === key(repo))) out.push(repo);
  }
  return out;
}

/** Where a saved terminal should respawn. A task terminal reopens in its
 *  worktree with its task; if the worktree is gone (finished elsewhere,
 *  deleted by hand) it falls back to the repo root without the task. */
export async function restoreTargetFor(config: { working_directory: string; task?: unknown }): Promise<{
  cwd: string; task: TaskInfo | null; worktreeMissing: boolean;
}> {
  const task = normalizeTask(config.task);
  if (!task) return { cwd: config.working_directory, task: null, worktreeMissing: false };
  try {
    await invoke('validate_session_directory', { path: task.worktreePath });
    return { cwd: task.worktreePath, task, worktreeMissing: false };
  } catch {
    // Expected when the worktree was removed: the caller tells the user.
    return { cwd: task.repoPath, task: null, worktreeMissing: true };
  }
}

/** Close entry point for single-session closes (card X, middle-click, Ctrl+W,
 *  header button). Task terminals open the finish dialog first; the dialog
 *  closes the terminal itself once the user decides. */
export async function requestCloseTerminal(id: string): Promise<void> {
  const terminal = useTerminalStore.getState().terminals.get(id);
  if (terminal?.config.task) {
    useAppStore.getState().openFinishTask(id, true);
    return;
  }
  await useTerminalStore.getState().closeTerminal(id);
}
