import { beforeEach, describe, expectTypeOf, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import {
  beginFactoryImport, cancelFactoryCheck, confirmFactoryRepo, controlFactoryRun, deleteFactory, getFactoryArtifact, getFactoryRunEvents,
  listFactories, listFactoryCandidates, listFactoryRuns, nextQueuedFactoryRun, pollFactoryImport,
  readFactoryDefinitionFile, saveFactory, setFactoryRunTerminal, startFactoryRun,
  type DefinitionReview,
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
    terminalId: null, stationStartedAt: null, createdAt: 't', updatedAt: 't', ...over,
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

describe('wrapper wire pins (names and keys from the Rust #[command] fns)', () => {
  const d = def();
  const rows: [string, () => Promise<unknown>, string, Record<string, unknown> | undefined][] = [
    ['listFactoryCandidates', () => listFactoryCandidates('/r'), 'list_factory_candidates', { repoPath: '/r' }],
    ['readFactoryDefinitionFile', () => readFactoryDefinitionFile('/r', 's.md'), 'read_factory_definition_file', { repoPath: '/r', sourcePath: 's.md' }],
    ['beginFactoryImport', () => beginFactoryImport('/r', 's.md'), 'begin_factory_import', { repoPath: '/r', sourcePath: 's.md' }],
    ['pollFactoryImport', () => pollFactoryImport('i1'), 'poll_factory_import', { importId: 'i1' }],
    ['saveFactory', () => saveFactory('/r', 's.md', d, true), 'save_factory', { repoPath: '/r', sourcePath: 's.md', definition: d, writeFile: true }],
    ['listFactories', () => listFactories(), 'list_factories', undefined],
    ['deleteFactory', () => deleteFactory('f1'), 'delete_factory', { factoryId: 'f1' }],
    ['startFactoryRun', () => startFactoryRun('f1', 'in'), 'start_factory_run', { factoryId: 'f1', input: 'in' }],
    ['listFactoryRuns', () => listFactoryRuns(), 'list_factory_runs', undefined],
    ['getFactoryRunEvents', () => getFactoryRunEvents('r1'), 'get_factory_run_events', { runId: 'r1' }],
    ['setFactoryRunTerminal', () => setFactoryRunTerminal('r1', 't1'), 'set_factory_run_terminal', { runId: 'r1', terminalId: 't1' }],
    ['evaluateFactoryStation', () => evaluateFactoryStation('r1', false, 'e1'), 'evaluate_factory_station', { runId: 'r1', manual: false, evalId: 'e1' }],
    ['cancelFactoryCheck', () => cancelFactoryCheck('e1'), 'cancel_factory_check', { evalId: 'e1' }],
    ['answerFactoryGate', () => answerFactoryGate('r1', 'G1', true, null), 'answer_factory_gate', { runId: 'r1', stepId: 'G1', approve: true, reason: null }],
    ['controlFactoryRun', () => controlFactoryRun('r1', 'allow_retry'), 'control_factory_run', { runId: 'r1', op: 'allow_retry' }],
    ['nextQueuedFactoryRun', () => nextQueuedFactoryRun('f1'), 'next_queued_factory_run', { factoryId: 'f1' }],
    ['getFactoryArtifact', () => getFactoryArtifact('r1', 'a.md'), 'get_factory_artifact', { runId: 'r1', name: 'a.md' }],
    ['confirmFactoryRepo', () => confirmFactoryRepo('/r'), 'confirm_factory_repo', { repoPath: '/r' }],
  ];

  it('covers all 18 wrappers', () => expect(rows).toHaveLength(18));

  it.each(rows)('%s', async (_n, call, command, args) => {
    vi.mocked(invoke).mockResolvedValue(null);
    await call();
    if (args === undefined) expect(invoke).toHaveBeenCalledWith(command);
    else expect(invoke).toHaveBeenCalledWith(command, args);
  });

  it('readFactoryDefinitionFile can resolve null (no file on disk)', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const review = await readFactoryDefinitionFile('/r', 's.md');
    expect(review).toBeNull();
    expectTypeOf(review).toEqualTypeOf<DefinitionReview | null>();
  });
});
