import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
const launchImportSession = vi.fn();
const openPlainSession = vi.fn();
vi.mock('../lib/factoryActions', () => ({
  launchImportSession: (...a: unknown[]) => launchImportSession(...a),
  openPlainSession: (...a: unknown[]) => openPlainSession(...a),
}));
const reportInvokeFailure = vi.fn();
vi.mock('../lib/errorReporter', () => ({ reportInvokeFailure: (...a: unknown[]) => reportInvokeFailure(...a) }));
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
  reportInvokeFailure.mockReset();
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
  expect(calls('save_factory')[0][1].definition).toEqual(def(true));
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

/** Make one command reject, keep the rest as set up in beforeEach. */
function rejectCommand(name: string, message: string) {
  const base = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === name) throw message;
    return base(cmd, args);
  });
}

it('a rejected list_factory_candidates shows an alert and reports it', async () => {
  rejectCommand('list_factory_candidates', 'repo not trusted');
  await toStep2();
  expect(screen.getByRole('alert').textContent).toContain('repo not trusted');
  expect(reportInvokeFailure).toHaveBeenCalledWith('list_factory_candidates', 'repo not trusted');
});

it('a rejected read_factory_definition_file shows an alert and reports it', async () => {
  rejectCommand('read_factory_definition_file', 'outside repo');
  await toStep2();
  await pick('.agentrium/a.md');
  expect(screen.getByRole('alert').textContent).toContain('outside repo');
  expect(reportInvokeFailure).toHaveBeenCalledWith('read_factory_definition_file', 'outside repo');
});

it('a rejected begin_factory_import shows an alert and reports it', async () => {
  readResult = null;
  rejectCommand('begin_factory_import', 'cannot begin');
  await toStep2();
  await pick('.agentrium/b.md');
  expect(screen.getByRole('alert').textContent).toContain('cannot begin');
  expect(reportInvokeFailure).toHaveBeenCalledWith('begin_factory_import', 'cannot begin');
  expect(launchImportSession).not.toHaveBeenCalled();
});

it('a rejected save_factory shows an alert, reports it and keeps the modal open', async () => {
  rejectCommand('save_factory', 'disk full');
  await toStep2();
  await pick('.agentrium/a.md');
  await click('Confirm');
  expect(screen.getByRole('alert').textContent).toContain('disk full');
  expect(reportInvokeFailure).toHaveBeenCalledWith('save_factory', 'disk full');
  expect(useAppStore.getState().addFactoryModalOpen).toBe(true);
});

it('launchImportSession rejecting stays on step 2 without polling', async () => {
  readResult = null;
  launchImportSession.mockRejectedValue('spawn failed');
  await toStep2();
  await pick('.agentrium/b.md');
  expect(screen.getByRole('alert').textContent).toContain('spawn failed');
  expect(reportInvokeFailure).toHaveBeenCalledWith('create_terminal', 'spawn failed');
  await flush(10000);
  expect(calls('poll_factory_import')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
});

it('unmounting mid-import stops polling', async () => {
  readResult = null;
  await toStep2();
  await pick('.agentrium/b.md');
  await flush(4000);
  const n = calls('poll_factory_import').length;
  expect(n).toBeGreaterThan(0);
  cleanup();
  await flush(10000);
  expect(calls('poll_factory_import')).toHaveLength(n);
});

it('unmounting while launchImportSession is pending never starts polling', async () => {
  readResult = null;
  let release: (id: string) => void = () => {};
  launchImportSession.mockImplementation(() => new Promise<string>((r) => { release = r; }));
  await toStep2();
  fireEvent.click(screen.getByLabelText(/\.agentrium\/b\.md/));
  await click('Next');
  cleanup();
  await act(async () => { release('term-1'); });
  await flush(10000);
  expect(calls('poll_factory_import')).toHaveLength(0);
});

it('a failed poll tick is swallowed and the next tick retries', async () => {
  readResult = null;
  await toStep2();
  await pick('.agentrium/b.md');
  const base = invokeMock.getMockImplementation()!;
  let failed = false;
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'poll_factory_import' && !failed) { failed = true; throw 'boom'; }
    return base(cmd, args);
  });
  pollResult = review();
  await flush(2000);
  expect(failed).toBe(true);
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  await flush(2000);
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
});

it('Confirm cannot save while lint errors exist', async () => {
  readResult = review({ lint: { errors: [{ step_id: null, message: 'bad' }], warnings: [] } });
  await toStep2();
  await pick('.agentrium/a.md');
  await click('Confirm');
  expect(calls('save_factory')).toHaveLength(0);
});

const profile = (id: string, name: string, working_directory: string) => ({
  id, name, working_directory, agent: 'claude', claude_args: [], env_vars: {},
});
const withProfiles = (list: unknown[]) => {
  const base = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) =>
    (cmd === 'get_profiles' ? list : base(cmd, args)));
};

it('offers profiles that have a working directory and fills the repo path when one is chosen', async () => {
  withProfiles([
    profile('p1', 'Zeta', 'C:\work\zeta'),
    profile('p2', 'Alpha', 'C:\work\alpha'),
    profile('p3', 'No folder', '  '),
    profile('p4', 'Alpha copy', 'c:\WORK\alpha'),
  ]);
  render(<AddFactoryModal />);
  await flush();
  const select = screen.getByLabelText('Profile') as HTMLSelectElement;
  const options = Array.from(select.options);
  expect(options.map((o) => o.textContent)).toEqual(['Choose a profile...', 'Alpha', 'Zeta']);
  expect(options[0].value).toBe('');
  expect(options[1].title).toBe('C:\work\alpha');
  fireEvent.change(select, { target: { value: options[2].value } });
  expect((screen.getByLabelText('Repository') as HTMLInputElement).value).toBe('C:\work\zeta');
  expect(select.value).toBe(options[2].value);
});

it('hides the profile picker when there are no profiles', async () => {
  withProfiles([profile('p3', 'No folder', '')]);
  render(<AddFactoryModal />);
  await flush();
  expect(screen.queryByLabelText('Profile')).toBeNull();
  expect(screen.getByLabelText('Repository')).toBeTruthy();
});

it('typing in the repository field clears the chosen profile', async () => {
  withProfiles([profile('p1', 'Zeta', 'C:\work\zeta')]);
  render(<AddFactoryModal />);
  await flush();
  const select = screen.getByLabelText('Profile') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: select.options[1].value } });
  expect(select.value).not.toBe('');
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'C:\work\other' } });
  expect(select.value).toBe('');
});

const UNKNOWN = 'Agentrium has not worked in this folder yet: /r. Open a session there once, or save a profile for it, then try again.';
const failFirstList = (error: string) => {
  const base = invokeMock.getMockImplementation()!;
  let failed = false;
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'list_factory_candidates' && !failed) { failed = true; throw error; }
    return base(cmd, args);
  });
};

it('an unknown folder offers to open a session there, and retries after it opens', async () => {
  openPlainSession.mockReset().mockResolvedValue('t9');
  failFirstList(UNKNOWN);
  render(<AddFactoryModal />);
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: '/r' } });
  await click('Next');
  expect(screen.getByRole('alert').textContent).toBe(UNKNOWN);
  await click('Open a session there');
  expect(openPlainSession).toHaveBeenCalledWith('/r');
  expect(calls('list_factory_candidates')).toHaveLength(2);
  expect(screen.getByText('.agentrium/a.md')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('the button is not offered for other errors', async () => {
  openPlainSession.mockReset();
  failFirstList("Invalid path '/r': not found");
  render(<AddFactoryModal />);
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: '/r' } });
  await click('Next');
  expect(screen.getByRole('alert').textContent).toBe("Invalid path '/r': not found");
  expect(screen.queryByRole('button', { name: 'Open a session there' })).toBeNull();
});

it('a failed session open is shown and reported', async () => {
  openPlainSession.mockReset().mockRejectedValue('spawn failed');
  failFirstList(UNKNOWN);
  render(<AddFactoryModal />);
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: '/r' } });
  await click('Next');
  await click('Open a session there');
  expect(screen.getByRole('alert').textContent).toBe('spawn failed');
  expect(reportInvokeFailure).toHaveBeenCalledWith('create_terminal', 'spawn failed');
  expect(calls('list_factory_candidates')).toHaveLength(1);
});
