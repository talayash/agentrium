import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../lib/errorReporter', () => ({ reportInvokeFailure: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { reportInvokeFailure } from '../lib/errorReporter';
import { FactoryGateDialog } from './FactoryGateDialog';
import { useFactoryStore } from '../store/factoryStore';
import { useAppStore } from '../store/appStore';
import type { Definition, Factory, FactoryRun, RunStatus } from '../lib/factory';

const def: Definition = {
  version: 1, name: 'Ticket line', source: 'x', source_sha256: 'h',
  input: { label: 'Ticket', placeholder: 'WGCP-1' }, workspace: 'worktree', agent: 'claude', rules: [],
  steps: [
    { kind: 'station', id: 's1', name: 'Plan', prompt: 'p', artifact: 'plan.md' },
    {
      kind: 'gate', id: 'G1', name: 'Plan approval', question: 'Approve the plan?', pass_label: 'Approve',
      reject_label: 'Send back', show: ['plan.md', 'risks.md'], notes: ['Starts the build station'], on_reject: 's1',
    },
  ],
};
const factory: Factory = {
  id: 'f1', name: 'Ticket line', repoPath: '/repo', sourcePath: '/repo/.agentrium/line.json', definition: def,
  createdAt: '', updatedAt: '', diskState: 'same',
};
const mkRun = (status: RunStatus, currentStep = 'G1'): FactoryRun => ({
  id: 'r1', factoryId: 'f1', input: 'WGCP-7', status, currentStep, attempts: {}, rejectReason: '',
  checkOutput: '', definition: def, workspacePath: '/wt', branch: null, runDir: '/rd', terminalId: null, stationStartedAt: null,
  createdAt: '', updatedAt: '',
});
const files: Record<string, string | null> = { 'plan.md': '# Plan', 'risks.md': null };
const artifactFor = (args: unknown) => files[(args as { name: string }).name];
const answered = () => ({ run: mkRun('running', 's1'), action: { kind: 'waiting' } });

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(reportInvokeFailure).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    if (cmd === 'get_factory_artifact') return artifactFor(args);
    if (cmd === 'answer_factory_gate') throw new Error('unexpected answer');
    return null;
  });
  useFactoryStore.setState({ factories: { f1: factory }, runs: { r1: mkRun('waiting_gate') }, evaluating: {} });
  useAppStore.setState({ factoryGateRunId: 'r1' });
});
afterEach(cleanup);

const answers = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] === 'answer_factory_gate');

it('shows the question, the labels and the fixed note', async () => {
  render(<FactoryGateDialog />);
  expect(screen.getByText('Plan approval')).toBeTruthy();
  expect(screen.getByText('Ticket line · WGCP-7')).toBeTruthy();
  expect(screen.getByText('Approve the plan?')).toBeTruthy();
  expect(screen.getByText('Passing also does')).toBeTruthy();
  expect(screen.getByText('Starts the build station')).toBeTruthy();
  expect(screen.getByLabelText('Reason (required to send back)')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send back' })).toBeTruthy();
  expect(screen.getByText('Agentrium records this answer. The agent cannot answer a gate.')).toBeTruthy();
  await screen.findByText('# Plan');
});

it('loads and shows each artifact', async () => {
  render(<FactoryGateDialog />);
  expect(await screen.findByText('# Plan')).toBeTruthy();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith('get_factory_artifact', { runId: 'r1', name: 'plan.md' });
});

it('a missing artifact says so', async () => {
  render(<FactoryGateDialog />);
  expect(await screen.findByText('risks.md is not in the run folder.')).toBeTruthy();
});

it('a failed artifact load shows the error and reports it', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === 'get_factory_artifact') throw new Error('disk gone');
    return null;
  });
  render(<FactoryGateDialog />);
  expect((await screen.findAllByText(/disk gone/)).length).toBe(2);
  expect(reportInvokeFailure).toHaveBeenCalledWith('get_factory_artifact', expect.anything());
});

it('approve sends the answer and closes', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    if (cmd === 'get_factory_artifact') return artifactFor(args);
    if (cmd === 'answer_factory_gate') return answered();
    return null;
  });
  render(<FactoryGateDialog />);
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(useAppStore.getState().factoryGateRunId).toBeNull());
  expect(vi.mocked(invoke)).toHaveBeenCalledWith('answer_factory_gate', { runId: 'r1', stepId: 'G1', approve: true, reason: null });
});

it('reject without a reason is refused locally', () => {
  render(<FactoryGateDialog />);
  fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
  expect(screen.getByText('Give a reason so the agent knows what to change.')).toBeTruthy();
  expect(screen.getByLabelText('Reason (required to send back)').getAttribute('aria-invalid')).toBe('true');
  expect(answers().length).toBe(0);
  expect(useAppStore.getState().factoryGateRunId).toBe('r1');
});

it('reject with a reason sends it', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    if (cmd === 'get_factory_artifact') return artifactFor(args);
    if (cmd === 'answer_factory_gate') return answered();
    return null;
  });
  render(<FactoryGateDialog />);
  fireEvent.change(screen.getByLabelText('Reason (required to send back)'), { target: { value: 'Missing tests' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
  await waitFor(() => expect(useAppStore.getState().factoryGateRunId).toBeNull());
  expect(vi.mocked(invoke)).toHaveBeenCalledWith('answer_factory_gate', { runId: 'r1', stepId: 'G1', approve: false, reason: 'Missing tests' });
});

it('stays open when the answer fails', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    if (cmd === 'get_factory_artifact') return artifactFor(args);
    if (cmd === 'answer_factory_gate') throw new Error('boom');
    return null;
  });
  render(<FactoryGateDialog />);
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(answers().length).toBe(1));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false));
  expect(useAppStore.getState().factoryGateRunId).toBe('r1');
});

it('a gate that is no longer waiting shows the already-answered state', () => {
  useFactoryStore.setState({ runs: { r1: mkRun('running', 's1') } });
  render(<FactoryGateDialog />);
  expect(screen.getByText('This gate was already answered.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
  expect(useAppStore.getState().factoryGateRunId).toBeNull();
});

const ALREADY = 'This gate was already answered.';

it('answering does not flash the already-answered state', async () => {
  let resolveAnswer: (v: unknown) => void = () => {};
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    if (cmd === 'get_factory_artifact') return artifactFor(args);
    if (cmd === 'answer_factory_gate') {
      // The run moves on (for example from another listener) before the answer resolves.
      useFactoryStore.setState({ runs: { r1: mkRun('running', 's1') } });
      return new Promise((r) => { resolveAnswer = r; });
    }
    return null;
  });
  render(<FactoryGateDialog />);
  await screen.findByText('# Plan');
  let flashed = false;
  const seen = () => { if (document.body.textContent?.includes(ALREADY)) flashed = true; };
  const observer = new MutationObserver(seen);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(answers().length).toBe(1));
  await act(async () => { await Promise.resolve(); });
  seen();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();

  await act(async () => { resolveAnswer(answered()); });
  await waitFor(() => expect(useAppStore.getState().factoryGateRunId).toBeNull());
  observer.disconnect();
  seen();
  expect(flashed).toBe(false);
});

it('re-entering the gate clears the previous file text before the new load resolves', async () => {
  render(<FactoryGateDialog />);
  await screen.findByText('# Plan');
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === 'get_factory_artifact') return new Promise(() => {});
    return null;
  });
  act(() => { useFactoryStore.setState({ runs: { r1: mkRun('running', 's1') } }); });
  act(() => { useFactoryStore.setState({ runs: { r1: mkRun('waiting_gate') } }); });
  expect(screen.queryByText('# Plan')).toBeNull();
  expect(screen.getAllByText('Loading...').length).toBe(2);
});
