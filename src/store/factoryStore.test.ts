import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import {
  hasLiveSession, needsYouCount, runsForFactory, subscribeFactoryTracking, trackFactoryRuns, useFactoryStore,
} from './factoryStore';
import { useTerminalStore, type TerminalConfig, type TerminalInstance } from './terminalStore';
import { useAppStore } from './appStore';
import { useToastStore } from './toastStore';
import type { Definition, Factory, FactoryRun, RunStep } from '../lib/factory';
import type { SessionState } from '../lib/terminalState';

const definition: Definition = {
  version: 1, name: 'Ship it', source: 'FACTORY.md', source_sha256: 'x',
  input: { label: 'Ticket', placeholder: 'ABC-1' }, workspace: 'worktree', agent: 'claude', rules: [],
  steps: [{ kind: 'station', id: 'plan', name: 'Plan', prompt: 'Plan it' }],
};

const factory: Factory = {
  id: 'f1', name: 'Ship it', repoPath: 'C:\\repo', sourcePath: 'C:\\repo\\FACTORY.md', definition,
  createdAt: '', updatedAt: '', diskState: 'same',
};

function run(over: Partial<FactoryRun> = {}): FactoryRun {
  return {
    id: 'r1', factoryId: 'f1', input: 'ABC-1', status: 'running', currentStep: 'plan', attempts: { plan: 1 },
    rejectReason: '', checkOutput: '', definition, workspacePath: 'C:\\wt\\abc-1', branch: null,
    runDir: 'C:\\runs\\r1', terminalId: 't1', createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z',
    ...over,
  };
}

function terminal(id: string, status: TerminalConfig['status'] = 'Running'): [string, TerminalInstance] {
  const config: TerminalConfig = {
    id, label: id, nickname: null, profile_id: null, working_directory: 'C:\\wt\\abc-1', claude_args: [], env_vars: {},
    created_at: '2026-11-19T00:00:00.000Z', status, color_tag: null, agent: 'claude',
  };
  return [id, { config, xterm: null, isWorktree: false }];
}

const setState = (state: SessionState) => useTerminalStore.setState({ terminalStates: new Map([['t1', state]]) });
const flush = () => new Promise((r) => setTimeout(r, 0));
const evalCalls = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === 'evaluate_factory_station');
const waitingStep = (): RunStep => ({ run: run(), action: { kind: 'waiting' } });

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === 'evaluate_factory_station' ? waitingStep() : undefined));
  useToastStore.getState().clearAll();
  useAppStore.setState({ factoryEnabled: false });
  useFactoryStore.setState({ factories: { f1: factory }, runs: { r1: run() }, loaded: true, evaluating: {}, seenBusy: {}, exitHandled: {} });
  useTerminalStore.setState({ terminals: new Map([terminal('t1')]), terminalStates: new Map() });
});

describe('factory store', () => {
  it('load fills factories and runs', async () => {
    useFactoryStore.setState({ factories: {}, runs: {}, loaded: false });
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'list_factories') return [factory];
      if (cmd === 'list_factory_runs') return [run(), run({ id: 'r2', status: 'done' })];
      return undefined;
    });
    await useFactoryStore.getState().load();
    const s = useFactoryStore.getState();
    expect(s.loaded).toBe(true);
    expect(Object.keys(s.factories)).toEqual(['f1']);
    expect(Object.keys(s.runs).sort()).toEqual(['r1', 'r2']);
    expect(vi.mocked(invoke).mock.calls.map(([c]) => c).sort()).toEqual(['list_factories', 'list_factory_runs']);
  });

  it('needsYouCount counts gates and blocked runs', () => {
    expect(needsYouCount({
      a: run({ id: 'a', status: 'waiting_gate' }),
      b: run({ id: 'b', status: 'blocked' }),
      c: run({ id: 'c', status: 'running' }),
      d: run({ id: 'd', status: 'done' }),
    })).toBe(2);
  });

  it('runsForFactory lists open runs first, then newest first', () => {
    const runs = {
      a: run({ id: 'a', status: 'done', createdAt: '2026-11-19T03:00:00.000Z' }),
      b: run({ id: 'b', status: 'running', createdAt: '2026-11-19T01:00:00.000Z' }),
      c: run({ id: 'c', status: 'queued', createdAt: '2026-11-19T02:00:00.000Z' }),
      d: run({ id: 'd', factoryId: 'f2', status: 'running' }),
    };
    expect(runsForFactory(runs, 'f1').map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('turn tracking', () => {
  it('a busy then idle station is evaluated once', async () => {
    setState('busy');
    trackFactoryRuns();
    expect(evalCalls()).toHaveLength(0);
    setState('idle');
    trackFactoryRuns();
    trackFactoryRuns();
    await flush();
    expect(evalCalls()).toEqual([['evaluate_factory_station', { runId: 'r1', manual: false, evalId: expect.any(String) }]]);
  });

  it('an idle station that was never busy is not evaluated', async () => {
    setState('idle');
    trackFactoryRuns();
    await flush();
    expect(evalCalls()).toHaveLength(0);
  });

  it('a station waiting for the user\'s answer is not evaluated', async () => {
    setState('busy');
    trackFactoryRuns();
    setState('waiting');
    trackFactoryRuns();
    await flush();
    expect(evalCalls()).toHaveLength(0);
  });

  it('a stopped session is evaluated', async () => {
    useTerminalStore.setState({ terminals: new Map([terminal('t1', 'Stopped')]) });
    trackFactoryRuns();
    await flush();
    expect(evalCalls()).toHaveLength(1);

    // Only once: an exited session that stays exited is not re-checked on every pass.
    trackFactoryRuns();
    await flush();
    expect(evalCalls()).toHaveLength(1);
  });

  it('a run whose terminal is gone is not evaluated', async () => {
    const gone = run({ terminalId: 't9' });
    useFactoryStore.setState({ runs: { r1: gone } });
    useTerminalStore.setState({ terminalStates: new Map([['t9', 'busy']]) });
    trackFactoryRuns();
    useTerminalStore.setState({ terminalStates: new Map([['t9', 'idle']]) });
    trackFactoryRuns();
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(hasLiveSession(gone)).toBe(false);
    expect(hasLiveSession(run())).toBe(true);
  });

  it('a waiting outcome re-arms on the next busy to idle edge', async () => {
    setState('busy');
    trackFactoryRuns();
    setState('idle');
    trackFactoryRuns();
    await flush();
    expect(evalCalls()).toHaveLength(1);
    expect(useFactoryStore.getState().seenBusy.t1).toBeUndefined();

    // Still idle: no new edge, no new evaluation.
    trackFactoryRuns();
    await flush();
    expect(evalCalls()).toHaveLength(1);

    setState('busy');
    trackFactoryRuns();
    setState('idle');
    trackFactoryRuns();
    await flush();
    expect(evalCalls()).toHaveLength(2);
  });
});

describe('actions', () => {
  it('answerGate applies the returned step and shows an error toast on failure', async () => {
    const answered = run({ status: 'done', terminalId: null });
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      (cmd === 'answer_factory_gate' ? { run: answered, action: { kind: 'finished' } } : undefined));
    await useFactoryStore.getState().answerGate('r1', 'gate', true, '');
    expect(invoke).toHaveBeenCalledWith('answer_factory_gate', { runId: 'r1', stepId: 'gate', approve: true, reason: null });
    expect(useFactoryStore.getState().runs.r1.status).toBe('done');

    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'answer_factory_gate') throw new Error('Run is not at that gate');
      return undefined;
    });
    await expect(useFactoryStore.getState().answerGate('r1', 'gate', false, 'too vague')).rejects.toThrow();
    expect(invoke).toHaveBeenCalledWith('answer_factory_gate', { runId: 'r1', stepId: 'gate', approve: false, reason: 'too vague' });
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'error', title: 'Could not answer the gate' }),
    ]);
  });

  it('startRun applies the first step and lets a refusal reach the caller', async () => {
    const queued = run({ id: 'r3', status: 'queued', terminalId: null });
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      (cmd === 'start_factory_run' ? { run: queued, action: { kind: 'queued' } } : undefined));
    const started = await useFactoryStore.getState().startRun('f1', 'ABC-3');
    expect(started.id).toBe('r3');
    expect(useFactoryStore.getState().runs.r3.status).toBe('queued');
    // A queued run never kicks the queue (it would only re-queue itself).
    expect(invoke).not.toHaveBeenCalledWith('next_queued_factory_run', expect.anything());

    vi.mocked(invoke).mockRejectedValue(new Error('Use a ticket id'));
    await expect(useFactoryStore.getState().startRun('f1', 'free text')).rejects.toThrow('Use a ticket id');
  });

  it('cancel stops an in-flight check first', async () => {
    useFactoryStore.setState({ evaluating: { r1: 'e1' } });
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'cancel_factory_check') throw new Error('gone');
      if (cmd === 'control_factory_run') return { run: run({ status: 'cancelled', terminalId: null }), action: { kind: 'cancelled' } };
      return undefined;
    });
    await useFactoryStore.getState().control('r1', 'cancel');
    const cmds = vi.mocked(invoke).mock.calls.map(([c]) => c);
    expect(cmds.indexOf('cancel_factory_check')).toBeLessThan(cmds.indexOf('control_factory_run'));
    expect(invoke).toHaveBeenCalledWith('cancel_factory_check', { evalId: 'e1' });
    expect(invoke).toHaveBeenCalledWith('control_factory_run', { runId: 'r1', op: 'cancel' });
    expect(useFactoryStore.getState().runs.r1.status).toBe('cancelled');
  });

  it('resume stops an in-flight check first', async () => {
    useFactoryStore.setState({ evaluating: { r1: 'e1' } });
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      (cmd === 'control_factory_run' ? { run: run(), action: { kind: 'waiting' } } : cmd === 'cancel_factory_check' ? true : undefined));
    await useFactoryStore.getState().control('r1', 'resume');
    const cmds = vi.mocked(invoke).mock.calls.map(([c]) => c);
    expect(cmds).toEqual(['cancel_factory_check', 'control_factory_run']);
    expect(invoke).toHaveBeenCalledWith('cancel_factory_check', { evalId: 'e1' });
  });

  it('allow_retry does not cancel anything, and no check is cancelled when none runs', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      (cmd === 'control_factory_run' ? { run: run(), action: { kind: 'waiting' } } : undefined));
    useFactoryStore.setState({ evaluating: { r1: 'e1' } });
    await useFactoryStore.getState().control('r1', 'allow_retry');
    useFactoryStore.setState({ evaluating: {} });
    await useFactoryStore.getState().control('r1', 'resume');
    expect(invoke).not.toHaveBeenCalledWith('cancel_factory_check', expect.anything());
  });

  it('a manual evaluation that fails shows an error toast', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('no such run'));
    await useFactoryStore.getState().evaluate('r1', true);
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ type: 'error', title: 'Check did not run' })]);
    expect(useFactoryStore.getState().evaluating).toEqual({});
  });
});

describe('subscription', () => {
  it('subscribeFactoryTracking does nothing when the flag is off', async () => {
    const unsub = subscribeFactoryTracking();
    setState('busy');
    setState('idle');
    await flush();
    unsub();
    expect(invoke).not.toHaveBeenCalled();
  });
});
