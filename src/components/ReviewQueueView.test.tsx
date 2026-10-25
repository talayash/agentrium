import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
const invoke = vi.fn().mockResolvedValue(null);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import { ReviewQueueView } from './ReviewQueueView';
import { useAttentionStore } from '../store/attentionStore';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';
import { useAppStore, REVIEW_QUEUE_TAB } from '../store/appStore';
import { useTaskObservationStore } from '../store/taskObservationStore';
import { useToastStore } from '../store/toastStore';

const task = { title: 'Fix login', branch: 'agentrium/fix-login', baseBranch: 'main', worktreePath: '/wt/fix', repoPath: '/repo' };
const config = (id: string, patch: Partial<TerminalConfig> = {}): TerminalConfig => ({
  id, label: `Session ${id}`, nickname: null, profile_id: null, working_directory: '/repo', claude_args: [], env_vars: {},
  created_at: '', status: 'Running', color_tag: null, agent: 'claude', ...patch,
});

beforeEach(() => {
  invoke.mockClear();
  useTerminalStore.setState({ terminals: new Map([
    ['a', { config: config('a'), xterm: null, isWorktree: false }],
    ['t', { config: config('t', { task }), xterm: null, isWorktree: true }],
  ]), terminalStates: new Map(), activeTerminalId: null });
  useAttentionStore.setState({ items: [] });
  useTaskObservationStore.setState({ byTerminal: {} });
  useAppStore.setState({ gridMode: true, splitMode: true, changesOpen: false, finishTaskTerminalId: null, openFiles: [], activeFilePath: null });
  useAppStore.getState().openReviewQueue();
});
afterEach(cleanup);

const put = (terminalId: string, kind: Parameters<ReturnType<typeof useAttentionStore.getState>['put']>[0]['kind'], detail = 'detail') =>
  useAttentionStore.getState().put({ terminalId, targetId: terminalId, kind, title: `Session ${terminalId}`, detail });

describe('ReviewQueueView', () => {
  it('opens as a single tab and shows an empty state', () => {
    useAppStore.getState().openReviewQueue();
    expect(useAppStore.getState().openFiles.filter(t => t.path === REVIEW_QUEUE_TAB)).toHaveLength(1);
    expect(useAppStore.getState().gridMode).toBe(false);
    render(<ReviewQueueView />);
    expect(screen.getByText('Nothing to review')).toBeTruthy();
  });

  it('groups entries by state', () => {
    put('a', 'input');
    put('t', 'merge', '1 commit ready');
    render(<ReviewQueueView />);
    expect(within(screen.getByRole('region', { name: 'Needs input' })).getByText('Session a')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Ready to merge' })).getByText('Session t')).toBeTruthy();
  });

  it('selecting an entry opens its session out of grid and split without changing the item', () => {
    put('a', 'input');
    render(<ReviewQueueView />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Session a: Needs input' }));
    expect(useTerminalStore.getState().activeTerminalId).toBe('a');
    expect(useAppStore.getState().gridMode).toBe(false);
    expect(useAppStore.getState().splitMode).toBe(false);
    expect(useAppStore.getState().activeFilePath).toBeNull();
    expect(useAttentionStore.getState().items).toHaveLength(1);
  });

  it('opens finished work with its changes panel', () => {
    put('a', 'review');
    render(<ReviewQueueView />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Session a: Ready to review' }));
    expect(useAppStore.getState().changesOpen).toBe(true);
  });

  it('Finish task opens the finish dialog and never merges by itself', () => {
    put('t', 'merge');
    render(<ReviewQueueView />);
    fireEvent.click(screen.getByRole('button', { name: /Finish task/ }));
    expect(useAppStore.getState().finishTaskTerminalId).toBe('t');
    expect(invoke).not.toHaveBeenCalledWith('finish_task', expect.anything());
  });

  it('marks reviewed into a collapsed Reviewed group and revisits back', () => {
    put('a', 'review');
    render(<ReviewQueueView />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark Session a reviewed' }));
    expect(screen.queryByRole('region', { name: 'Ready to review' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Reviewed/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Revisit Session a' }));
    expect(within(screen.getByRole('region', { name: 'Ready to review' })).getByText('Session a')).toBeTruthy();
  });

  it('dismisses an entry, including a session item folded into a merge entry', () => {
    put('t', 'review');
    put('t', 'merge');
    render(<ReviewQueueView />);
    expect(screen.getAllByRole('button', { name: /^Dismiss/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Session t' }));
    expect(useAttentionStore.getState().items).toEqual([]);
    expect(screen.getByText('Nothing to review')).toBeTruthy();
  });

  it('removes entries when their session closes and leaves stale entries harmless', () => {
    put('a', 'review');
    render(<ReviewQueueView />);
    // The attention inbox subscriber is not mounted here, so the item stays
    // until retain runs: the entry is shown as stale and opening it only toasts.
    act(() => useTerminalStore.setState({ terminals: new Map() }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Session a: Ready to review' }));
    expect(useTerminalStore.getState().activeTerminalId).toBeNull();
    expect(useToastStore.getState().toasts.at(-1)?.title).toBe('Session no longer open');
    act(() => useAttentionStore.getState().retain(new Set()));
    expect(screen.getByText('Nothing to review')).toBeTruthy();
  });
});
