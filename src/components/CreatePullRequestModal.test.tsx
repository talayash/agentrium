import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../lib/clipboard', () => ({ copyText: vi.fn(async () => true), readClipboardText: vi.fn(async () => '') }));
import { invoke } from '@tauri-apps/api/core';
import { copyText } from '../lib/clipboard';
import { CreatePullRequestModal } from './CreatePullRequestModal';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { usePrStore } from '../store/prStore';
import { DEFAULT_PR_BODY_TEMPLATE, prKey, type PrContext, type RemoteInfo } from '../lib/pullRequests';
import type { TaskInfo } from '../lib/tasks';
import type { PushPreview } from '../types/git';

const task: TaskInfo = { title: 'Add search', branch: 'agentrium/add-search', baseBranch: 'origin/develop', worktreePath: '/wt/add-search', repoPath: '/repo' };
const config: TerminalConfig = {
  id: 't1', label: 'Add search', nickname: null, profile_id: null, working_directory: task.worktreePath,
  claude_args: [], env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'claude', task,
};
let remote: RemoteInfo;
let preview: PushPreview;
const ctx: PrContext = {
  base_ref: 'origin/develop',
  commits: [{ short_sha: 'b2', subject: 'Wire the index' }, { short_sha: 'a1', subject: 'Add search box' }],
  files: [{ status: 'A', path: 'src/search.ts' }, { status: 'M', path: 'src/app.ts' }],
};

beforeEach(() => {
  remote = {
    remote: 'origin', host: 'github.com', owner: 'o', repo: 'r', provider: 'github', web_url: 'https://github.com/o/r',
    gh: { installed: true, authenticated: true }, glab: { installed: false, authenticated: false }, cli: 'gh',
  };
  preview = {
    local_branch: task.branch, remotes: ['origin'], default_remote: 'origin', default_remote_branch: task.branch,
    has_upstream: true, commits: [], ahead: 0, behind: 0,
  };
  useTerminalStore.setState({
    terminals: new Map([['t1', { config, xterm: null, isWorktree: true, sessionContext: { title: 'Search', goal: 'Users can search notes', latest: 'Index wired up', updatedAt: '', generated: true } }]]),
    gitInfoCache: new Map([['t1', { is_git_repo: true, is_worktree: true, main_repo_path: '/repo', current_branch: task.branch, worktree_root: task.worktreePath, dirty_count: 0, ahead: 0, behind: 0 }]]),
  });
  useAppStore.setState({
    createPrModalOpen: true, createPrRepoPath: task.worktreePath, createPrTerminalId: 't1',
    prMethod: 'auto', prDraftByDefault: true, prBodyTemplate: DEFAULT_PR_BODY_TEMPLATE, promptDrafts: {},
  });
  usePrStore.setState({ refs: {}, statuses: {} });
  vi.mocked(copyText).mockClear();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    switch (cmd) {
      case 'get_remote_info': return remote;
      case 'get_push_preview': return preview;
      case 'get_default_branch': return 'main';
      case 'get_repo_remote_refs': return ['origin/develop', 'origin/main', `origin/${task.branch}`];
      case 'get_pr_context': return ctx;
      case 'get_pull_request_status': return null;
      case 'create_pull_request': return { url: 'https://github.com/o/r/pull/7', number: 7, provider: 'github', already_existed: false };
      case 'build_pr_compare_url': return { url: 'https://github.com/o/r/compare/develop...x?expand=1', body: 'truncated' };
      default: return null;
    }
  });
});
afterEach(cleanup);

const callsTo = (cmd: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === cmd).map(([, a]) => a);

it('prefills base from the task, title from the task, and body from session, files and commits', async () => {
  render(<CreatePullRequestModal />);
  const title = await screen.findByLabelText('Title') as HTMLInputElement;
  await waitFor(() => expect(title.value).toBe('Add search'));
  expect((screen.getByLabelText('Base branch') as HTMLSelectElement).value).toBe('develop');
  // The head branch is never offered as its own base.
  expect([...(screen.getByLabelText('Base branch') as HTMLSelectElement).options].map(o => o.value)).toEqual(['develop', 'main']);
  const body = (screen.getByLabelText('Description') as HTMLTextAreaElement).value;
  expect(body).toBe([
    '## Summary', '', 'Users can search notes', '', 'Index wired up', '',
    '## Changes', '', '- `src/search.ts` (added)', '- `src/app.ts` (modified)', '',
    '## Commits', '', '- Wire the index (b2)', '- Add search box (a1)',
  ].join('\n'));
  expect(screen.getByTestId('pr-method').textContent).toBe('via gh');
  expect(callsTo('get_pr_context')).toEqual([{ path: task.worktreePath, base: 'develop' }]);
});

it('keeps the user\'s title when the base changes', async () => {
  render(<CreatePullRequestModal />);
  const title = await screen.findByLabelText('Title') as HTMLInputElement;
  await waitFor(() => expect(title.value).toBe('Add search'));
  fireEvent.change(title, { target: { value: 'My own title' } });
  fireEvent.change(screen.getByLabelText('Base branch'), { target: { value: 'main' } });
  await waitFor(() => expect(callsTo('get_pr_context')).toHaveLength(2));
  expect(title.value).toBe('My own title');
});

it('creates the PR through gh as a draft and tracks it on the tab', async () => {
  render(<CreatePullRequestModal />);
  await waitFor(() => expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Add search'));
  fireEvent.click(screen.getByRole('button', { name: 'Create Pull Request' }));
  await screen.findByText('Pull request #7 created');
  expect(callsTo('create_pull_request')[0]).toMatchObject({ path: task.worktreePath, base: 'develop', head: task.branch, title: 'Add search', draft: true });
  const { updatedAt, ...ref } = usePrStore.getState().refs[prKey(task.worktreePath, task.branch)];
  expect(typeof updatedAt).toBe('number');
  // Exactly the ref fields: nothing else from the CLI result is persisted.
  expect(ref).toEqual({ url: 'https://github.com/o/r/pull/7', number: 7, provider: 'github', lastState: 'open', lastCi: 'none' });
});

it('falls back to the browser: copies the full body, opens the compare URL and closes', async () => {
  remote = { ...remote, cli: null, gh: { installed: true, authenticated: false } };
  render(<CreatePullRequestModal />);
  await waitFor(() => expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Add search'));
  expect(screen.getByTestId('pr-method').textContent).toBe('opens in browser');
  expect(screen.getByText(/gh is not signed in to github.com/)).toBeTruthy();
  const body = (screen.getByLabelText('Description') as HTMLTextAreaElement).value;
  fireEvent.click(screen.getByRole('button', { name: 'Open in Browser' }));
  await waitFor(() => expect(useAppStore.getState().createPrModalOpen).toBe(false));
  expect(callsTo('build_pr_compare_url')[0]).toMatchObject({ base: 'develop', head: task.branch, title: 'Add search', body });
  expect(copyText).toHaveBeenCalledWith(body);
  expect(callsTo('open_external_url')).toEqual([{ url: 'https://github.com/o/r/compare/develop...x?expand=1' }]);
  expect(callsTo('create_pull_request')).toEqual([]);
});

it('offers to push an unpushed head first and blocks create until then', async () => {
  preview = { ...preview, has_upstream: false, ahead: 2 };
  render(<CreatePullRequestModal />);
  const push = await screen.findByRole('button', { name: 'Push' });
  const create = screen.getByRole('button', { name: 'Create Pull Request' }) as HTMLButtonElement;
  await waitFor(() => expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Add search'));
  expect(create.disabled).toBe(true);
  preview = { ...preview, has_upstream: true, ahead: 0 };
  fireEvent.click(push);
  await waitFor(() => expect(create.disabled).toBe(false));
  expect(callsTo('git_push')).toEqual([{
    path: task.worktreePath, remote: 'origin', remoteBranch: task.branch, mode: 'normal', pushTags: false, setUpstream: true,
  }]);
});

it('stages a draft prompt for the agent without sending it', async () => {
  render(<CreatePullRequestModal />);
  await waitFor(() => expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Add search'));
  fireEvent.click(screen.getByRole('button', { name: /Generate with agent/ }));
  const draft = useAppStore.getState().promptDrafts.t1;
  expect(draft).toContain('`agentrium/add-search` into `develop`');
  expect(draft).toContain('git log origin/develop..HEAD');
  expect(useAppStore.getState().promptEditorOpen).toBe(true);
  expect(callsTo('write_to_terminal')).toEqual([]);
});
