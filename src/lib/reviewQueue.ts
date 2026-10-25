// Review Queue: a read-only projection of the attention store across every
// open session. The attention store stays the only source of truth for what
// needs the user; this module groups its items, folds duplicates and attaches
// evidence. Pure (no store imports) so grouping and dedup are unit-testable.

import { channelOf, type AttentionChannel, type AttentionItem } from '../store/attentionStore';
import type { TerminalInstance } from '../store/terminalStore';
import type { SessionState } from './terminalState';
import type { TaskStatus } from './tasks';
import type { PullRequestStatus } from './pullRequests';
import { checkSummary, checkVerdict, pathKey, type Race, type RaceCheckResult } from './races';

export type ReviewGroup = 'input' | 'checks' | 'review' | 'merge' | 'reviewed';

export const REVIEW_GROUPS: { id: ReviewGroup; label: string }[] = [
  { id: 'input', label: 'Needs input' },
  { id: 'checks', label: 'Checks failed' },
  { id: 'review', label: 'Ready to review' },
  { id: 'merge', label: 'Ready to merge' },
  { id: 'reviewed', label: 'Reviewed' },
];

/** Why an item needs attention, in the app's existing status vocabulary. */
export const REASON_LABEL: Record<AttentionItem['kind'], string> = {
  input: 'Needs input', review: 'Ready to review', error: 'Process failed', stopped: 'Process finished',
  ci: 'CI failing', merged: 'Pull request merged', race: 'Race ready to compare', merge: 'Ready to merge',
};

/**
 * Where a piece of evidence came from. Only `observed` facts were seen by
 * Agentrium itself (process exit, git, a check command it ran). `ci` is what
 * the PR provider reports through gh / glab. `inferred` is a heuristic read of
 * terminal output, and `reported` is the agent's own text, never verified.
 */
export type EvidenceSource = 'observed' | 'ci' | 'inferred' | 'reported';

export const EVIDENCE_LABEL: Record<EvidenceSource, string> = {
  observed: 'Observed', ci: 'CI provider', inferred: 'Inferred', reported: 'Agent reported',
};

export interface Evidence {
  source: EvidenceSource;
  text: string;
  tone?: 'good' | 'bad';
}

/** Last observed task worktree status for one terminal (`get_task_status`). */
export type TaskObservation = { status: TaskStatus } | { error: string };

export interface ReviewEntry {
  key: string;
  group: ReviewGroup;
  channel: AttentionChannel;
  item: AttentionItem;
  /** Kinds folded into this entry (the item's own kind first). */
  kinds: AttentionItem['kind'][];
  reason: string;
  title: string;
  agent: string | null;
  /** The session's agent, for its brand icon; null for race entries. */
  agentKind: TerminalInstance['config']['agent'] | null;
  location: string | null;
  context: string;
  evidence: Evidence[];
  /** The session behind the item is gone or its worktree no longer exists. */
  stale: string | null;
  terminalId: string | null;
  canOpenDiff: boolean;
  canFinishTask: boolean;
  canFixCi: boolean;
}

export interface ReviewQueueInput {
  items: AttentionItem[];
  terminals: Map<string, TerminalInstance>;
  terminalStates: Map<string, SessionState>;
  tasks: Record<string, TaskObservation>;
  /** Live PR status for a terminal's branch, if one is tracked. */
  prStatus: (terminalId: string) => PullRequestStatus | undefined;
  races: Record<string, Race>;
  /** Local check runs keyed by `pathKey(worktreePath)`. */
  checks: Record<string, { result: RaceCheckResult | null } | undefined>;
  agentName: (agent: string) => string;
}

export function groupFor(item: Pick<AttentionItem, 'kind' | 'reviewedAt'>): ReviewGroup {
  if (item.reviewedAt) return 'reviewed';
  switch (item.kind) {
    case 'input': return 'input';
    case 'error': case 'ci': return 'checks';
    case 'merge': return 'merge';
    default: return 'review';
  }
}

/** Ready to merge: the task branch has commits, nothing is left uncommitted,
 *  and the worktree still exists. Mirrors the finish dialog's own refusals
 *  only loosely; the dialog re-checks before anything is merged. */
export function isReadyToMerge(status: TaskStatus): boolean {
  return status.exists && status.ahead > 0 && status.uncommitted.length === 0;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function processEvidence(t: TerminalInstance): Evidence | null {
  const { status } = t.config;
  if (status !== 'Error' && status !== 'Stopped') return null;
  if (typeof t.exitCode === 'number') {
    return { source: 'observed', text: `Process exited with code ${t.exitCode}`, tone: t.exitCode === 0 ? undefined : 'bad' };
  }
  return { source: 'observed', text: status === 'Error' ? 'Process reported a failure (no exit code)' : 'Process exited (no exit code reported)', tone: status === 'Error' ? 'bad' : undefined };
}

function taskEvidence(obs: TaskObservation | undefined): Evidence[] {
  if (!obs) return [];
  if ('error' in obs) return [{ source: 'observed', text: 'Task status unavailable', tone: 'bad' }];
  const s = obs.status;
  if (!s.exists) return [{ source: 'observed', text: 'Worktree no longer exists', tone: 'bad' }];
  const out: Evidence[] = [{ source: 'observed', text: `${plural(s.changed_files.length, 'changed file')} vs ${s.task.baseBranch}` }];
  out.push({ source: 'observed', text: `${plural(s.ahead, 'commit')} ahead${s.behind ? `, ${s.behind} behind` : ''}` });
  if (s.uncommitted.length > 0) out.push({ source: 'observed', text: `${plural(s.uncommitted.length, 'uncommitted file')}` });
  return out;
}

function ciEvidence(pr: PullRequestStatus | undefined): Evidence[] {
  if (!pr) return [];
  const { ci } = pr;
  const head = `PR #${pr.number}`;
  if (ci.state === 'failure') {
    const names = ci.failing.map(c => c.name).slice(0, 3).join(', ');
    return [{ source: 'ci', text: `${head}: ${plural(ci.failing.length, 'failing check')}${names ? ` (${names})` : ''}`, tone: 'bad' }];
  }
  if (ci.state === 'success') return [{ source: 'ci', text: `${head}: ${plural(ci.total, 'check')} passing`, tone: 'good' }];
  if (ci.state === 'pending') return [{ source: 'ci', text: `${head}: checks pending` }];
  return pr.state === 'merged' ? [{ source: 'ci', text: `${head} merged`, tone: 'good' }] : [];
}

function checkEvidence(label: string, result: RaceCheckResult | null | undefined): Evidence | null {
  const verdict = checkVerdict(result);
  if (!verdict) return null;
  return { source: 'observed', text: `${label}check ${checkSummary(result)}`, tone: verdict === 'pass' ? 'good' : 'bad' };
}

function inferredEvidence(kind: AttentionItem['kind']): Evidence | null {
  if (kind === 'input') return { source: 'inferred', text: 'Terminal output looks like a prompt waiting for an answer' };
  if (kind === 'review') return { source: 'inferred', text: 'Terminal output settled after activity' };
  return null;
}

function locationOf(t: TerminalInstance): string {
  const task = t.config.task;
  if (task) return `${task.branch} (worktree of ${baseName(task.repoPath)})`;
  return t.config.working_directory;
}

function baseName(p: string): string {
  const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

// Session items a "Ready to merge" item on the same terminal already covers.
const FOLDED_INTO_MERGE = new Set<AttentionItem['kind']>(['review', 'stopped']);

/** Build the queue. Entries come back grouped in REVIEW_GROUPS order, newest
 *  first within a group. */
export function buildReviewQueue(input: ReviewQueueInput): ReviewEntry[] {
  const { items, terminals, tasks } = input;
  // terminalId -> whether its "Ready to merge" item is reviewed. A settled
  // session item in the same state folds into it instead of showing twice.
  const mergeFor = new Map(items.filter(i => i.kind === 'merge').map(i => [i.terminalId, !!i.reviewedAt]));
  const folds = (i: AttentionItem) => FOLDED_INTO_MERGE.has(i.kind) && mergeFor.get(i.terminalId) === !!i.reviewedAt;
  const seen = new Set<string>();
  const entries: ReviewEntry[] = [];

  for (const item of items) {
    const channel = channelOf(item.kind);
    const key = `${item.terminalId}:${channel}`;
    // The store keeps one item per slot; guard anyway so a stray duplicate
    // can never render twice.
    if (seen.has(key)) continue;
    seen.add(key);
    if (folds(item)) continue;

    const target = terminals.get(item.targetId) ?? terminals.get(item.terminalId);
    const race = item.raceId ? input.races[item.raceId] : undefined;
    const kinds: AttentionItem['kind'][] = [item.kind];
    if (item.kind === 'merge') {
      for (const other of items) {
        if (other.terminalId === item.terminalId && folds(other)) kinds.push(other.kind);
      }
    }

    const evidence: Evidence[] = [];
    let stale: string | null = null;
    let location: string | null = null;
    let agent: string | null = null;
    let context = item.detail;
    let canOpenDiff = false;
    let canFinishTask = false;
    let canFixCi = false;

    if (race) {
      location = `${race.baseBranch} (${baseName(race.repoPath)})`;
      agent = plural(race.contenders.length, 'contender');
      race.contenders.forEach((c) => {
        const e = checkEvidence(`${c.label}: `, input.checks[pathKey(c.worktreePath)]?.result);
        if (e) evidence.push(e);
      });
    } else if (item.raceId) {
      stale = 'This race is no longer loaded.';
    }

    if (target) {
      const task = target.config.task;
      agent ??= input.agentName(target.config.agent);
      location ??= locationOf(target);
      const scriptOwner = item.terminalId !== item.targetId ? terminals.get(item.terminalId) : undefined;
      const proc = processEvidence(scriptOwner ?? target);
      if (proc && (item.kind === 'error' || item.kind === 'stopped' || target.config.status !== 'Running')) evidence.push(proc);
      if (!item.raceId) {
        const obs = tasks[target.config.id];
        evidence.push(...taskEvidence(obs));
        if (obs && 'status' in obs && !obs.status.exists) stale = 'The task worktree was removed.';
        if (task) {
          const e = checkEvidence('Local ', input.checks[pathKey(task.worktreePath)]?.result);
          if (e) evidence.push(e);
        }
      }
      const pr = input.prStatus(target.config.id);
      evidence.push(...ciEvidence(pr));
      const inferred = inferredEvidence(item.kind);
      if (inferred) evidence.push(inferred);
      const reported = target.sessionContext?.latest || target.sessionSummary;
      if (reported) evidence.push({ source: 'reported', text: reported });
      canOpenDiff = !item.raceId && !stale && item.kind !== 'input';
      canFinishTask = !!task && !task.raceId && !stale && target.config.id === item.targetId;
      canFixCi = item.kind === 'ci' && pr?.ci.state === 'failure';
    } else if (!item.raceId) {
      stale = 'The session was closed.';
    }

    const title = (!race && target?.config.nickname) || item.title;
    const taskTitle = target?.config.task?.title;
    if (item.kind === 'merge' && taskTitle && taskTitle !== title) context = `${taskTitle}: ${item.detail}`;

    entries.push({
      key, group: groupFor(item), channel, item, kinds,
      reason: REASON_LABEL[item.kind],
      title,
      agent, agentKind: !race && target ? target.config.agent : null, location, context, evidence, stale,
      terminalId: target?.config.id ?? null,
      canOpenDiff, canFinishTask, canFixCi,
    });
  }

  const order = new Map(REVIEW_GROUPS.map((g, i) => [g.id, i]));
  return entries.sort((a, b) => order.get(a.group)! - order.get(b.group)! || b.item.createdAt - a.item.createdAt);
}

/** Entries still waiting on the user (not Reviewed), counted from the raw
 *  items with the same folding as buildReviewQueue. */
export function pendingItemCount(items: AttentionItem[]): number {
  const merge = new Set(items.filter(i => i.kind === 'merge' && !i.reviewedAt).map(i => i.terminalId));
  return items.filter(i => !i.reviewedAt && !(FOLDED_INTO_MERGE.has(i.kind) && merge.has(i.terminalId))).length;
}
