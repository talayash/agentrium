import { describe, expect, it } from 'vitest';
import { buildReviewQueue, groupFor, isReadyToMerge, pendingItemCount, type ReviewQueueInput } from './reviewQueue';
import type { AttentionItem } from '../store/attentionStore';
import type { TerminalConfig, TerminalInstance } from '../store/terminalStore';
import type { TaskStatus } from './tasks';
import type { PullRequestStatus } from './pullRequests';
import type { Race, RaceCheckResult } from './races';

const task = { title: 'Fix login', branch: 'agentrium/fix-login', baseBranch: 'main', worktreePath: '/wt/fix-login', repoPath: '/repos/app' };

function terminal(id: string, patch: Partial<TerminalConfig> = {}, extra: Partial<TerminalInstance> = {}): TerminalInstance {
  return { xterm: null, isWorktree: false, ...extra, config: {
    id, label: `Session ${id}`, nickname: null, profile_id: null, working_directory: '/repos/app', claude_args: [], env_vars: {},
    created_at: '', status: 'Running', color_tag: null, agent: 'claude', ...patch,
  } };
}

function item(terminalId: string, kind: AttentionItem['kind'], patch: Partial<AttentionItem> = {}): AttentionItem {
  return { terminalId, targetId: terminalId, kind, title: `Session ${terminalId}`, detail: `${kind} detail`, createdAt: 1, ...patch };
}

function status(patch: Partial<TaskStatus> = {}): TaskStatus {
  return { task, exists: true, uncommitted: [], ahead: 2, behind: 0, changed_files: ['a.ts', 'b.ts', 'c.ts'], base_worktree: '/repos/app', base_dirty: false, ...patch };
}

function check(exit_code: number | null): { result: RaceCheckResult } {
  return { result: { exit_code, timed_out: false, cancelled: false, duration_ms: 1, output_tail: '', truncated: false } };
}

function input(patch: Partial<ReviewQueueInput>): ReviewQueueInput {
  return { items: [], terminals: new Map(), terminalStates: new Map(), tasks: {}, prStatus: () => undefined, races: {}, checks: {},
    agentName: (k) => (k === 'claude' ? 'Claude Code' : k), ...patch };
}

describe('groupFor', () => {
  it('maps attention kinds onto queue groups', () => {
    expect(groupFor({ kind: 'input' })).toBe('input');
    expect(groupFor({ kind: 'error' })).toBe('checks');
    expect(groupFor({ kind: 'ci' })).toBe('checks');
    expect(groupFor({ kind: 'review' })).toBe('review');
    expect(groupFor({ kind: 'stopped' })).toBe('review');
    expect(groupFor({ kind: 'race' })).toBe('review');
    expect(groupFor({ kind: 'merged' })).toBe('review');
    expect(groupFor({ kind: 'merge' })).toBe('merge');
    expect(groupFor({ kind: 'ci', reviewedAt: 5 })).toBe('reviewed');
  });
});

describe('isReadyToMerge', () => {
  it('needs commits, a clean worktree and an existing worktree', () => {
    expect(isReadyToMerge(status())).toBe(true);
    expect(isReadyToMerge(status({ ahead: 0 }))).toBe(false);
    expect(isReadyToMerge(status({ uncommitted: [{ path: 'a.ts', status: 'M' }] }))).toBe(false);
    expect(isReadyToMerge(status({ exists: false }))).toBe(false);
  });
});

describe('buildReviewQueue', () => {
  it('orders groups and sorts newest first inside a group', () => {
    const terminals = new Map(['a', 'b', 'c', 'd'].map(id => [id, terminal(id)]));
    const entries = buildReviewQueue(input({ terminals, items: [
      item('a', 'review', { createdAt: 1 }),
      item('b', 'input', { createdAt: 2 }),
      item('c', 'review', { createdAt: 3 }),
      item('d', 'ci', { createdAt: 4, reviewedAt: 9 }),
    ] }));
    expect(entries.map(e => [e.group, e.item.terminalId])).toEqual([
      ['input', 'b'], ['review', 'c'], ['review', 'a'], ['reviewed', 'd'],
    ]);
  });

  it('shows one entry per terminal and channel even if the store held a duplicate', () => {
    const terminals = new Map([['a', terminal('a')]]);
    const entries = buildReviewQueue(input({ terminals, items: [item('a', 'review', { createdAt: 2 }), item('a', 'input'), item('a', 'ci')] }));
    expect(entries.map(e => e.key).sort()).toEqual(['a:pr', 'a:session']);
  });

  it('folds a settled session item into the task ready-to-merge entry', () => {
    const terminals = new Map([['a', terminal('a', { task })]]);
    const items = [item('a', 'merge', { createdAt: 2 }), item('a', 'review')];
    const entries = buildReviewQueue(input({ terminals, tasks: { a: { status: status() } }, items }));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ group: 'merge', kinds: ['merge', 'review'], canFinishTask: true });
    expect(pendingItemCount(items)).toBe(1);
  });

  it('keeps folding once both halves are reviewed', () => {
    const terminals = new Map([['a', terminal('a', { task })]]);
    const entries = buildReviewQueue(input({ terminals, items: [item('a', 'merge', { reviewedAt: 3 }), item('a', 'review', { reviewedAt: 3 })] }));
    expect(entries.map(e => [e.group, e.kinds])).toEqual([['reviewed', ['merge', 'review']]]);
  });

  it('keeps an input request separate from the merge entry', () => {
    const terminals = new Map([['a', terminal('a', { task })]]);
    const entries = buildReviewQueue(input({ terminals, items: [item('a', 'merge'), item('a', 'input')] }));
    expect(entries.map(e => e.group)).toEqual(['input', 'merge']);
  });

  it('labels observed evidence apart from CI, inferred and agent-reported text', () => {
    const terminals = new Map([['a', terminal('a', { task, status: 'Error' }, { exitCode: 2, sessionSummary: 'All tests pass.' })]]);
    const pr: PullRequestStatus = { number: 7, url: 'u', provider: 'github', state: 'open', draft: false, review_decision: null, mergeable: null,
      ci: { state: 'success', total: 4, failing: [] } };
    const [entry] = buildReviewQueue(input({ terminals, items: [item('a', 'error')], tasks: { a: { status: status() } }, prStatus: () => pr,
      checks: { '/wt/fix-login': check(1) } }));
    expect(entry.group).toBe('checks');
    expect(entry.evidence).toEqual(expect.arrayContaining([
      { source: 'observed', text: 'Process exited with code 2', tone: 'bad' },
      { source: 'observed', text: '3 changed files vs main' },
      { source: 'observed', text: '2 commits ahead' },
      { source: 'observed', text: 'Local check failed (exit 1)', tone: 'bad' },
      { source: 'ci', text: 'PR #7: 4 checks passing', tone: 'good' },
      { source: 'reported', text: 'All tests pass.' },
    ]));
    // The agent's "tests pass" claim is never shown as observed.
    expect(entry.evidence.filter(e => e.source === 'observed').some(e => /pass/.test(e.text))).toBe(false);
  });

  it('marks prompts as inferred and reports a missing exit code honestly', () => {
    const terminals = new Map([['a', terminal('a')], ['b', terminal('b', { status: 'Stopped' })]]);
    const entries = buildReviewQueue(input({ terminals, items: [item('a', 'input'), item('b', 'stopped')] }));
    expect(entries[0].evidence).toEqual([{ source: 'inferred', text: 'Terminal output looks like a prompt waiting for an answer' }]);
    expect(entries[1].evidence[0]).toEqual({ source: 'observed', text: 'Process exited (no exit code reported)', tone: undefined });
  });

  it('flags closed sessions, removed worktrees, failed status reads and unloaded races without throwing', () => {
    const terminals = new Map([['w', terminal('w', { task })], ['e', terminal('e', { task })]]);
    const entries = buildReviewQueue(input({ terminals,
      tasks: { w: { status: status({ exists: false }) }, e: { error: 'git missing' } },
      items: [item('gone', 'review'), item('w', 'review'), item('e', 'review'), item('w', 'race', { raceId: 'r404' })] }));
    const byKey = Object.fromEntries(entries.map(e => [e.key, e]));
    expect(byKey['gone:session']).toMatchObject({ stale: 'The session was closed.', terminalId: null, canOpenDiff: false });
    expect(byKey['w:session']).toMatchObject({ stale: 'The task worktree was removed.', canOpenDiff: false, canFinishTask: false });
    expect(byKey['e:session'].evidence[0]).toEqual({ source: 'observed', text: 'Task status unavailable', tone: 'bad' });
    expect(byKey['w:race'].stale).toBe('This race is no longer loaded.');
  });

  it('describes race items from the race and its observed check runs', () => {
    const race = { id: 'r1', title: 'Pick a parser', repoPath: '/repos/app', baseBranch: 'main', contenders: [
      { label: 'Claude', worktreePath: '/wt/a' }, { label: 'Codex', worktreePath: '/wt/b' },
    ] } as unknown as Race;
    const terminals = new Map([['a', terminal('a', { task: { ...task, raceId: 'r1' } })]]);
    const [entry] = buildReviewQueue(input({ terminals, races: { r1: race }, items: [item('a', 'race', { raceId: 'r1', title: 'Pick a parser' })],
      checks: { '/wt/a': check(0) } }));
    expect(entry).toMatchObject({ title: 'Pick a parser', agent: '2 contenders', location: 'main (app)', canOpenDiff: false, canFinishTask: false });
    expect(entry.evidence[0]).toEqual({ source: 'observed', text: 'Claude: check passed', tone: 'good' });
  });

  it('shows the session nickname, agent and worktree location', () => {
    const terminals = new Map([['a', terminal('a', { nickname: 'Login fix', task, agent: 'codex' })]]);
    const [entry] = buildReviewQueue(input({ terminals, items: [item('a', 'review')] }));
    expect(entry).toMatchObject({ title: 'Login fix', agent: 'codex', location: 'agentrium/fix-login (worktree of app)' });
  });
});
