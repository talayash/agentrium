import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PR_BODY_TEMPLATE, buildCiRepairBrief, buildFailingChecksPrompt, ciRepairTaskTitle, choosePrMethod, defaultPrTitle, formatPrCommits, formatPrFiles,
  needsPush, prKey, prMethodLabel, prSummaryFor, prTransitions, renderPrBody,
  type PullRequestStatus, type RemoteInfo,
} from './pullRequests';

const info = (over: Partial<RemoteInfo> = {}): RemoteInfo => ({
  remote: 'origin', host: 'github.com', owner: 'o', repo: 'r', provider: 'github', web_url: 'https://github.com/o/r',
  gh: { installed: true, authenticated: true }, glab: { installed: false, authenticated: false }, cli: 'gh', ...over,
});

const status = (over: Partial<PullRequestStatus> = {}, ci: Partial<PullRequestStatus['ci']> = {}): PullRequestStatus => ({
  number: 12, url: 'https://github.com/o/r/pull/12', provider: 'github', state: 'open', draft: false,
  review_decision: null, mergeable: 'mergeable', ...over,
  ci: { state: 'success', total: 2, failing: [], ...ci },
});

describe('choosePrMethod', () => {
  it('uses the signed-in CLI for auto and gh', () => {
    expect(choosePrMethod('auto', info())).toEqual({ kind: 'cli', cli: 'gh' });
    expect(choosePrMethod('gh', info({ provider: 'gitlab', cli: 'glab' }))).toEqual({ kind: 'cli', cli: 'glab' });
  });

  it('browser preference never uses a CLI', () => {
    expect(choosePrMethod('browser', info())).toEqual({ kind: 'browser', reason: null });
  });

  it('falls back to the browser and explains a signed-out CLI', () => {
    const m = choosePrMethod('auto', info({ cli: null, gh: { installed: true, authenticated: false } }));
    expect(m.kind).toBe('browser');
    expect(m.kind === 'browser' && m.reason).toContain('gh auth login');
  });

  it('only mentions a missing CLI when the user asked for it', () => {
    const noGh = info({ cli: null, gh: { installed: false, authenticated: false } });
    expect(choosePrMethod('auto', noGh)).toEqual({ kind: 'browser', reason: null });
    expect(choosePrMethod('gh', noGh)).toEqual({ kind: 'browser', reason: 'gh is not installed.' });
    const glab = info({ provider: 'gitlab', cli: null });
    expect(choosePrMethod('gh', glab)).toEqual({ kind: 'browser', reason: 'glab is not installed.' });
  });

  it('treats Bitbucket and Azure as browser-only without a warning', () => {
    expect(choosePrMethod('gh', info({ provider: 'bitbucket', cli: null }))).toEqual({ kind: 'browser', reason: null });
    expect(choosePrMethod('auto', info({ provider: 'azure', cli: null }))).toEqual({ kind: 'browser', reason: null });
  });

  it('labels the method for the footer', () => {
    expect(prMethodLabel({ kind: 'cli', cli: 'gh' })).toBe('via gh');
    expect(prMethodLabel({ kind: 'browser', reason: null })).toBe('opens in browser');
  });
});

describe('PR body prefill', () => {
  it('renders every placeholder once and collapses empty sections', () => {
    const body = renderPrBody('# {title}\n\n{summary}\n\n\n\n{files}\n{commits}', {
      title: 'Add search', summary: '', files: '- `a.ts` (added)', commits: '- one {files} (abc)',
    });
    // A value containing a placeholder is not expanded again.
    expect(body).toBe('# Add search\n\n- `a.ts` (added)\n- one {files} (abc)');
  });

  it('uses the default template when the setting is blank', () => {
    const body = renderPrBody('  ', { title: 'T', summary: 'S', files: 'F', commits: 'C' });
    expect(body).toBe(DEFAULT_PR_BODY_TEMPLATE.replace('{summary}', 'S').replace('{files}', 'F').replace('{commits}', 'C'));
  });

  it('formats files and commits with caps', () => {
    expect(formatPrFiles([{ status: 'A', path: 'src/a.ts' }, { status: 'R100', path: 'b.ts' }]))
      .toBe('- `src/a.ts` (added)\n- `b.ts` (renamed)');
    expect(formatPrFiles([])).toBe('_No file changes._');
    const many = Array.from({ length: 103 }, (_, i) => ({ status: 'M', path: `f${i}` }));
    expect(formatPrFiles(many).split('\n').pop()).toBe('- ...and 3 more files');
    expect(formatPrCommits([{ short_sha: 'abc1234', subject: 'Fix it' }])).toBe('- Fix it (abc1234)');
    expect(formatPrCommits([])).toBe('_No commits yet._');
  });

  it('takes the summary from the session context like the handoff brief', () => {
    expect(prSummaryFor({ sessionContext: { goal: 'Add search', latest: 'Index built' } })).toBe('Add search\n\nIndex built');
    expect(prSummaryFor({ sessionContext: null, sessionSummary: 'Did things' })).toBe('Did things');
    expect(prSummaryFor(null)).toBe('');
  });

  it('prefers the task title, then the newest commit subject', () => {
    const commits = [{ short_sha: 'b', subject: 'Newest' }, { short_sha: 'a', subject: 'Oldest' }];
    const task = { title: 'Add search', branch: 'agentrium/add-search', baseBranch: 'main', worktreePath: '/w', repoPath: '/r' };
    expect(defaultPrTitle(task, commits)).toBe('Add search');
    expect(defaultPrTitle(null, commits)).toBe('Newest');
    expect(defaultPrTitle(null, [])).toBe('');
  });

  it('needs a push when there is no upstream or unpushed commits', () => {
    expect(needsPush({ has_upstream: false, ahead: 0 })).toBe(true);
    expect(needsPush({ has_upstream: true, ahead: 2 })).toBe(true);
    expect(needsPush({ has_upstream: true, ahead: 0 })).toBe(false);
  });
});

describe('prKey', () => {
  it('normalizes separators, trailing slashes and Windows drive case', () => {
    expect(prKey('C:\\Repos\\App\\', 'feat/x')).toBe(prKey('c:/repos/app', 'feat/x'));
    expect(prKey('/home/u/App', 'x')).not.toBe(prKey('/home/u/app', 'x'));
    expect(prKey('/r', 'a')).not.toBe(prKey('/r', 'b'));
  });
});

describe('prTransitions', () => {
  it('treats a first sighting as a baseline', () => {
    expect(prTransitions(undefined, status({}, { state: 'failure' }))).toEqual([]);
    expect(prTransitions({}, status({ state: 'merged' }))).toEqual([]);
  });

  it('fires once when CI flips to failure on an open PR', () => {
    const failed = status({}, { state: 'failure', failing: [{ name: 'lint', url: null }] });
    expect(prTransitions({ lastState: 'open', lastCi: 'pending' }, failed).map(e => e.kind)).toEqual(['ci-failed']);
    expect(prTransitions({ lastState: 'open', lastCi: 'failure' }, failed)).toEqual([]);
    // A closed PR's red CI is not actionable.
    expect(prTransitions({ lastState: 'open', lastCi: 'pending' }, status({ state: 'closed' }, { state: 'failure' }))).toEqual([]);
  });

  it('fires when the PR becomes merged', () => {
    expect(prTransitions({ lastState: 'open', lastCi: 'success' }, status({ state: 'merged' })).map(e => e.kind)).toEqual(['merged']);
    expect(prTransitions({ lastState: 'merged', lastCi: 'success' }, status({ state: 'merged' }))).toEqual([]);
  });
});

it('builds a failing-checks prompt with names, URLs and logs', () => {
  const s = status({}, { state: 'failure', failing: [{ name: 'lint', url: 'https://x/1' }, { name: 'e2e', url: null }] });
  const prompt = buildFailingChecksPrompt(s, '### Run 1\n```\nboom\n```');
  expect(prompt).toContain('pull request #12 (https://github.com/o/r/pull/12)');
  expect(prompt).toContain('- lint: https://x/1\n- e2e');
  expect(prompt).toContain('boom');
  expect(buildFailingChecksPrompt(s, null)).not.toContain('Failed job logs');
});

describe('buildCiRepairBrief', () => {
  const failing = status({}, { state: 'failure', failing: [{ name: 'test', url: 'https://github.com/o/r/actions/runs/9/job/1' }] });

  it('includes checks, logs, description, latest commit and changed files, and forbids pushing', () => {
    const brief = buildCiRepairBrief({
      status: failing, branch: 'feat/login', logs: '### Run 9 boom',
      details: { title: 'Add login', body: 'Adds the login form.', base_branch: 'main', head_sha: 'abc1234def' },
      changes: { base_ref: 'origin/main', commits: [{ short_sha: 'abc1234', subject: 'Add form' }], files: [{ status: 'M', path: 'src/login.ts' }] },
    });
    expect(brief).toContain('# Fix failing CI on pull request #12: Add login');
    expect(brief).toContain('Branch: `feat/login` into `main`');
    expect(brief).toContain('- test: https://github.com/o/r/actions/runs/9/job/1');
    expect(brief).toContain('### Run 9 boom');
    expect(brief).toContain('Adds the login form.');
    expect(brief).toContain('Add form (abc1234)');
    expect(brief).toContain('- `src/login.ts` (modified)');
    expect(brief).toContain('Do not push');
    expect(brief).not.toContain('differs from the local branch head');
  });

  it('names every missing piece instead of dropping it', () => {
    const brief = buildCiRepairBrief({ status: failing, branch: 'feat/login', logs: null, details: null, changes: null });
    expect(brief.match(/_Not available/g)?.length).toBe(4);
    expect(brief).toMatch(/^# Fix failing CI on pull request #12$/m);
  });

  it('warns when CI ran on a different commit than the local head', () => {
    const brief = buildCiRepairBrief({
      status: failing, branch: 'b', logs: null,
      details: { title: '', body: '', base_branch: 'main', head_sha: 'fff0000aaa' },
      changes: { base_ref: 'main', commits: [{ short_sha: 'abc1234', subject: 's' }], files: [] },
    });
    expect(brief).toContain('CI ran on fff0000aaa');
    expect(brief).toContain('_The pull request has no description._');
  });

  it('titles the repair task after the PR number', () => {
    expect(ciRepairTaskTitle({ number: 7 })).toBe('Fix CI on #7');
  });
});
