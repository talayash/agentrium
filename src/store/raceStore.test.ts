import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { contenderElapsed, contenderStateFor, trackRaces, useRaceStore } from './raceStore';
import { useTerminalStore, type TerminalConfig, type TerminalInstance } from './terminalStore';
import { useAttentionStore } from './attentionStore';
import type { Race, RaceContender } from '../lib/races';

function contender(idx: number): RaceContender {
  return {
    idx, agent: 'claude', model: null, args: [], label: `C${idx}`, branch: `agentrium/race-x-c${idx}`,
    worktreePath: `C:\\wt\\race-x-c${idx}`, terminalId: null, startedAt: '2026-10-01T00:00:00.000Z',
    finishedAt: null, outcome: 'pending', stats: null,
  };
}

const race: Race = {
  id: 'r1', title: 'Fix bug', prompt: 'p', repoPath: 'C:\\repo', baseBranch: 'main', baseSha: 'abc',
  createdAt: '', status: 'running', winnerTask: null, decidedAt: null, checkCommand: null,
  contenders: [contender(0), contender(1)],
};

function terminal(id: string, c: RaceContender, status: TerminalConfig['status'] = 'Running'): [string, TerminalInstance] {
  const config: TerminalConfig = {
    id, label: id, nickname: null, profile_id: null, working_directory: c.worktreePath, claude_args: [], env_vars: {},
    created_at: '2026-10-01T00:00:00.000Z', status, color_tag: null, agent: 'claude',
    // Forward slashes and different case: the store matches paths loosely.
    task: { title: 'Fix bug', branch: c.branch, baseBranch: 'main', worktreePath: c.worktreePath.replace(/\\/g, '/').toUpperCase(), repoPath: 'C:\\repo', raceId: 'r1' },
  };
  return [id, { config, xterm: null, isWorktree: false }];
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  useRaceStore.setState({ races: { r1: race }, manualDone: {}, seenBusy: {}, seenTerminal: {}, readyNotified: {}, checks: {}, diffs: {} });
  useAttentionStore.setState({ items: [] });
  useTerminalStore.setState({
    terminals: new Map([terminal('t0', race.contenders[0]), terminal('t1', race.contenders[1])]),
    terminalStates: new Map(),
  });
});

describe('race store state derivation', () => {
  it('derives each contender\'s state from its terminal and attention events', () => {
    const { terminals } = useTerminalStore.getState();
    const s = () => useRaceStore.getState();
    const state = (i: number, states: Map<string, 'busy' | 'idle' | 'waiting'>) =>
      contenderStateFor(race.contenders[i], terminals, states, useAttentionStore.getState().items, s().manualDone, s().seenBusy);

    expect(state(0, new Map())).toBe('starting');
    expect(state(0, new Map([['t0', 'busy']]))).toBe('working');
    useAttentionStore.getState().put({ terminalId: 't0', targetId: 't0', kind: 'input', title: 'x', detail: '' });
    expect(state(0, new Map([['t0', 'idle']]))).toBe('needs-input');
    useAttentionStore.getState().put({ terminalId: 't0', targetId: 't0', kind: 'review', title: 'x', detail: '' });
    expect(state(0, new Map([['t0', 'idle']]))).toBe('done');
    s().setManualDone('c:/wt/race-x-c1', true);
    expect(state(1, new Map([['t1', 'busy']]))).toBe('done');
  });

  it('raises one "Race ready to compare" item when every contender settled, and records finish times', () => {
    const now = Date.parse('2026-10-01T00:05:00.000Z');
    useTerminalStore.setState({ terminalStates: new Map([['t0', 'busy'], ['t1', 'busy']]) });
    trackRaces(now);
    expect(useAttentionStore.getState().items).toEqual([]);

    // t0 settles: finish time recorded once, no race item yet.
    useTerminalStore.setState({ terminalStates: new Map([['t0', 'idle'], ['t1', 'busy']]) });
    trackRaces(now);
    expect(useRaceStore.getState().races.r1.contenders[0].finishedAt).toBe('2026-10-01T00:05:00.000Z');
    expect(invoke).toHaveBeenCalledWith('update_race_contender', {
      raceId: 'r1', worktreePath: race.contenders[0].worktreePath, patch: { finished_at: '2026-10-01T00:05:00.000Z' },
    });
    expect(useAttentionStore.getState().items.filter((i) => i.kind === 'race')).toEqual([]);

    // t1 exits: everyone settled.
    const [, t1] = terminal('t1', race.contenders[1], 'Stopped');
    useTerminalStore.setState({ terminals: new Map([terminal('t0', race.contenders[0]), ['t1', t1]]) });
    trackRaces(now + 1000);
    const raceItems = useAttentionStore.getState().items.filter((i) => i.kind === 'race');
    expect(raceItems).toEqual([expect.objectContaining({ kind: 'race', raceId: 'r1', title: 'Fix bug', terminalId: 't0' })]);
    expect(useRaceStore.getState().races.r1.status).toBe('judging');
    expect(invoke).toHaveBeenCalledWith('set_race_status', { raceId: 'r1', status: 'judging' });

    // Never twice.
    trackRaces(now + 2000);
    expect(useAttentionStore.getState().items.filter((i) => i.kind === 'race')).toHaveLength(1);
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'update_race_contender')).toHaveLength(2);
  });

  it('keeps the race item when the anchor terminal changes session state', () => {
    useRaceStore.getState().setManualDone(race.contenders[0].worktreePath, true);
    useRaceStore.getState().setManualDone(race.contenders[1].worktreePath, true);
    trackRaces();
    useAttentionStore.getState().put({ terminalId: 't0', targetId: 't0', kind: 'review', title: 'x', detail: '' });
    useAttentionStore.getState().dismiss('t0');
    expect(useAttentionStore.getState().items.map((i) => i.kind)).toEqual(['race']);
  });

  it('measures elapsed time from start to the latest settle', () => {
    const c = race.contenders[0];
    const start = Date.parse(c.startedAt!);
    expect(contenderElapsed(c, start + 5000)).toBe(5000);
    expect(contenderElapsed({ ...c, finishedAt: new Date(start + 1000).toISOString() }, start + 9000)).toBe(1000);
    expect(contenderElapsed({ ...c, startedAt: null }, start)).toBeNull();
  });

  it('ignores the startup busy/idle blip (banner, trust prompt) and restarts the clock on new work', () => {
    const t0 = Date.parse('2026-10-01T00:00:00.000Z');
    // Busy then idle within the grace period: not done.
    useTerminalStore.setState({ terminalStates: new Map([['t0', 'busy'], ['t1', 'busy']]) });
    trackRaces(t0 + 2000);
    useTerminalStore.setState({ terminalStates: new Map([['t0', 'idle'], ['t1', 'idle']]) });
    trackRaces(t0 + 3000);
    expect(useRaceStore.getState().races.r1.contenders.map((c) => c.finishedAt)).toEqual([null, null]);
    expect(useAttentionStore.getState().items).toEqual([]);

    // Real work after the grace period, then idle: done, clock stops.
    useTerminalStore.setState({ terminalStates: new Map([['t0', 'busy'], ['t1', 'busy']]) });
    trackRaces(t0 + 30_000);
    useTerminalStore.setState({ terminalStates: new Map([['t0', 'idle'], ['t1', 'busy']]) });
    trackRaces(t0 + 60_000);
    expect(useRaceStore.getState().races.r1.contenders[0].finishedAt).toBe(new Date(t0 + 60_000).toISOString());

    // A follow-up prompt: working again, the clock runs until the next settle.
    useTerminalStore.setState({ terminalStates: new Map([['t0', 'busy'], ['t1', 'busy']]) });
    trackRaces(t0 + 70_000);
    expect(useRaceStore.getState().races.r1.contenders[0].finishedAt).toBeNull();
    useTerminalStore.setState({ terminalStates: new Map([['t0', 'idle'], ['t1', 'busy']]) });
    trackRaces(t0 + 90_000);
    expect(useRaceStore.getState().races.r1.contenders[0].finishedAt).toBe(new Date(t0 + 90_000).toISOString());
  });

  it('does not settle a contender whose terminal was never seen (restart before restore)', () => {
    useTerminalStore.setState({ terminals: new Map(), terminalStates: new Map() });
    trackRaces(Date.parse('2026-10-01T01:00:00.000Z'));
    expect(useRaceStore.getState().races.r1.contenders.map((c) => c.finishedAt)).toEqual([null, null]);
    expect(useAttentionStore.getState().items).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('race store checks', () => {
  it('runs one check per contender in parallel and keeps a non-zero exit as a result', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd !== 'run_race_check') return undefined;
      const { worktreePath } = args as { worktreePath: string };
      return { exit_code: worktreePath.endsWith('c0') ? 0 : 1, timed_out: false, cancelled: false, duration_ms: 5, output_tail: 'x', truncated: false };
    });
    await useRaceStore.getState().runChecks(race, 10);
    const calls = vi.mocked(invoke).mock.calls.filter(([c]) => c === 'run_race_check');
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toMatchObject({ raceId: 'r1', timeoutSecs: 600 });
    const checks = useRaceStore.getState().checks;
    expect(checks['c:/wt/race-x-c0'].result?.exit_code).toBe(0);
    expect(checks['c:/wt/race-x-c1'].result?.exit_code).toBe(1);
    expect(checks['c:/wt/race-x-c1'].error).toBeNull();
  });

  it('cancels only running checks', async () => {
    useRaceStore.setState({ checks: {
      'c:/wt/race-x-c0': { runId: 'a', running: true, result: null, error: null },
      'c:/wt/race-x-c1': { runId: 'b', running: false, result: null, error: null },
    } });
    vi.mocked(invoke).mockResolvedValue(true);
    await useRaceStore.getState().cancelChecks(race);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('cancel_race_check', { runId: 'a' });
  });
});
