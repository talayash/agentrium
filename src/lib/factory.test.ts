import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import {
  answerFactoryGate, evaluateFactoryStation, factoryTabPath, holdsLine, isOpenRun, needsYou, runStatusText,
  sessionLabel, stepCounts, trackFor, currentStep, FACTORY_TAB_PREFIX,
  type Definition, type FactoryRun, type RunStatus,
} from './factory';

function def(): Definition {
  return {
    version: 1, name: 'Ship', source: 'SKILL.md', source_sha256: 'abc',
    input: { label: 'Ticket', placeholder: 'PROJ-1' }, workspace: 'worktree', agent: 'claude', rules: [],
    steps: [
      { kind: 'station', id: 'S1', name: 'Build', prompt: 'do it', loop_cap: 3 },
      { kind: 'gate', id: 'G1', name: 'Review', question: 'ok?', pass_label: 'Pass', reject_label: 'Reject', show: [], notes: [], on_reject: 'S1' },
      { kind: 'station', id: 'S2', name: 'Ship it', prompt: 'ship' },
    ],
  };
}

function run(over: Partial<FactoryRun> = {}): FactoryRun {
  return {
    id: 'r1', factoryId: 'f1', input: 'PROJ-1', status: 'running', currentStep: 'S1', attempts: { S1: 1 },
    rejectReason: '', checkOutput: '', definition: def(), workspacePath: '/wt', branch: null, runDir: '/rd',
    terminalId: null, createdAt: 't', updatedAt: 't', ...over,
  };
}

const ALL: RunStatus[] = ['queued', 'running', 'checking', 'waiting_gate', 'blocked', 'done', 'cancelled'];

beforeEach(() => vi.mocked(invoke).mockReset());

describe('predicates', () => {
  it('needsYou only for waiting_gate and blocked', () => {
    expect(ALL.filter(s => needsYou(run({ status: s })))).toEqual(['waiting_gate', 'blocked']);
  });
  it('isOpenRun false for done and cancelled', () => {
    expect(ALL.filter(s => !isOpenRun(run({ status: s })))).toEqual(['done', 'cancelled']);
  });
  it('holdsLine only for running and checking', () => {
    expect(ALL.filter(s => holdsLine(run({ status: s })))).toEqual(['running', 'checking']);
  });
});

describe('trackFor', () => {
  it('waiting at the gate', () => {
    expect(trackFor(run({ status: 'waiting_gate', currentStep: 'G1' })).map(t => t.cell)).toEqual(['done', 'needs-you', 'todo']);
  });
  it('blocked at S1', () => {
    expect(trackFor(run({ status: 'blocked' })).map(t => t.cell)).toEqual(['blocked', 'todo', 'todo']);
  });
  it('running marks current', () => {
    expect(trackFor(run({ currentStep: 'S2' })).map(t => t.cell)).toEqual(['done', 'done', 'current']);
  });
  it('done is all done', () => {
    expect(trackFor(run({ status: 'done', currentStep: 'S2' })).map(t => t.cell)).toEqual(['done', 'done', 'done']);
  });
  it('cancelled keeps earlier done, rest todo', () => {
    expect(trackFor(run({ status: 'cancelled', currentStep: 'G1' })).map(t => t.cell)).toEqual(['done', 'todo', 'todo']);
  });
});

describe('helpers', () => {
  it('currentStep and tab path', () => {
    expect(currentStep(run({ currentStep: 'G1' }))?.id).toBe('G1');
    expect(factoryTabPath('f1')).toBe(`${FACTORY_TAB_PREFIX}f1`);
  });
  it('stepCounts counts only open runs', () => {
    const runs = [run(), run({ id: 'r2' }), run({ id: 'r3', status: 'waiting_gate', currentStep: 'G1' }), run({ id: 'r4', status: 'done', currentStep: 'S2' })];
    expect(stepCounts(def(), runs)).toEqual({ S1: 2, G1: 1, S2: 0 });
  });
  it('runStatusText copy', () => {
    expect(runStatusText(run({ status: 'queued' }))).toBe('Queued, waiting for the line');
    expect(runStatusText(run({ status: 'running', attempts: { S1: 2 } }))).toBe('Build, attempt 2 of 3');
    expect(runStatusText(run({ status: 'checking' }))).toBe('Checking Build');
    expect(runStatusText(run({ status: 'waiting_gate', currentStep: 'G1' }))).toBe('Waiting for you at Review');
    expect(runStatusText(run({ status: 'blocked', attempts: { S1: 3 } }))).toBe('Blocked at Build, 3 of 3 attempts used');
    expect(runStatusText(run({ status: 'done' }))).toBe('Done');
    expect(runStatusText(run({ status: 'cancelled' }))).toBe('Cancelled');
  });
  it('sessionLabel cuts input to 40 chars', () => {
    const label = sessionLabel('Ship', run({ input: 'x'.repeat(60) }), 'Build');
    expect(label).toBe(`Ship: ${'x'.repeat(40)} \u00b7 Build`);
  });
});

describe('wrappers', () => {
  it('evaluateFactoryStation', async () => {
    vi.mocked(invoke).mockResolvedValue({});
    await evaluateFactoryStation('r1', true, 'e1');
    expect(invoke).toHaveBeenCalledWith('evaluate_factory_station', { runId: 'r1', manual: true, evalId: 'e1' });
  });
  it('answerFactoryGate', async () => {
    vi.mocked(invoke).mockResolvedValue({});
    await answerFactoryGate('r1', 'G1', false, 'why');
    expect(invoke).toHaveBeenCalledWith('answer_factory_gate', { runId: 'r1', stepId: 'G1', approve: false, reason: 'why' });
  });
});
