import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { kickQueue, performStep } from './factoryActions';
import type { Definition, FactoryRun, RunStep, StepAction } from './factory';
import { useFactoryStore } from '../store/factoryStore';
import { useTerminalStore, type PromptDelivery, type TerminalConfig, type TerminalInstance } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';

const definition: Definition = {
  version: 1, name: 'Ship it', source: 'FACTORY.md', source_sha256: 'x',
  input: { label: 'Ticket', placeholder: 'ABC-1' }, workspace: 'worktree', agent: 'claude', rules: [],
  steps: [{ kind: 'station', id: 'plan', name: 'Plan', prompt: 'Plan it' }],
};

function run(over: Partial<FactoryRun> = {}): FactoryRun {
  return {
    id: 'r1', factoryId: 'f1', input: 'ABC-1', status: 'running', currentStep: 'plan', attempts: { plan: 1 },
    rejectReason: '', checkOutput: '', definition, workspacePath: 'C:\\wt\\abc-1', branch: 'agentrium/abc-1',
    runDir: 'C:\\runs\\r1', terminalId: null, stationStartedAt: null, createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z',
    ...over,
  };
}

const startAction: StepAction = {
  kind: 'start_station', stepId: 'plan', stepName: 'Plan', attempt: 1, prompt: 'Plan ABC-1',
  agent: 'claude', cwd: 'C:\\wt\\abc-1', task: null,
};

function terminal(id: string, delivery: PromptDelivery | null = { mode: 'argv' }): [string, TerminalInstance] {
  const config: TerminalConfig = {
    id, label: id, nickname: null, profile_id: null, working_directory: 'C:\\wt\\abc-1', claude_args: [], env_vars: {},
    created_at: '2026-11-19T00:00:00.000Z', status: 'Running', color_tag: null, agent: 'claude', prompt_delivery: delivery,
  };
  return [id, { config, xterm: null, isWorktree: false }];
}

let createdDelivery: PromptDelivery | null = { mode: 'argv' };
const createTerminal = vi.fn();
const closeTerminal = vi.fn();
const setActiveTerminal = vi.fn();
const setPromptDraft = vi.fn();

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  createdDelivery = { mode: 'argv' };
  createTerminal.mockReset();
  createTerminal.mockImplementation(async () => {
    useTerminalStore.setState((s) => ({
      terminals: new Map([...s.terminals, terminal('new', createdDelivery)]),
      activeTerminalId: 'new',
    }));
    return 'new';
  });
  closeTerminal.mockReset();
  closeTerminal.mockImplementation(async (id: string) => {
    useTerminalStore.setState((s) => {
      const terminals = new Map(s.terminals);
      terminals.delete(id);
      return { terminals };
    });
  });
  setActiveTerminal.mockReset();
  setPromptDraft.mockReset();
  useTerminalStore.setState({
    terminals: new Map([terminal('old'), terminal('other')]),
    terminalStates: new Map(),
    activeTerminalId: 'other',
    createTerminal, closeTerminal, setActiveTerminal,
  });
  useAppStore.setState({ activeFilePath: null, setPromptDraft });
  useFactoryStore.setState({ factories: {}, runs: {}, loaded: true, evaluating: {}, seenBusy: {}, exitHandled: {}, sessionOpenedAt: {} });
});

const step = (action: StepAction, over: Partial<FactoryRun> = {}): RunStep => {
  const r = run(over);
  useFactoryStore.setState({ runs: { [r.id]: r } });
  return { run: r, action };
};

describe('performStep', () => {
  it('start_station opens a session with the prompt and records its id', async () => {
    await performStep(step(startAction), 'Ship it');
    expect(createTerminal).toHaveBeenCalledTimes(1);
    const args = createTerminal.mock.calls[0];
    expect(args[1]).toBe('C:\\wt\\abc-1');
    expect(args[args.length - 1]).toEqual({ initialPrompt: 'Plan ABC-1' });
    expect(args[10]).toBe('claude');
    expect(invoke).toHaveBeenCalledWith('set_factory_run_terminal', { runId: 'r1', terminalId: 'new' });
    expect(useFactoryStore.getState().runs.r1.terminalId).toBe('new');
    expect(useFactoryStore.getState().sessionOpenedAt.new).toEqual(expect.any(Number));
    expect(setPromptDraft).not.toHaveBeenCalled();
  });

  it('start_station closes the previous station session first', async () => {
    await performStep(step(startAction, { terminalId: 'old' }), 'Ship it');
    expect(closeTerminal).toHaveBeenCalledWith('old');
    expect(closeTerminal.mock.invocationCallOrder[0]).toBeLessThan(createTerminal.mock.invocationCallOrder[0]);
  });

  it('start_station restores the user\'s active terminal when they were elsewhere', async () => {
    useAppStore.setState({ activeFilePath: 'factory:f1' });
    await performStep(step(startAction, { terminalId: 'old' }), 'Ship it');
    expect(setActiveTerminal).toHaveBeenCalledWith('other');
    expect(setActiveTerminal.mock.invocationCallOrder[0]).toBeGreaterThan(createTerminal.mock.invocationCallOrder[0]);
    expect(useAppStore.getState().activeFilePath).toBe('factory:f1');

    setActiveTerminal.mockClear();
    useAppStore.setState({ activeFilePath: null });
    useTerminalStore.setState({ terminals: new Map([terminal('old'), terminal('other')]), activeTerminalId: 'old' });
    await performStep(step(startAction, { terminalId: 'old' }), 'Ship it');
    expect(setActiveTerminal).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().activeTerminalId).toBe('new');
  });

  it('a staged prompt is put in the draft, never written', async () => {
    createdDelivery = { mode: 'staged' };
    await performStep(step(startAction), 'Ship it');
    expect(setPromptDraft).toHaveBeenCalledWith('new', 'Plan ABC-1');
    expect(vi.mocked(invoke).mock.calls.map(([c]) => c)).not.toContain('write_to_terminal');
  });

  it('a failed launch leaves the run as it is', async () => {
    createTerminal.mockRejectedValueOnce(new Error('spawn failed'));
    await performStep(step(startAction), 'Ship it');
    expect(invoke).not.toHaveBeenCalledWith('set_factory_run_terminal', expect.anything());
    expect(useFactoryStore.getState().runs.r1.terminalId).toBeNull();
  });

  it('await_gate closes the session', async () => {
    await performStep(step({ kind: 'await_gate', stepId: 'gate' }, { status: 'waiting_gate', terminalId: 'old' }), 'Ship it');
    expect(closeTerminal).toHaveBeenCalledWith('old');
  });

  it('blocked leaves the session open', async () => {
    await performStep(step({ kind: 'blocked' }, { status: 'blocked', terminalId: 'old' }), 'Ship it');
    expect(closeTerminal).not.toHaveBeenCalled();
  });

  it('finished and cancelled close the session', async () => {
    await performStep(step({ kind: 'finished' }, { status: 'done', terminalId: 'old' }), 'Ship it');
    expect(closeTerminal).toHaveBeenCalledWith('old');
    useTerminalStore.setState({ terminals: new Map([terminal('old')]) });
    closeTerminal.mockClear();
    await performStep(step({ kind: 'cancelled' }, { status: 'cancelled', terminalId: 'old' }), 'Ship it');
    expect(closeTerminal).toHaveBeenCalledWith('old');
  });
});

describe('kickQueue', () => {
  it('kickQueue starts the next queued run', async () => {
    const queued = run({ id: 'r2', status: 'queued' });
    let queuedLeft = 1;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'next_queued_factory_run') return queuedLeft-- > 0 ? 'r2' : null;
      if (cmd === 'control_factory_run') return { run: { ...queued, status: 'blocked' }, action: { kind: 'blocked' } };
      return undefined;
    });
    await kickQueue('f1');
    expect(invoke).toHaveBeenCalledWith('next_queued_factory_run', { factoryId: 'f1' });
    expect(invoke).toHaveBeenCalledWith('control_factory_run', { runId: 'r2', op: 'line_freed' });
  });

  it('does nothing when no run is queued, and swallows errors', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await kickQueue('f1');
    expect(invoke).toHaveBeenCalledTimes(1);
    vi.mocked(invoke).mockRejectedValueOnce(new Error('db'));
    await expect(kickQueue('f1')).resolves.toBeUndefined();
  });
});
