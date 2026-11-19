import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
const reportInvokeFailure = vi.fn();
vi.mock('../lib/errorReporter', () => ({ reportInvokeFailure: (...a: unknown[]) => reportInvokeFailure(...a) }));
import { NewFactoryRunModal } from './NewFactoryRunModal';
import { useAppStore } from '../store/appStore';
import { useFactoryStore } from '../store/factoryStore';
import type { Definition, Factory } from '../lib/factory';

const def = (over: Partial<Definition> = {}, check = false): Definition => ({
  version: 1, name: 'Ship it', source: 'f.md', source_sha256: 'x',
  input: { label: 'Ticket id', placeholder: 'e.g. A-1' }, workspace: 'worktree', agent: 'claude',
  rules: [],
  steps: [
    { kind: 'station', id: 'build', name: 'Build', prompt: 'p', artifact: null, check: check ? { command: 'npm test' } : null },
  ],
  ...over,
});
const factory = (id: string, name: string, d: Definition = def()): Factory => ({
  id, name, repoPath: '/repo', sourcePath: '/repo/f.md', definition: d, createdAt: '', updatedAt: '', diskState: 'same',
});

beforeEach(() => {
  reportInvokeFailure.mockReset();
  invokeMock.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd === 'start_factory_run') {
      return {
        run: {
          id: 'r1', factoryId: 'f1', input: 'A-1', status: 'running', currentStep: 'build', attempts: {}, rejectReason: '',
          checkOutput: '', definition: def(), workspacePath: '/repo', branch: null, runDir: '', terminalId: null, stationStartedAt: null, createdAt: '', updatedAt: '',
        },
        action: { kind: 'waiting' },
      };
    }
    return undefined;
  });
  useFactoryStore.setState({ factories: { f1: factory('f1', 'Ship it') }, runs: {} });
  useAppStore.setState({ newFactoryRunFactoryId: 'f1', addFactoryModalOpen: false, activeFilePath: null });
});
afterEach(cleanup);

it("uses the factory's input label and placeholder", () => {
  render(<NewFactoryRunModal />);
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByText('New run')).toBeTruthy();
  const input = screen.getByLabelText('Ticket id') as HTMLInputElement;
  expect(input.placeholder).toBe('e.g. A-1');
  expect(screen.getByText('Gets its own worktree and branch.')).toBeTruthy();
});

it('describes the queue for an in-place factory', () => {
  useFactoryStore.setState({ factories: { f1: factory('f1', 'Ship it', def({ workspace: 'in_place' })) } });
  render(<NewFactoryRunModal />);
  expect(screen.getByText('Runs in /repo. If another run is building, this one waits in the queue.')).toBeTruthy();
});

it('shows a factory picker only when opened globally', () => {
  useFactoryStore.setState({ factories: { f1: factory('f1', 'Ship it'), f2: factory('f2', 'Other') } });
  const { unmount } = render(<NewFactoryRunModal />);
  expect(screen.queryByRole('combobox')).toBeNull();
  unmount();
  useAppStore.setState({ newFactoryRunFactoryId: null });
  render(<NewFactoryRunModal />);
  const select = screen.getByRole('combobox') as HTMLSelectElement;
  expect(select.value).toBe('f1');
  fireEvent.change(select, { target: { value: 'f2' } });
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('f2');
});

it('preselects the factory of the active factory tab when opened globally', () => {
  useFactoryStore.setState({ factories: { f1: factory('f1', 'Ship it'), f2: factory('f2', 'Other') } });
  useAppStore.setState({ newFactoryRunFactoryId: null, activeFilePath: 'factory:f2' });
  render(<NewFactoryRunModal />);
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('f2');
});

it('Start runs the factory and opens its floor', async () => {
  const openFactoryTab = vi.fn();
  useAppStore.setState({ openFactoryTab });
  render(<NewFactoryRunModal />);
  fireEvent.change(screen.getByLabelText('Ticket id'), { target: { value: 'A-1' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start' })); });
  expect(invokeMock).toHaveBeenCalledWith('start_factory_run', { factoryId: 'f1', input: 'A-1' });
  expect(openFactoryTab).toHaveBeenCalledWith('f1', 'Ship it');
  expect(useAppStore.getState().newFactoryRunFactoryId).toBeUndefined();
});

it('a refused start shows the message and stays open', async () => {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'start_factory_run') throw 'Enter the ticket.';
    return undefined;
  });
  render(<NewFactoryRunModal />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start' })); });
  expect(screen.getByRole('alert').textContent).toBe('Enter the ticket.');
  expect(useAppStore.getState().newFactoryRunFactoryId).toBe('f1');
  expect(reportInvokeFailure).toHaveBeenCalledWith('start_factory_run', 'Enter the ticket.');
});

it('with no factories it offers to add one', () => {
  useFactoryStore.setState({ factories: {} });
  useAppStore.setState({ newFactoryRunFactoryId: null });
  render(<NewFactoryRunModal />);
  expect(screen.getByText('Add a factory first.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add a factory' }));
  expect(useAppStore.getState().newFactoryRunFactoryId).toBeUndefined();
  expect(useAppStore.getState().addFactoryModalOpen).toBe(true);
});

const SAFE_LINE = 'Only letters, digits and . _ : / # @ - are allowed, because this factory runs a check command.';

it('explains the safe-character rule only when a station has a check', () => {
  useFactoryStore.setState({ factories: { f1: factory('f1', 'Ship it', def({}, true)) } });
  const { unmount } = render(<NewFactoryRunModal />);
  expect(screen.getByText(SAFE_LINE)).toBeTruthy();
  unmount();
  useFactoryStore.setState({ factories: { f1: factory('f1', 'Ship it', def({}, false)) } });
  render(<NewFactoryRunModal />);
  expect(screen.queryByText(SAFE_LINE)).toBeNull();
});
