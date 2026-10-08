import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('../lib/ciRepair', () => ({ loadCiRepairContext: vi.fn(), launchCiRepair: vi.fn() }));
import { CiRepairModal } from './CiRepairModal';
import { launchCiRepair, loadCiRepairContext, type LoadedCiRepair } from '../lib/ciRepair';

const loaded: LoadedCiRepair = {
  target: { terminalId: 's1', path: '/src/app', root: '/src/app', branch: 'feat/login', key: 'k' },
  repoPath: '/src/app',
  unavailable: ['failed job logs'],
  context: {
    status: {
      number: 12, url: 'https://github.com/o/r/pull/12', provider: 'github', state: 'open', draft: false,
      review_decision: null, mergeable: null, ci: { state: 'failure', total: 1, failing: [{ name: 'test', url: null }] },
    },
    branch: 'feat/login', logs: null,
    details: { title: 'Add login', body: 'Adds the login form.', base_branch: 'main', head_sha: null },
    changes: { base_ref: 'origin/main', commits: [{ short_sha: 'abc1234', subject: 'Add form' }], files: [{ status: 'M', path: 'a.ts' }] },
  },
};

beforeEach(() => {
  vi.mocked(loadCiRepairContext).mockResolvedValue(loaded);
  vi.mocked(launchCiRepair).mockResolvedValue({ terminalId: 'r1', staged: false });
});
afterEach(cleanup);

it('shows the context, then starts the selected agent with the edited brief', async () => {
  const close = vi.fn();
  render(<CiRepairModal sourceId="s1" onClose={close} />);
  const input = (await screen.findByLabelText('Repair brief')) as HTMLTextAreaElement;
  await waitFor(() => expect(input.value).toContain('Adds the login form.'));
  expect(input.value).toContain('Add form (abc1234)');
  expect(screen.getByRole('list', { name: 'Repair context' }).textContent).toContain('Not available: failed job logs');
  expect(screen.getByText(/Nothing is pushed/)).toBeTruthy();

  fireEvent.change(input, { target: { value: 'Only fix the test job' } });
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start repair' }));
  await waitFor(() => expect(launchCiRepair).toHaveBeenCalledWith(loaded, 'codex', 'Only fix the test job'));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it('keeps the dialog and the edits open with an actionable error when startup fails', async () => {
  vi.mocked(launchCiRepair).mockRejectedValue(new Error("Base branch 'feat/login' does not exist."));
  const close = vi.fn();
  render(<CiRepairModal sourceId="s1" onClose={close} />);
  const input = (await screen.findByLabelText('Repair brief')) as HTMLTextAreaElement;
  await waitFor(() => expect(input.value).not.toBe(''));
  fireEvent.change(input, { target: { value: 'Keep these edits' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start repair' }));
  expect((await screen.findByRole('alert')).textContent).toContain('does not exist');
  expect(screen.getByDisplayValue('Keep these edits')).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
});

it('cannot start when the context fails to load', async () => {
  vi.mocked(loadCiRepairContext).mockRejectedValue(new Error('CI is not failing on this pull request right now.'));
  render(<CiRepairModal sourceId="s1" onClose={() => {}} />);
  expect((await screen.findByRole('alert')).textContent).toContain('not failing');
  expect((screen.getByRole('button', { name: 'Start repair' }) as HTMLButtonElement).disabled).toBe(true);
});
