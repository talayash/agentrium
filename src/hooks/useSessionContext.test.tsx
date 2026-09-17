import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('../lib/sessionContext', () => ({ refreshSessionContext: mocks.refresh }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { useTerminalStore } from '../store/terminalStore';
import { useSessionContext } from './useSessionContext';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  mocks.refresh.mockReset().mockResolvedValue(false);
  useTerminalStore.setState({ terminals: new Map([['one', {
    config: { id: 'one', label: 'Agentrium 1', nickname: null, profile_id: null, working_directory: '/project', claude_args: [], env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'codex' },
    xterm: null, isWorktree: false,
  }]]) });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('retries missing metadata without requiring terminal output and stops on unmount', async () => {
  const { unmount } = renderHook(() => useSessionContext());
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(mocks.refresh.mock.calls).toEqual([['one', false, true], ['one']]);
  await act(() => vi.advanceTimersByTimeAsync(20_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(mocks.refresh).toHaveBeenCalledTimes(3);
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(300_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(3);
});

it('loads saved context once and avoids repeated extraction', async () => {
  mocks.refresh.mockImplementation(async () => {
    useTerminalStore.getState().setSessionContext('one', {
      title: 'Fix login', goal: 'Fix login', latest: '', generated: false, updatedAt: '',
    });
    return true;
  });
  renderHook(() => useSessionContext());
  await act(() => vi.advanceTimersByTimeAsync(300_000));
  expect(mocks.refresh.mock.calls).toEqual([['one', false, true]]);
});

it('continues to other sessions after one metadata read fails', async () => {
  const one = useTerminalStore.getState().terminals.get('one')!;
  useTerminalStore.setState({ terminals: new Map([
    ['one', one], ['two', { ...one, config: { ...one.config, id: 'two' } }],
    ['shell', { ...one, config: { ...one.config, id: 'shell' }, isShellTerminal: true }],
  ]) });
  mocks.refresh.mockImplementation(async (id: string) => {
    if (id === 'one') throw new Error('unavailable');
    return false;
  });
  renderHook(() => useSessionContext());
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(mocks.refresh).toHaveBeenCalledWith('two');
  expect(mocks.refresh.mock.calls.some(([id]) => id === 'shell')).toBe(false);
});
