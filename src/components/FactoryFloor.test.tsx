import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../lib/confirmDialog', () => ({ confirmAction: vi.fn() }));
vi.mock('../lib/raceActions', () => ({ focusTerminal: vi.fn() }));
vi.mock('../lib/errorReporter', () => ({ reportInvokeFailure: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { reportInvokeFailure } from '../lib/errorReporter';
import { confirmAction } from '../lib/confirmDialog';
import { focusTerminal } from '../lib/raceActions';
import { FactoryFloor } from './FactoryFloor';
import { useFactoryStore } from '../store/factoryStore';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import type { Definition, Factory, FactoryRun, RunStatus } from '../lib/factory';

const def: Definition = {
  version: 1, name: 'Ticket line', source: 'x', source_sha256: 'h',
  input: { label: 'Ticket', placeholder: 'WGCP-1' }, workspace: 'worktree', agent: 'claude', rules: [],
  steps: [
    { kind: 'station', id: 's1', name: 'Plan', prompt: 'p', artifact: 'plan.md', check: { command: 'true' } },
    { kind: 'gate', id: 'g1', name: 'Plan approval', question: 'Approve the plan?', pass_label: 'Approve', reject_label: 'Reject', show: [], notes: [], on_reject: 's1' },
    { kind: 'station', id: 's2', name: 'Build', prompt: 'p' },
  ],
};
const factory: Factory = {
  id: 'f1', name: 'Ticket line', repoPath: '/repo', sourcePath: '/repo/.agentrium/line.json', definition: def,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', diskState: 'same',
};
const mkRun = (id: string, status: RunStatus, currentStep: string, extra: Partial<FactoryRun> = {}): FactoryRun => ({
  id, factoryId: 'f1', input: `WGCP-${id}`, status, currentStep, attempts: { [currentStep]: 1 }, rejectReason: '',
  checkOutput: '', definition: def, workspacePath: '/wt', branch: null, runDir: '/rd', terminalId: null, stationStartedAt: null,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: new Date().toISOString(), ...extra,
});
const setRuns = (...runs: FactoryRun[]) =>
  useFactoryStore.setState({ factories: { f1: factory }, runs: Object.fromEntries(runs.map((r) => [r.id, r])), evaluating: {} });
const withLiveSession = (id: string) =>
  useTerminalStore.setState({ terminals: new Map([[id, { config: { id } } as never]]) });

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockRejectedValue(new Error('unexpected invoke'));
  vi.mocked(confirmAction).mockReset();
  vi.mocked(focusTerminal).mockReset();
  vi.mocked(reportInvokeFailure).mockReset();
  useTerminalStore.setState({ terminals: new Map() });
  useAppStore.setState({ factoryGateRunId: null, newFactoryRunFactoryId: null, addFactoryModalOpen: false });
});
afterEach(cleanup);

it('shows one row per run with its status text', () => {
  setRuns(mkRun('r1', 'waiting_gate', 'g1'), mkRun('r2', 'running', 's2'));
  render(<FactoryFloor factoryId="f1" />);
  expect(within(screen.getByTestId('run-r1')).getByText('Waiting for you at Plan approval')).toBeTruthy();
  expect(within(screen.getByTestId('run-r2')).getByText('Build, attempt 1 of 3')).toBeTruthy();
  expect(within(screen.getByTestId('run-r1')).getByText('WGCP-r1')).toBeTruthy();
});

it('the line shows a count on the step that has runs', () => {
  setRuns(mkRun('r1', 'running', 's2'), mkRun('r2', 'running', 's2'));
  render(<FactoryFloor factoryId="f1" />);
  expect(within(screen.getByTestId('line-s2')).getByText('2')).toBeTruthy();
  expect(within(screen.getByTestId('line-s1')).queryByText('0')).toBeNull();
});

it('Review on a gate run opens the gate dialog', () => {
  setRuns(mkRun('r1', 'waiting_gate', 'g1'));
  render(<FactoryFloor factoryId="f1" />);
  fireEvent.click(within(screen.getByTestId('run-r1')).getByRole('button', { name: 'Review' }));
  expect(useAppStore.getState().factoryGateRunId).toBe('r1');
});

it('a running run with no live session offers Continue, and it resumes the run', async () => {
  setRuns(mkRun('r1', 'running', 's2'));
  render(<FactoryFloor factoryId="f1" />);
  expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('control_factory_run', { runId: 'r1', op: 'resume' }));
});

it('a running run with a live session offers Open, not Continue', () => {
  setRuns(mkRun('r1', 'running', 's2', { terminalId: 't1' }));
  withLiveSession('t1');
  render(<FactoryFloor factoryId="f1" />);
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(focusTerminal).toHaveBeenCalledWith('t1');
});

it('Allow 1 more round is offered only for a blocked run', async () => {
  setRuns(mkRun('r1', 'running', 's2'));
  const { unmount } = render(<FactoryFloor factoryId="f1" />);
  expect(screen.queryByRole('button', { name: 'Allow 1 more round' })).toBeNull();
  unmount();
  setRuns(mkRun('r1', 'blocked', 's2'));
  render(<FactoryFloor factoryId="f1" />);
  fireEvent.click(within(screen.getByTestId('run-r1')).getByRole('button', { name: 'Allow 1 more round' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('control_factory_run', { runId: 'r1', op: 'allow_retry' }));
});

it('Mark done replaces Check now for a station with no check and no artifact', () => {
  setRuns(mkRun('r1', 'running', 's2', { terminalId: 't1' }));
  withLiveSession('t1');
  const { unmount } = render(<FactoryFloor factoryId="f1" />);
  expect(screen.getByRole('button', { name: 'Mark done' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  unmount();
  setRuns(mkRun('r1', 'running', 's1', { terminalId: 't1' }));
  render(<FactoryFloor factoryId="f1" />);
  expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull();
});

it('Check now is offered for a running run with no live session', async () => {
  setRuns(mkRun('r1', 'running', 's1'));
  vi.mocked(invoke).mockImplementation(async (cmd) =>
    (cmd === 'evaluate_factory_station' ? { run: mkRun('r1', 'running', 's1'), action: { kind: 'waiting' } } : undefined));
  render(<FactoryFloor factoryId="f1" />);
  expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith(
    'evaluate_factory_station', { runId: 'r1', manual: true, evalId: expect.any(String) }));
});

it('Mark done is offered for a running run with no live session when the station has no check and no artifact', () => {
  setRuns(mkRun('r1', 'running', 's2'));
  render(<FactoryFloor factoryId="f1" />);
  expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Mark done' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
});

it('Check now is disabled while an evaluation is running', () => {
  setRuns(mkRun('r1', 'running', 's1', { terminalId: 't1' }));
  withLiveSession('t1');
  useFactoryStore.setState({ evaluating: { r1: 'e1' } });
  render(<FactoryFloor factoryId="f1" />);
  expect((screen.getByRole('button', { name: 'Check now' }) as HTMLButtonElement).disabled).toBe(true);
});

it('a checking run that is evaluating shows a disabled Checking button', () => {
  setRuns(mkRun('r1', 'checking', 's1'));
  useFactoryStore.setState({ evaluating: { r1: 'e1' } });
  render(<FactoryFloor factoryId="f1" />);
  expect((screen.getByRole('button', { name: 'Checking...' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
});

it('Cancel run asks first', async () => {
  setRuns(mkRun('r1', 'running', 's2'));
  render(<FactoryFloor factoryId="f1" />);
  vi.mocked(confirmAction).mockResolvedValueOnce(false);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel run' })); });
  expect(confirmAction).toHaveBeenCalledWith(
    'Cancel this run? Its session closes. Files it changed stay where they are.', { okLabel: 'Cancel run' });
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(confirmAction).mockResolvedValueOnce(true);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel run' })); });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('control_factory_run', { runId: 'r1', op: 'cancel' }));
});

it('needs-you column lists gates and blocked runs and is empty otherwise', () => {
  setRuns(
    mkRun('r1', 'waiting_gate', 'g1'),
    mkRun('r2', 'blocked', 's2', { checkOutput: 'l1\nl2\nl3\nl4' }),
    mkRun('r3', 'running', 's2'),
  );
  const { unmount } = render(<FactoryFloor factoryId="f1" />);
  const col = screen.getByTestId('needs-you');
  expect(within(col).getByText('Needs you (2)')).toBeTruthy();
  expect(within(col).getByText('Approve the plan?')).toBeTruthy();
  expect(within(col).getByText('Blocked at Build')).toBeTruthy();
  expect(within(col).getByText(/l2\s+l3\s+l4/)).toBeTruthy();
  expect(within(col).queryByText(/l1/)).toBeNull();
  unmount();
  setRuns(mkRun('r3', 'running', 's2'));
  render(<FactoryFloor factoryId="f1" />);
  expect(screen.getByText('Nothing is waiting for you')).toBeTruthy();
});

it('shows an empty state with a New run action when there are no runs', () => {
  setRuns();
  render(<FactoryFloor factoryId="f1" />);
  expect(screen.getByText('No runs yet')).toBeTruthy();
  expect(screen.getByText('Start a run to send one ticket down the line.')).toBeTruthy();
});

it('a changed definition shows the review strip', () => {
  useFactoryStore.setState({ factories: { f1: { ...factory, diskState: 'changed' } }, runs: {} });
  render(<FactoryFloor factoryId="f1" />);
  expect(screen.getByText('Definition changed on disk. Review it before new runs use it.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(useAppStore.getState().addFactoryModalOpen).toBe(true);
});

it('an unknown factory shows the removed state', () => {
  useFactoryStore.setState({ factories: {}, runs: {} });
  render(<FactoryFloor factoryId="nope" />);
  expect(screen.getByText('This factory was removed')).toBeTruthy();
});

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

it('the history toggle expands and lists the run events, and reloads when the run changes', async () => {
  const events = [
    { at: '2026-11-19T10:05:00Z', stepId: 's1', kind: 'started', detail: '' },
    { at: '2026-11-19T10:40:00Z', stepId: 'g1', kind: 'retry_allowed', detail: 'cover AC2 and the edge cases' },
  ];
  vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === 'get_factory_run_events' ? events : undefined));
  setRuns(mkRun('r1', 'done', 's2'));
  render(<FactoryFloor factoryId="f1" />);
  const toggle = screen.getByRole('button', { name: 'Show history' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  expect(invoke).toHaveBeenCalledWith('get_factory_run_events', { runId: 'r1' });
  const list = await screen.findByRole('list', { name: 'Run history' });
  const items = within(list).getAllByRole('listitem');
  expect(items).toHaveLength(2);
  expect(within(items[0]).getByText(hhmm(events[0].at))).toBeTruthy();
  expect(within(items[0]).getByText('s1')).toBeTruthy();
  expect(within(items[0]).getByText('started')).toBeTruthy();
  expect(within(items[1]).getByText('retry allowed')).toBeTruthy();
  expect(within(items[1]).getByText('cover AC2 and the edge cases').getAttribute('title')).toBe('cover AC2 and the edge cases');
  const hide = screen.getByRole('button', { name: 'Hide history' });
  expect(hide.getAttribute('aria-expanded')).toBe('true');

  const calls = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === 'get_factory_run_events').length;
  expect(calls()).toBe(1);
  act(() => { setRuns(mkRun('r1', 'done', 's2', { updatedAt: '2026-11-19T11:00:00Z' })); });
  await waitFor(() => expect(calls()).toBe(2));

  fireEvent.click(hide);
  expect(screen.queryByRole('list', { name: 'Run history' })).toBeNull();
});

it('the history shows an inline error when it cannot load', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('db gone'));
  setRuns(mkRun('r1', 'done', 's2'));
  render(<FactoryFloor factoryId="f1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Show history' }));
  expect(await screen.findByText('Could not load the history.')).toBeTruthy();
  expect(reportInvokeFailure).toHaveBeenCalledWith('get_factory_run_events', expect.anything());
});

it('a history load that fails after the list closed is not reported', async () => {
  let reject: (e: unknown) => void = () => {};
  vi.mocked(invoke).mockImplementation(() => new Promise((_, r) => { reject = r; }));
  setRuns(mkRun('r1', 'done', 's2'));
  render(<FactoryFloor factoryId="f1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Show history' }));
  fireEvent.click(screen.getByRole('button', { name: 'Hide history' }));
  await act(async () => { reject(new Error('late')); });
  expect(reportInvokeFailure).not.toHaveBeenCalled();
});
