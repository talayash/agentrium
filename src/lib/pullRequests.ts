// Create Pull Request flow: types mirroring `pull_requests.rs` (snake_case on
// the wire) plus the pure pieces the modal, the tab chip and the status poller
// share. No tokens live here: the backend drives the user's gh / glab CLI or
// hands back a browser compare URL.

import type { TaskInfo } from './tasks';
import { handoffLatestText, handoffTaskText } from './sessionNarrative';

export type PrProvider = 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'unknown';
export type PrCli = 'gh' | 'glab';

export interface CliStatus { installed: boolean; authenticated: boolean }

export interface RemoteInfo {
  remote: string;
  host: string;
  owner: string;
  repo: string;
  provider: PrProvider;
  web_url: string;
  gh: CliStatus;
  glab: CliStatus;
  /** CLI that `create_pull_request` will use; null = browser only. */
  cli: PrCli | null;
}

export type PrState = 'open' | 'closed' | 'merged';
export type CiState = 'none' | 'pending' | 'success' | 'failure';
export interface FailingCheck { name: string; url: string | null }

export interface PullRequestStatus {
  number: number;
  url: string;
  provider: PrProvider;
  state: PrState;
  draft: boolean;
  review_decision: 'approved' | 'changes_requested' | 'review_required' | null;
  mergeable: 'mergeable' | 'conflicting' | 'unknown' | null;
  ci: { state: CiState; total: number; failing: FailingCheck[] };
}

export interface CreatedPullRequest { url: string; number: number; provider: PrProvider; already_existed: boolean }
export interface PrCommit { short_sha: string; subject: string }
export interface PrFile { status: string; path: string }
export interface PrContext { commits: PrCommit[]; files: PrFile[]; base_ref: string }
export interface CompareUrl { url: string; body: 'full' | 'truncated' | 'omitted' }

/** What a tab remembers about its branch's PR (persisted in prStore). The
 *  `last*` fields are the last polled values, so a transition that happened
 *  while the app was closed still raises one attention item. */
export interface PrRef {
  url: string;
  number: number;
  provider: PrProvider;
  lastState?: PrState;
  lastCi?: CiState;
  updatedAt: number;
}

export type PrMethodPreference = 'auto' | 'gh' | 'browser';
export type PrMethod =
  | { kind: 'cli'; cli: PrCli }
  | { kind: 'browser'; reason: string | null };

export const DEFAULT_PR_BODY_TEMPLATE = '## Summary\n\n{summary}\n\n## Changes\n\n{files}\n\n## Commits\n\n{commits}';

const MAX_FILES = 100;
const MAX_COMMITS = 50;

/** `auto` and `gh` both prefer a signed-in CLI; `gh` only differs in saying
 *  why it fell back. `browser` never touches a CLI. */
export function choosePrMethod(pref: PrMethodPreference, info: RemoteInfo | null): PrMethod {
  if (pref === 'browser') return { kind: 'browser', reason: null };
  if (info?.cli) return { kind: 'cli', cli: info.cli };
  if (!info) return { kind: 'browser', reason: null };
  // No CLI covers these forges; the browser is the only path, not a fallback.
  if (info.provider === 'bitbucket' || info.provider === 'azure') return { kind: 'browser', reason: null };
  const want: PrCli = info.provider === 'gitlab' ? 'glab' : 'gh';
  const st = info[want];
  if (!st.installed) return { kind: 'browser', reason: pref === 'gh' ? `${want} is not installed.` : null };
  return { kind: 'browser', reason: `${want} is not signed in to ${info.host}. Run \`${want} auth login\`.` };
}

export function prMethodLabel(m: PrMethod): string {
  return m.kind === 'cli' ? `via ${m.cli}` : 'opens in browser';
}

const FILE_STATUS: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' };

export function formatPrFiles(files: PrFile[]): string {
  if (files.length === 0) return '_No file changes._';
  const lines = files.slice(0, MAX_FILES).map(f => `- \`${f.path}\` (${FILE_STATUS[f.status.charAt(0)] ?? f.status})`);
  if (files.length > MAX_FILES) lines.push(`- ...and ${files.length - MAX_FILES} more files`);
  return lines.join('\n');
}

export function formatPrCommits(commits: PrCommit[]): string {
  if (commits.length === 0) return '_No commits yet._';
  const lines = commits.slice(0, MAX_COMMITS).map(c => `- ${c.subject} (${c.short_sha})`);
  if (commits.length > MAX_COMMITS) lines.push(`- ...and ${commits.length - MAX_COMMITS} more commits`);
  return lines.join('\n');
}

/** Session goal and latest context, the same pieces the handoff brief uses. */
export function prSummaryFor(terminal: Parameters<typeof handoffTaskText>[0] | null | undefined): string {
  if (!terminal) return '';
  return [handoffTaskText(terminal), handoffLatestText(terminal)].filter(Boolean).join('\n\n');
}

export function renderPrBody(
  template: string,
  vars: { title: string; summary: string; files: string; commits: string },
): string {
  const tpl = template.trim() ? template : DEFAULT_PR_BODY_TEMPLATE;
  // One pass so a value containing "{files}" is never expanded again.
  const out = tpl.replace(/\{(title|summary|files|commits)\}/g, (_, k: keyof typeof vars) => vars[k]);
  // An empty {summary} leaves an empty section; drop the blank-line pile-up.
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** Task title first, then the newest commit's subject. */
export function defaultPrTitle(task: TaskInfo | null | undefined, commits: PrCommit[]): string {
  return task?.title?.trim() || commits[0]?.subject?.trim() || '';
}

/** Head branch is pushed and up to date when it tracks an upstream and has
 *  nothing left to push. */
export function needsPush(preview: { has_upstream: boolean; ahead: number }): boolean {
  return !preview.has_upstream || preview.ahead > 0;
}

/** Stable key for a branch's PR: the worktree root plus the branch name.
 *  Windows paths compare case-insensitively. */
export function prKey(root: string, branch: string): string {
  let p = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-z]:\//i.test(p)) p = p.toLowerCase();
  return `${p}\u0000${branch}`;
}

export type PrEvent =
  | { kind: 'ci-failed'; status: PullRequestStatus }
  | { kind: 'merged'; status: PullRequestStatus };

/** Events worth an attention item: CI flipping to failure on an open PR, and
 *  the PR becoming merged. A ref with no recorded state (first sighting of a
 *  PR created elsewhere) is a baseline, not a transition. */
export function prTransitions(prev: Pick<PrRef, 'lastState' | 'lastCi'> | undefined, next: PullRequestStatus): PrEvent[] {
  if (!prev || prev.lastState === undefined) return [];
  const events: PrEvent[] = [];
  if (next.state === 'merged' && prev.lastState !== 'merged') events.push({ kind: 'merged', status: next });
  if (next.state === 'open' && next.ci.state === 'failure' && prev.lastCi !== 'failure') {
    events.push({ kind: 'ci-failed', status: next });
  }
  return events;
}

export function buildFailingChecksPrompt(status: PullRequestStatus, logs: string | null): string {
  const checks = status.ci.failing.length
    ? status.ci.failing.map(c => `- ${c.name}${c.url ? `: ${c.url}` : ''}`).join('\n')
    : '- (the forge did not name the failing checks)';
  return [
    `CI is failing on pull request #${status.number} (${status.url}).`,
    '',
    'Failing checks:',
    checks,
    ...(logs ? ['', 'Failed job logs (truncated):', '', logs] : []),
    '',
    'Find the cause, reproduce it locally where you can, fix it, and commit the fix. Do not push until I confirm.',
  ].join('\n');
}

export function buildPrDraftPrompt(base: string, head: string, ctx: PrContext | null): string {
  const range = ctx?.base_ref ?? base;
  return [
    `Draft a pull request title and description for branch \`${head}\` into \`${base}\`.`,
    `Review the changes with \`git log ${range}..HEAD\` and \`git diff ${range}...HEAD\`.`,
    'Reply with the title on the first line, a blank line, then a Markdown description with Summary, Changes and Testing sections.',
    'Do not create the pull request, push, or change any files.',
  ].join('\n');
}
