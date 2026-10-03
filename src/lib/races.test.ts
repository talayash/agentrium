import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import {
  allSettled, argsWithModel, averageContenderCost, buildFileMatrix, buildJudgePrompt, checkVerdict, contenderLabel,
  deriveContenderState, launchRace, loserLoss, needsStaging, planDecision, promptDeliveryFor, racedAgainstTable,
  raceTabName, winRateFor, winRates,
  type ContenderDiff, type ContenderSignals, type LoserPlan, type Race, type RaceCheckResult, type RaceContender,
} from './races';
import { setCustomAgentSpecs, type AgentSpec } from './agents';
import { useAppStore } from '../store/appStore';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';

const signals = (s: Partial<ContenderSignals>): ContenderSignals => ({ terminalExists: true, manualDone: false, seenBusy: false, ...s });

function contender(idx: number, over: Partial<RaceContender> = {}): RaceContender {
  return {
    idx, agent: idx === 0 ? 'claude' : 'codex', model: null, args: [], label: idx === 0 ? 'Claude Code' : 'Codex',
    branch: `agentrium/race-fix-c${idx}`, worktreePath: `/wt/race-fix-c${idx}`, terminalId: null,
    startedAt: null, finishedAt: null, outcome: 'pending', stats: null, ...over,
  };
}

function race(over: Partial<Race> = {}): Race {
  return {
    id: 'r1', title: 'Fix bug', prompt: 'Fix the login bug', repoPath: '/repo', baseBranch: 'main',
    baseSha: '0123456789abcdef0123', createdAt: '2026-10-01T00:00:00Z', status: 'running', winnerTask: null,
    decidedAt: null, checkCommand: 'npm test', contenders: [contender(0), contender(1)], ...over,
  };
}

const diff = (files: [string, number | null, number | null, string?][], over: Partial<ContenderDiff> = {}): ContenderDiff => ({
  worktree_path: '/wt', exists: true, commits_ahead: 1, uncommitted: 0,
  files: files.map(([path, added, removed, status]) => ({ path, added, removed, status: status ?? 'M' })),
  added: files.reduce((a, f) => a + (f[1] ?? 0), 0), removed: files.reduce((a, f) => a + (f[2] ?? 0), 0), ...over,
});

const check = (over: Partial<RaceCheckResult>): RaceCheckResult => ({
  exit_code: 0, timed_out: false, cancelled: false, duration_ms: 10, output_tail: '', truncated: false, ...over,
});

describe('contender state derivation', () => {
  it('maps terminal and attention signals to race states', () => {
    expect(deriveContenderState(signals({}))).toBe('starting');
    expect(deriveContenderState(signals({ inferred: 'idle' }))).toBe('starting');
    expect(deriveContenderState(signals({ inferred: 'busy' }))).toBe('working');
    expect(deriveContenderState(signals({ inferred: 'waiting' }))).toBe('needs-input');
    expect(deriveContenderState(signals({ attention: 'input', inferred: 'idle' }))).toBe('needs-input');
    expect(deriveContenderState(signals({ attention: 'review' }))).toBe('done');
    expect(deriveContenderState(signals({ inferred: 'idle', seenBusy: true }))).toBe('done');
    expect(deriveContenderState(signals({ status: 'Stopped' }))).toBe('exited');
    expect(deriveContenderState(signals({ attention: 'stopped' }))).toBe('exited');
    expect(deriveContenderState(signals({ status: 'Error', inferred: 'busy' }))).toBe('error');
    expect(deriveContenderState(signals({ attention: 'error' }))).toBe('error');
    expect(deriveContenderState(signals({ terminalExists: false }))).toBe('exited');
  });

  it('lets the user mark a contender done whatever it is doing', () => {
    expect(deriveContenderState(signals({ inferred: 'busy', manualDone: true }))).toBe('done');
    expect(deriveContenderState(signals({ terminalExists: false, manualDone: true }))).toBe('done');
  });

  it('is ready to compare only when every contender settled', () => {
    expect(allSettled([])).toBe(false);
    expect(allSettled(['done', 'working'])).toBe(false);
    expect(allSettled(['done', 'needs-input'])).toBe(false);
    expect(allSettled(['done', 'exited', 'error'])).toBe(true);
  });
});

describe('file-touch matrix', () => {
  it('builds one cell per contender, most-contested files first', () => {
    const rows = buildFileMatrix([
      diff([['src/a.ts', 3, 1], ['README.md', 1, 0]]),
      diff([['src/a.ts', 10, 2], ['src/new.ts', 5, 0, '??']]),
      null,
    ]);
    expect(rows.map((r) => [r.path, r.touchedBy])).toEqual([['src/a.ts', 2], ['README.md', 1], ['src/new.ts', 1]]);
    expect(rows[0].cells).toEqual([
      { touched: true, status: 'M', added: 3, removed: 1 },
      { touched: true, status: 'M', added: 10, removed: 2 },
      { touched: false, status: null, added: null, removed: null },
    ]);
    expect(rows[2].cells[1]).toEqual({ touched: true, status: '??', added: 5, removed: 0 });
    expect(rows[2].cells[0].touched).toBe(false);
  });

  it('is empty when nobody changed anything', () => {
    expect(buildFileMatrix([diff([]), diff([])])).toEqual([]);
  });
});

describe('judge prompt', () => {
  it('includes the task, each contender\'s numstat, checks and worktrees, and forbids changes', () => {
    const r = race();
    const prompt = buildJudgePrompt(r, [
      diff([['src/a.ts', 3, 1], ['img.png', null, null, 'A']], { commits_ahead: 2, uncommitted: 1 }),
      diff([['src/a.ts', 10, 2]]),
    ], [check({ exit_code: 0 }), check({ exit_code: 1, output_tail: 'FAIL src/a.test.ts\nexpected 1 got 2' })]);
    expect(prompt).toContain('Fix the login bug');
    expect(prompt).toContain('do NOT modify any of them');
    expect(prompt).toContain('main at 0123456789ab');
    expect(prompt).toContain('## Contender A: Claude Code');
    expect(prompt).toContain('- Worktree: /wt/race-fix-c0');
    expect(prompt).toContain('2 commit(s) on top of the base, 1 uncommitted change(s)');
    expect(prompt).toContain('3\t1\tM\tsrc/a.ts');
    expect(prompt).toContain('-\t-\tA\timg.png');
    expect(prompt).toContain('- Check (`npm test`): passed');
    expect(prompt).toContain('## Contender B: Codex');
    expect(prompt).toContain('- Check (`npm test`): failed (exit 1)');
    expect(prompt).toContain('expected 1 got 2');
    expect(prompt).toContain('Recommend one winner');
  });

  it('copes with missing stats and checks', () => {
    const prompt = buildJudgePrompt(race({ checkCommand: null }), [null, undefined], []);
    expect(prompt).toContain('Diff stats unavailable');
    expect(prompt).toContain('- Check: not run');
  });
});

describe('check verdicts', () => {
  it('treats non-zero exits, timeouts and cancels as data', () => {
    expect(checkVerdict(null)).toBeNull();
    expect(checkVerdict(check({}))).toBe('pass');
    expect(checkVerdict(check({ exit_code: 2 }))).toBe('fail');
    expect(checkVerdict(check({ exit_code: null, timed_out: true }))).toBe('timeout');
    expect(checkVerdict(check({ exit_code: null, cancelled: true }))).toBe('cancelled');
  });
});

describe('decide dialog choices', () => {
  const loser = (over: Partial<LoserPlan>): LoserPlan => ({
    worktreePath: '/wt/b', label: 'Codex', branch: 'agentrium/b', keepBranch: false, ahead: 0, uncommitted: 0, confirmed: false, ...over,
  });

  it('merges the winner and discards clean losers without asking', () => {
    const plan = planDecision('r1', '/wt/a', { kind: 'merge', mode: 'squash', message: '  Fix bug  ' }, [loser({})], {});
    expect(plan).toEqual({ ok: true, request: {
      race_id: 'r1', winner_worktree: '/wt/a',
      winner_action: { kind: 'merge', mode: 'squash', message: 'Fix bug' },
      losers: [{ worktree_path: '/wt/b', keep_branch: false, confirm_unmerged: false }],
      stats: {},
    } });
  });

  it('asks before discarding a loser with unmerged commits or uncommitted changes', () => {
    const ahead = loser({ ahead: 2 });
    const dirty = loser({ worktreePath: '/wt/c', uncommitted: 3 });
    const plan = planDecision('r1', '/wt/a', { kind: 'pull-request' }, [ahead, dirty, loser({ worktreePath: '/wt/d' })], {});
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.needsConfirmation.map((l) => l.worktreePath)).toEqual(['/wt/b', '/wt/c']);
    expect(loserLoss(ahead)).toBe('2 unmerged commit(s)');
    expect(loserLoss({ ahead: 1, uncommitted: 2 })).toBe('1 unmerged commit(s) and 2 uncommitted change(s)');

    const confirmed = planDecision('r1', '/wt/a', { kind: 'pull-request' }, [{ ...ahead, confirmed: true }, { ...dirty, confirmed: true }], {});
    expect(confirmed.ok && confirmed.request.losers).toEqual([
      { worktree_path: '/wt/b', keep_branch: false, confirm_unmerged: true },
      { worktree_path: '/wt/c', keep_branch: false, confirm_unmerged: false },
    ]);
    expect(confirmed.ok && confirmed.request.winner_action).toEqual({ kind: 'pull-request' });
  });

  it('never asks when the loser keeps its branch', () => {
    const plan = planDecision('r1', '/wt/a', { kind: 'merge', mode: 'fast-forward', message: '' }, [loser({ ahead: 4, keepBranch: true })], {});
    expect(plan.ok && plan.request.losers).toEqual([{ worktree_path: '/wt/b', keep_branch: true, confirm_unmerged: false }]);
    expect(plan.ok && plan.request.winner_action).toEqual({ kind: 'merge', mode: 'fast-forward', message: null });
  });
});

describe('prompt delivery fallback for custom agents', () => {
  const custom = (id: string, initialPrompt: boolean): AgentSpec => ({
    kind: `custom:${id}`, displayName: id, binary: id, installUrl: '', installHint: '', defaultArgsHint: '', initialPrompt,
  });

  it('sends through argv only for agents that declare the capability', () => {
    setCustomAgentSpecs([custom('with', true), custom('without', false)]);
    expect(promptDeliveryFor('claude')).toBe('argv');
    expect(promptDeliveryFor('codex')).toBe('argv');
    expect(promptDeliveryFor('antigravity')).toBe('argv');
    expect(promptDeliveryFor('cursor')).toBe('staged');
    expect(promptDeliveryFor('custom:with')).toBe('argv');
    expect(promptDeliveryFor('custom:without')).toBe('staged');
    expect(promptDeliveryFor('custom:deleted')).toBe('staged');
    setCustomAgentSpecs([]);
  });

  it('stages whenever the backend did not deliver', () => {
    expect(needsStaging(undefined)).toBe(true);
    expect(needsStaging({ mode: 'staged' })).toBe(true);
    expect(needsStaging({ mode: 'argv' })).toBe(false);
    expect(needsStaging({ mode: 'file', path: '/p.md' })).toBe(false);
  });
});

describe('labels, args and history', () => {
  it('names contenders and their tabs', () => {
    expect(contenderLabel('codex', 'gpt-5.6-sol')).toBe('Codex · gpt-5.6-sol');
    expect(contenderLabel('claude', ' ')).toBe('Claude Code');
    expect(raceTabName(' Fix bug ', 'Codex · gpt-5.6-sol')).toBe('Race: Fix bug · Codex · gpt-5.6-sol');
  });

  it('replaces any model flag with the contender model', () => {
    expect(argsWithModel(['--model', 'opus', '--x', '--model=haiku'], 'sonnet')).toEqual(['--x', '--model', 'sonnet']);
    expect(argsWithModel(['--model', 'opus'], null)).toEqual(['--model', 'opus']);
  });

  it('computes win rates and average cost from decided races only', () => {
    const won = (agent: 'claude' | 'codex', model: string | null, outcome: string, cost: number | null) =>
      contender(0, { agent, model, outcome, label: contenderLabel(agent, model), stats: cost == null ? null : { elapsedMs: 1, costUsd: cost, tokens: 1, filesChanged: 1, added: 1, removed: 0, check: null } });
    const races = [
      race({ status: 'decided', contenders: [won('claude', 'opus', 'winner', 2), won('codex', null, 'discarded', null)] }),
      race({ status: 'decided', contenders: [won('claude', 'opus', 'discarded', 1), won('codex', null, 'winner', null)] }),
      race({ status: 'decided', contenders: [won('claude', 'opus', 'winner', 3), won('claude', 'sonnet', 'kept', null)] }),
      race({ status: 'abandoned', contenders: [won('codex', null, 'discarded', null), won('claude', 'opus', 'discarded', null)] }),
    ];
    const rates = winRates(races);
    expect(rates.map((r) => [r.label, r.wins, r.races])).toEqual([
      ['Claude Code · opus', 2, 3], ['Codex', 1, 2], ['Claude Code · sonnet', 0, 1],
    ]);
    expect(winRateFor(rates, 'codex', null)?.rate).toBe(0.5);
    expect(winRateFor(rates, 'cursor', null)).toBeNull();
    expect(averageContenderCost(races)).toEqual({ avg: 2, samples: 3 });
    expect(averageContenderCost([race()])).toBeNull();
  });

  it('renders the "Raced against" table for the PR body', () => {
    const r = race();
    const md = racedAgainstTable(r, '/wt/race-fix-c1', {
      '/wt/race-fix-c0': { elapsedMs: 65_000, costUsd: 1.234, tokens: 10, filesChanged: 2, added: 5, removed: 1, check: 'fail' },
      '/wt/race-fix-c1': { elapsedMs: 30_000, costUsd: null, tokens: null, filesChanged: 1, added: 3, removed: 0, check: 'pass' },
    });
    expect(md).toContain('### Raced against');
    expect(md).toContain('against Claude Code.');
    expect(md).toContain('| Claude Code | 1m 05s | $1.23 | 2 | +5 / -1 | fail |');
    expect(md).toContain('| **Codex** (winner) | 30s | – | 1 | +3 / -0 | pass |');
  });
});

describe('launchRace', () => {
  const baseConfig: TerminalConfig = {
    id: 'x', label: 'x', nickname: null, profile_id: null, working_directory: '/', claude_args: [], env_vars: {},
    created_at: '', status: 'Running', color_tag: null, agent: 'claude',
  };

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useTerminalStore.setState({ terminals: new Map() });
    useAppStore.setState({ promptDrafts: {}, gridMode: false, gridTerminalIds: [], taskWorktreeRoot: '', taskSetupFiles: {},
      defaultAgentArgs: { claude: [], codex: [], cursor: [], antigravity: [] } });
  });

  it('starts every contender from one race, delivers or stages the prompt, and opens a grid', async () => {
    const started = race({ contenders: [contender(0, { model: 'opus', label: 'Claude Code · opus' }), contender(1, { agent: 'cursor', label: 'Cursor' })] });
    let n = 0;
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === 'start_race') return started;
      if (cmd === 'create_terminal') {
        const req = (args as { request: { agent: string; task: unknown; initial_prompt: string | null } }).request;
        n += 1;
        return { ...baseConfig, id: `t${n}`, agent: req.agent, task: req.task,
          prompt_delivery: req.initial_prompt ? { mode: 'argv' } : { mode: 'staged' } };
      }
      return null;
    });
    const result = await launchRace({
      repoPath: '/repo', title: 'Fix bug', prompt: 'Fix the login bug', checkCommand: ' npm test ',
      contenders: [{ agent: 'claude', model: 'opus' }, { agent: 'cursor', model: null }],
    });
    expect(invoke).toHaveBeenCalledWith('start_race', { request: expect.objectContaining({
      repo_path: '/repo', title: 'Fix bug', prompt: 'Fix the login bug', check_command: 'npm test',
      contenders: [
        { agent: 'claude', model: 'opus', args: ['--model', 'opus'], label: 'Claude Code · opus' },
        { agent: 'cursor', model: null, args: [], label: 'Cursor' },
      ],
    }) });
    const creates = vi.mocked(invoke).mock.calls.filter(([c]) => c === 'create_terminal').map(([, a]) => (a as { request: Record<string, unknown> }).request);
    expect(creates[0]).toMatchObject({ label: 'Race: Fix bug · Claude Code · opus', initial_prompt: 'Fix the login bug',
      task: expect.objectContaining({ raceId: 'r1', worktreePath: '/wt/race-fix-c0' }) });
    // Cursor cannot take a prompt at spawn: staged, never typed.
    expect(creates[1]).toMatchObject({ label: 'Race: Fix bug · Cursor', initial_prompt: null });
    expect(result.staged).toEqual(['t2']);
    expect(useAppStore.getState().promptDrafts).toEqual({ t2: 'Fix the login bug' });
    expect(vi.mocked(invoke).mock.calls.some(([c]) => c === 'write_to_terminal')).toBe(false);
    expect(useAppStore.getState().gridMode).toBe(true);
    expect(useAppStore.getState().gridTerminalIds).toEqual(['t1', 't2']);
    expect(useAppStore.getState().gridLayout).toBe('1x2');
  });

  it('closes and discards every contender when one terminal fails to start', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'start_race') return race();
      if (cmd === 'create_terminal') {
        if (useTerminalStore.getState().terminals.size > 0) throw 'spawn failed';
        return { ...baseConfig, id: 't1', prompt_delivery: { mode: 'argv' } };
      }
      return [];
    });
    await expect(launchRace({ repoPath: '/repo', title: 'Fix bug', prompt: 'p q', contenders: [{ agent: 'claude', model: null }, { agent: 'codex', model: null }] }))
      .rejects.toBe('spawn failed');
    expect(invoke).toHaveBeenCalledWith('close_terminal', { id: 't1' });
    expect(invoke).toHaveBeenCalledWith('abandon_race', { request: { race_id: 'r1', stats: {}, contenders: [
      { worktree_path: '/wt/race-fix-c0', keep_branch: false, confirm_unmerged: true },
      { worktree_path: '/wt/race-fix-c1', keep_branch: false, confirm_unmerged: true },
    ] } });
  });

  it('refuses fewer than two or more than four contenders before touching git', async () => {
    await expect(launchRace({ repoPath: '/r', title: 't', prompt: 'p', contenders: [{ agent: 'claude', model: null }] })).rejects.toThrow('2 to 4');
    expect(invoke).not.toHaveBeenCalled();
  });
});
