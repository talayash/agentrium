import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../lib/confirmDialog', () => ({ confirmAction: vi.fn() }));
vi.mock('../lib/errorReporter', () => ({ reportInvokeFailure: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { confirmAction } from '../lib/confirmDialog';
import { reportInvokeFailure } from '../lib/errorReporter';
import { FactoryNavigator } from './FactoryNavigator';
import { useFactoryStore } from '../store/factoryStore';
import { useAppStore } from '../store/appStore';
import type { Definition, Factory, FactoryRun, RunStatus } from '../lib/factory';

const def: Definition = {
  version: 1, name: 'Ticket line', source: 'x', source_sha256: 'h',
  input: { label: 'Ticket', placeholder: 'WGCP-1' }, workspace: 'worktree', agent: 'claude', rules: [],
  steps: [
    { kind: 'station', id: 's1', name: 'Plan', prompt: 'p' },
    { kind: 'gate', id: 'g1', name: 'Plan approval', question: 'ok?', pass_label: 'Yes', reject_label: 'No', show: [], notes: [], on_reject: 's1' },
  ],
};
const factory: Factory = {
  id: 'f1', name: 'Ticket line', repoPath: 'C:/work/shop', sourcePath: 'C:/work/shop/.agentrium/line.json', definition: def,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', diskState: 'same',
};
const mkRun = (id: string, status: RunStatus, step: string): FactoryRun => ({
  id, factoryId: 'f1', input: `WGCP-${id}`, status, currentStep: step, attempts: {}, rejectReason: '', checkOutput: '',
  definition: def, workspacePath: '/wt', branch: null, runDir: '/rd', terminalId: null,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: new Date().toISOString(),
});
const setState = (...runs: FactoryRun[]) =>
  useFactoryStore.setState({ factories: { f1: factory }, runs: Object.fromEntries(runs.map((r) => [r.id, r])) });

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(confirmAction).mockReset();
  useFactoryStore.setState({ factories: {}, runs: {} });
  useAppStore.setState({ factoryGateRunId: null, newFactoryRunFactoryId: null, addFactoryModalOpen: false, openFactoryTab: vi.fn() });
});
afterEach(cleanup);

it('lists factories with run counts', () => {
  setState(mkRun('a', 'waiting_gate', 'g1'), mkRun('b', 'running', 's1'), mkRun('c', 'blocked', 's1'), mkRun('d', 'done', 's1'));
  render(<FactoryNavigator />);
  const card = screen.getByTestId('factory-f1');
  expect(within(card).getByText('Ticket line')).toBeTruthy();
  expect(within(card).getByText('shop / line.json')).toBeTruthy();
  expect(within(card).getByText('3 runs')).toBeTruthy();
  expect(within(card).getByText('2 need you')).toBeTruthy();
  expect(within(card).getByText('1 blocked')).toBeTruthy();
});

it('Needs you lists gate and blocked runs and opens the gate dialog for a gate', () => {
  setState(mkRun('a', 'waiting_gate', 'g1'), mkRun('c', 'blocked', 's1'), mkRun('b', 'running', 's1'));
  render(<FactoryNavigator />);
  expect(screen.getByText('Needs you')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /WGCP-a/ }));
  expect(useAppStore.getState().factoryGateRunId).toBe('a');
  fireEvent.click(screen.getByRole('button', { name: /WGCP-c/ }));
  expect(useAppStore.getState().openFactoryTab).toHaveBeenCalledWith('f1', 'Ticket line');
});

it('the section is hidden when nothing waits', () => {
  setState(mkRun('b', 'running', 's1'));
  render(<FactoryNavigator />);
  expect(screen.queryByText('Needs you')).toBeNull();
  expect(screen.getByText('Factories')).toBeTruthy();
});

it('clicking a factory opens its floor tab', () => {
  setState();
  render(<FactoryNavigator />);
  expect(screen.getByText('No runs')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open factory Ticket line' }));
  expect(useAppStore.getState().openFactoryTab).toHaveBeenCalledWith('f1', 'Ticket line');
});

it('Remove asks first and removes on confirm', async () => {
  setState(mkRun('b', 'running', 's1'));
  vi.mocked(confirmAction).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  vi.mocked(invoke).mockResolvedValue(undefined);
  render(<FactoryNavigator />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove factory Ticket line' }));
  await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove factory Ticket line' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('delete_factory', { factoryId: 'f1' }));
  await waitFor(() => expect(useFactoryStore.getState().factories.f1).toBeUndefined());
  expect(vi.mocked(confirmAction).mock.calls[1][0]).toBe('Remove this factory from Agentrium? Its files in the repo are not touched.');
});

it('New run opens the run dialog for that factory', () => {
  setState();
  render(<FactoryNavigator />);
  fireEvent.click(screen.getByRole('button', { name: 'New run in Ticket line' }));
  expect(useAppStore.getState().newFactoryRunFactoryId).toBe('f1');
});

it('empty state offers to add a factory', () => {
  render(<FactoryNavigator />);
  expect(screen.getByText('No factories yet')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add a factory' }));
  expect(useAppStore.getState().addFactoryModalOpen).toBe(true);
});

it('a factory whose only open run is blocked has a visible error dot', () => {
  setState(mkRun('c', 'blocked', 's1'));
  render(<FactoryNavigator />);
  const dot = within(screen.getByTestId('factory-f1')).getByTestId('factory-dot');
  expect(dot.hasAttribute('data-factory-dot')).toBe(true);
  expect(dot.className).toContain('bg-error');
});

it('a factory with a gate run has a violet dot', () => {
  setState(mkRun('a', 'waiting_gate', 'g1'), mkRun('c', 'blocked', 's1'));
  render(<FactoryNavigator />);
  const dot = within(screen.getByTestId('factory-f1')).getByTestId('factory-dot');
  expect(dot.style.background).toContain('--attention-input');
  expect(dot.className).not.toContain('bg-error');
});

it('Remove failure reports and keeps the factory listed', async () => {
  setState(mkRun('b', 'running', 's1'));
  vi.mocked(confirmAction).mockResolvedValue(true);
  vi.mocked(invoke).mockRejectedValue(new Error('boom'));
  render(<FactoryNavigator />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove factory Ticket line' }));
  await waitFor(() => expect(reportInvokeFailure).toHaveBeenCalledWith('delete_factory', expect.anything()));
  expect(useFactoryStore.getState().factories.f1).toBeDefined();
  expect(screen.getByTestId('factory-f1')).toBeTruthy();
});
