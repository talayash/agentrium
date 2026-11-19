import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
const launchImportSession = vi.fn();
vi.mock('../lib/factoryActions', () => ({ launchImportSession: (...a: unknown[]) => launchImportSession(...a) }));
import { AddFactoryModal } from './AddFactoryModal';
import { useAppStore } from '../store/appStore';
import { useFactoryStore } from '../store/factoryStore';
import type { Definition, DefinitionReview } from '../lib/factory';

const def = (check: boolean): Definition => ({
  version: 1, name: 'Ship it', source: 'f.md', source_sha256: 'x',
  input: { label: 'Ticket', placeholder: '' }, workspace: 'worktree', agent: 'claude',
  rules: ['Be kind'],
  steps: [
    { kind: 'station', id: 'build', name: 'Build', prompt: 'p', artifact: 'out.md', check: check ? { command: 'npm test' } : null },
    { kind: 'gate', id: 'ok', name: 'Approve', question: 'q?', pass_label: 'Yes', reject_label: 'No', show: [], notes: [], on_reject: 'build' },
  ],
});
const review = (over: Partial<DefinitionReview> = {}, check = true): DefinitionReview => ({
  definition: def(check), parseError: null, lint: { errors: [], warnings: [] }, ...over,
});

let readResult: DefinitionReview | null = review();
let pollResult: DefinitionReview | null = null;
const CANDIDATES = [
  { path: '/r/.agentrium/a.md', relPath: '.agentrium/a.md', hasDefinition: true },
  { path: '/r/.agentrium/b.md', relPath: '.agentrium/b.md', hasDefinition: false },
];
const calls = (name: string) => invokeMock.mock.calls.filter((c) => c[0] === name);

beforeEach(() => {
  vi.useFakeTimers();
  launchImportSession.mockReset().mockResolvedValue('term-1');
  readResult = review();
  pollResult = null;
  invokeMock.mockReset().mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case 'list_factory_candidates': return CANDIDATES;
      case 'read_factory_definition_file': return readResult;
      case 'begin_factory_import': return { importId: 'imp1', outputPath: '/o', prompt: 'read it' };
      case 'poll_factory_import': return pollResult;
      case 'save_factory':
        return { id: 'f1', name: 'Ship it', repoPath: '/r', sourcePath: args.sourcePath, definition: args.definition, createdAt: '', updatedAt: '', diskState: 'same' };
      default: return [];
    }
  });
  useAppStore.setState({ addFactoryModalOpen: true, openFiles: [] } as never);
  useFactoryStore.setState({ factories: {} } as never);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const click = async (name: string | RegExp) => { fireEvent.click(screen.getByRole('button', { name })); await flush(); };
async function toStep2() {
  render(<AddFactoryModal />);
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: '/r' } });
  await click('Next');
}
async function pick(rel: string) {
  fireEvent.click(screen.getByLabelText(new RegExp(rel.replace('.', '\\.'))));
  await click('Next');
}

it('lists candidates and marks the ones already set up', async () => {
  await toStep2();
  expect(screen.getByText('.agentrium/a.md')).toBeTruthy();
  expect(screen.getByText('.agentrium/b.md')).toBeTruthy();
  expect(screen.getAllByText('already set up')).toHaveLength(1);
});

it('a file with a definition goes straight to review without starting an agent', async () => {
  await toStep2();
  await pick('.agentrium/a.md');
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
  expect(launchImportSession).not.toHaveBeenCalled();
  expect(calls('begin_factory_import')).toHaveLength(0);
});

it('a file without a definition starts an import session and shows the review when the poll returns one', async () => {
  readResult = null;
  await toStep2();
  await pick('.agentrium/b.md');
  expect(launchImportSession).toHaveBeenCalledWith('/r', 'read it', 'claude');
  expect(screen.getByText(/Your agent is reading the file/)).toBeTruthy();
  pollResult = review();
  await flush(2000);
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
  const n = calls('poll_factory_import').length;
  await flush(6000);
  expect(calls('poll_factory_import')).toHaveLength(n);
});

it('import gives up after 5 minutes with the no-definition message', async () => {
  readResult = null;
  await toStep2();
  await pick('.agentrium/b.md');
  await flush(5 * 60 * 1000 + 100);
  expect(screen.getByText(/No definition was written/)).toBeTruthy();
  const n = calls('poll_factory_import').length;
  await flush(10000);
  expect(calls('poll_factory_import')).toHaveLength(n);
});

it('Cancel during import stops polling', async () => {
  readResult = null;
  await toStep2();
  await pick('.agentrium/b.md');
  await flush(4000);
  const n = calls('poll_factory_import').length;
  expect(n).toBeGreaterThan(0);
  await click('Cancel');
  await flush(10000);
  expect(calls('poll_factory_import')).toHaveLength(n);
});

it('Confirm is disabled while there are lint errors, and the errors are listed', async () => {
  readResult = review({ lint: { errors: [{ step_id: 'build', message: 'Missing artifact' }], warnings: [{ step_id: null, message: 'Odd name' }] } });
  await toStep2();
  await pick('.agentrium/a.md');
  expect(screen.getByText(/Missing artifact/)).toBeTruthy();
  expect(screen.getByText(/Odd name/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(true);
});

it('the check command notice is shown only when a station has a check', async () => {
  const notice = /These commands will run on your machine/;
  await toStep2();
  await pick('.agentrium/a.md');
  expect(screen.getByText(notice)).toBeTruthy();
  expect(screen.getByText('npm test')).toBeTruthy();
  cleanup();
  readResult = review({}, false);
  await toStep2();
  await pick('.agentrium/a.md');
  expect(screen.queryByText(notice)).toBeNull();
});

it('Confirm saves, writes the file only for an agent import, opens the floor', async () => {
  await toStep2();
  await pick('.agentrium/a.md');
  await click('Confirm');
  expect(calls('save_factory')[0][1]).toMatchObject({ repoPath: '/r', sourcePath: '/r/.agentrium/a.md', writeFile: false });
  expect(useAppStore.getState().openFiles.map((t) => t.path)).toContain('factory:f1');
  expect(useAppStore.getState().addFactoryModalOpen).toBe(false);
  expect(useFactoryStore.getState().factories.f1).toBeTruthy();

  cleanup();
  useAppStore.setState({ addFactoryModalOpen: true, openFiles: [] } as never);
  readResult = null;
  await toStep2();
  await pick('.agentrium/b.md');
  pollResult = review();
  await flush(2000);
  await click('Confirm');
  expect(calls('save_factory')[1][1]).toMatchObject({ writeFile: true });
  expect(useAppStore.getState().openFiles.map((t) => t.path)).toContain('factory:f1');
});

it('a parse error shows the message and no Confirm', async () => {
  readResult = review({ definition: null, parseError: 'bad yaml at line 3' });
  await toStep2();
  await pick('.agentrium/a.md');
  expect(screen.getByText('bad yaml at line 3').className).toContain('text-error');
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
});
