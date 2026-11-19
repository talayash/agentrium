import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../lib/raceActions', () => ({ focusTerminal: vi.fn() }));
import { focusTerminal } from '../lib/raceActions';
import { FactorySidebarGroups } from './FactorySidebarGroups';
import { useFactoryStore } from '../store/factoryStore';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import type { Definition, Factory, FactoryRun, RunStatus } from '../lib/factory';

const def: Definition = {
  version: 1, name: 'Line', source: 'x', source_sha256: 'h',
  input: { label: 'Ticket', placeholder: 'T-1' }, workspace: 'worktree', agent: 'claude', rules: [],
  steps: [
    { kind: 'station', id: 's1', name: 'Plan', prompt: 'p' },
    { kind: 'gate', id: 'g1', name: 'Plan approval', question: 'ok?', pass_label: 'Yes', reject_label: 'No', show: [], notes: [], on_reject: 's1' },
  ],
};
const mkFactory = (id: string, name: string, updatedAt: string): Factory => ({
  id, name, repoPath: '/repo', sourcePath: '/repo/l.json', definition: def, createdAt: updatedAt, updatedAt, diskState: 'same',
});
const mkRun = (id: string, factoryId: string, status: RunStatus, step: string, extra: Partial<FactoryRun> = {}): FactoryRun => ({
  id, factoryId, input: `T-${id}`, status, currentStep: step, attempts: {}, rejectReason: '', checkOutput: '',
  definition: def, workspacePath: '/wt', branch: null, runDir: '/rd', terminalId: null, stationStartedAt: null,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...extra,
});
const setState = (factories: Factory[], runs: FactoryRun[]) =>
  useFactoryStore.setState({
    factories: Object.fromEntries(factories.map((f) => [f.id, f])),
    runs: Object.fromEntries(runs.map((r) => [r.id, r])),
  });

beforeEach(() => {
  vi.mocked(focusTerminal).mockReset();
  useFactoryStore.setState({ factories: {}, runs: {} });
  useTerminalStore.setState({ terminals: new Map() });
  useAppStore.setState({ factoryGateRunId: null, openFactoryTab: vi.fn() });
});
afterEach(cleanup);

it('renders nothing without open runs', () => {
  setState([mkFactory('f1', 'Line', '2026-11-01T00:00:00Z')], [mkRun('a', 'f1', 'done', 's1')]);
  const { container } = render(<FactorySidebarGroups />);
  expect(container.firstChild).toBeNull();
});

it('one group per factory with open runs, needs-you runs first', () => {
  setState(
    [mkFactory('f1', 'Line', '2026-11-01T00:00:00Z'), mkFactory('f2', 'Other', '2026-11-02T00:00:00Z'), mkFactory('f3', 'Idle', '2026-11-03T00:00:00Z')],
    [mkRun('a', 'f1', 'running', 's1'), mkRun('b', 'f1', 'waiting_gate', 'g1'), mkRun('c', 'f2', 'blocked', 's1', { updatedAt: '2026-11-05T00:00:00Z' }), mkRun('d', 'f3', 'done', 's1')],
  );
  const { container } = render(<FactorySidebarGroups />);
  const groups = container.querySelectorAll('[data-factory-group]');
  expect([...groups].map((g) => g.getAttribute('data-factory-group'))).toEqual(['f2', 'f1']);
  const rows = within(groups[1] as HTMLElement).getAllByRole('listitem');
  expect(rows[0].textContent).toContain('T-b');
  expect(rows[0].textContent).toContain('g1 needs you');
  expect(rows[1].textContent).toContain('T-a');
  expect(rows[1].textContent).toContain('Plan');
  expect(within(groups[0] as HTMLElement).getByText('Plan blocked')).toBeTruthy();
  fireEvent.click(within(rows[0] as HTMLElement).getByRole('button'));
  expect(useAppStore.getState().factoryGateRunId).toBe('b');
});

it('shows at most 5 rows and an "n more" line', () => {
  const runs = Array.from({ length: 8 }, (_, i) => mkRun(`r${i}`, 'f1', 'running', 's1'));
  setState([mkFactory('f1', 'Line', '2026-11-01T00:00:00Z')], runs);
  const { container } = render(<FactorySidebarGroups />);
  expect(within(container.querySelector('[data-factory-group]') as HTMLElement).getAllByRole('button', { name: /^T-/ })).toHaveLength(5);
  expect(screen.getByText('3 more')).toBeTruthy();
});

it('a row for a running run with a live session focuses its terminal', () => {
  setState([mkFactory('f1', 'Line', '2026-11-01T00:00:00Z')], [mkRun('a', 'f1', 'running', 's1', { terminalId: 't1' })]);
  useTerminalStore.setState({ terminals: new Map([['t1', { config: { id: 't1' } } as never]]) });
  render(<FactorySidebarGroups />);
  fireEvent.click(screen.getByRole('button', { name: /T-a/ }));
  expect(focusTerminal).toHaveBeenCalledWith('t1');
});
