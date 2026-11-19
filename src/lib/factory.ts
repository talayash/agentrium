import { invoke } from '@tauri-apps/api/core';
import type { AgentKind } from './agents';
import type { TaskInfo } from './tasks';

// ---------------------------------------------------------------------------
// Wire types (mirror factory.rs / factory_def.rs / factory_engine.rs).
// The Definition tree is snake_case (it is the file format); the rest is camelCase.
// ---------------------------------------------------------------------------

export type Workspace = 'worktree' | 'in_place';
export interface Check { command: string; timeout_sec?: number | null }
export interface StationStep {
  kind: 'station'; id: string; name: string; prompt: string;
  artifact?: string | null; check?: Check | null; loop_cap?: number | null;
}
export interface GateStep {
  kind: 'gate'; id: string; name: string; question: string; pass_label: string; reject_label: string;
  show: string[]; notes: string[]; on_reject: string;
}
export type Step = StationStep | GateStep;
export interface Definition {
  version: number; name: string; source: string; source_sha256: string;
  input: { label: string; placeholder: string };
  workspace: Workspace; agent: AgentKind; rules: string[]; steps: Step[];
}
export interface LintItem { step_id: string | null; message: string }
export interface Lint { errors: LintItem[]; warnings: LintItem[] }
export interface DefinitionReview { definition: Definition | null; parseError: string | null; lint: Lint }

export type DiskState = 'same' | 'changed' | 'missing';
export interface Factory {
  id: string; name: string; repoPath: string; sourcePath: string; definition: Definition;
  createdAt: string; updatedAt: string; diskState: DiskState;
}
export interface FactoryCandidate { path: string; relPath: string; hasDefinition: boolean }
export interface ImportTicket { importId: string; outputPath: string; prompt: string }

export type RunStatus = 'queued' | 'running' | 'checking' | 'waiting_gate' | 'blocked' | 'done' | 'cancelled';
export interface FactoryRun {
  id: string; factoryId: string; input: string; status: RunStatus; currentStep: string;
  attempts: Record<string, number>; rejectReason: string; checkOutput: string; definition: Definition;
  workspacePath: string; branch: string | null; runDir: string; terminalId: string | null;
  createdAt: string; updatedAt: string;
}
export type StepAction =
  | { kind: 'start_station'; stepId: string; stepName: string; attempt: number; prompt: string; agent: AgentKind; cwd: string; task: TaskInfo | null }
  | { kind: 'await_gate'; stepId: string }
  | { kind: 'queued' } | { kind: 'blocked' } | { kind: 'finished' } | { kind: 'cancelled' } | { kind: 'waiting' };
export interface RunStep { run: FactoryRun; action: StepAction }
export interface RunEventRow { at: string; stepId: string; kind: string; detail: string }
export type RunControl = 'resume' | 'allow_retry' | 'line_freed' | 'cancel';

// ---------------------------------------------------------------------------
// IPC wrappers (argument keys are the Rust parameter names in camelCase)
// ---------------------------------------------------------------------------

export const listFactoryCandidates = (repoPath: string) =>
  invoke<FactoryCandidate[]>('list_factory_candidates', { repoPath });
export const readFactoryDefinitionFile = (repoPath: string, sourcePath: string) =>
  invoke<DefinitionReview | null>('read_factory_definition_file', { repoPath, sourcePath });
export const beginFactoryImport = (repoPath: string, sourcePath: string) =>
  invoke<ImportTicket>('begin_factory_import', { repoPath, sourcePath });
export const pollFactoryImport = (importId: string) =>
  invoke<DefinitionReview | null>('poll_factory_import', { importId });
export const saveFactory = (repoPath: string, sourcePath: string, definition: Definition, writeFile: boolean) =>
  invoke<Factory>('save_factory', { repoPath, sourcePath, definition, writeFile });
export const listFactories = () => invoke<Factory[]>('list_factories');
export const deleteFactory = (factoryId: string) => invoke<void>('delete_factory', { factoryId });
export const startFactoryRun = (factoryId: string, input: string) =>
  invoke<RunStep>('start_factory_run', { factoryId, input });
export const listFactoryRuns = () => invoke<FactoryRun[]>('list_factory_runs');
export const getFactoryRunEvents = (runId: string) => invoke<RunEventRow[]>('get_factory_run_events', { runId });
export const setFactoryRunTerminal = (runId: string, terminalId: string | null) =>
  invoke<void>('set_factory_run_terminal', { runId, terminalId });
export const evaluateFactoryStation = (runId: string, manual: boolean, evalId: string) =>
  invoke<RunStep>('evaluate_factory_station', { runId, manual, evalId });
/** Resolves true when a check with that id was running and has been cancelled. */
export const cancelFactoryCheck = (evalId: string) => invoke<boolean>('cancel_factory_check', { evalId });
export const answerFactoryGate = (runId: string, stepId: string, approve: boolean, reason: string | null) =>
  invoke<RunStep>('answer_factory_gate', { runId, stepId, approve, reason });
export const controlFactoryRun = (runId: string, op: RunControl) =>
  invoke<RunStep>('control_factory_run', { runId, op });
export const nextQueuedFactoryRun = (factoryId: string) =>
  invoke<string | null>('next_queued_factory_run', { factoryId });
export const getFactoryArtifact = (runId: string, name: string) =>
  invoke<string | null>('get_factory_artifact', { runId, name });

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export const FACTORY_TAB_PREFIX = 'factory:';
export const factoryTabPath = (factoryId: string): string => `${FACTORY_TAB_PREFIX}${factoryId}`;

const DEFAULT_LOOP_CAP = 3;
const SESSION_INPUT_MAX = 40;

export const isOpenRun = (run: FactoryRun): boolean => run.status !== 'done' && run.status !== 'cancelled';
export const needsYou = (run: FactoryRun): boolean => run.status === 'waiting_gate' || run.status === 'blocked';
export const holdsLine = (run: FactoryRun): boolean => run.status === 'running' || run.status === 'checking';

export function currentStep(run: FactoryRun): Step | undefined {
  return run.definition.steps.find(s => s.id === run.currentStep);
}

export type TrackCell = 'done' | 'current' | 'needs-you' | 'blocked' | 'todo';

export function trackFor(run: FactoryRun): { step: Step; cell: TrackCell }[] {
  const steps = run.definition.steps;
  const idx = steps.findIndex(s => s.id === run.currentStep);
  return steps.map((step, i): { step: Step; cell: TrackCell } => {
    if (run.status === 'done') return { step, cell: 'done' };
    if (i < idx) return { step, cell: 'done' };
    if (i > idx || idx < 0) return { step, cell: 'todo' };
    if (run.status === 'cancelled') return { step, cell: 'todo' };
    if (run.status === 'waiting_gate') return { step, cell: 'needs-you' };
    if (run.status === 'blocked') return { step, cell: 'blocked' };
    return { step, cell: 'current' };
  });
}

/** Open runs per current step id (every step of the definition has an entry). */
export function stepCounts(def: Definition, runs: FactoryRun[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of def.steps) counts[s.id] = 0;
  for (const r of runs) {
    if (isOpenRun(r) && r.currentStep in counts) counts[r.currentStep] += 1;
  }
  return counts;
}

export function runStatusText(run: FactoryRun): string {
  const step = currentStep(run);
  const name = step?.name ?? run.currentStep;
  const cap = (step?.kind === 'station' ? step.loop_cap : null) ?? DEFAULT_LOOP_CAP;
  const used = run.attempts[run.currentStep] ?? 0;
  switch (run.status) {
    case 'queued': return 'Queued, waiting for the line';
    case 'running': return `${name}, attempt ${used} of ${cap}`;
    case 'checking': return `Checking ${name}`;
    case 'waiting_gate': return `Waiting for you at ${name}`;
    case 'blocked': return `Blocked at ${name}, ${used} of ${cap} attempts used`;
    case 'done': return 'Done';
    case 'cancelled': return 'Cancelled';
  }
}

export function sessionLabel(factoryName: string, run: FactoryRun, stepName: string): string {
  return `${factoryName}: ${run.input.slice(0, SESSION_INPUT_MAX)} · ${stepName}`;
}
