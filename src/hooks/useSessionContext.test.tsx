import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ refresh: vi.fn(), capture: vi.fn(), lastOutput: vi.fn() }));
vi.mock('../lib/sessionContext', () => ({ refreshSessionContext: mocks.refresh, captureSessionScreen: mocks.capture }));
vi.mock('../lib/terminalActivity', () => ({ getLastOutputAt: mocks.lastOutput, markTerminalActive: vi.fn(), clearTerminalActivity: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { useTerminalStore } from '../store/terminalStore';
import { useSessionContext } from './useSessionContext';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  mocks.refresh.mockReset().mockResolvedValue(false);
  mocks.capture.mockReset().mockReturnValue('Task and progress '.repeat(10));
  mocks.lastOutput.mockReset().mockReturnValue(100_000);
  useTerminalStore.setState({ terminals: new Map([['one', {
    config: { id: 'one', label: 'Agentrium 1', nickname: null, profile_id: null, working_directory: '/project', claude_args: [], env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'codex' },
    xterm: null, isWorktree: false,
  }]]) });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('loads persisted context, waits for quiet, and does not repeatedly summarize unchanged output', async () => {
  renderHook(() => useSessionContext());
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(mocks.refresh.mock.calls).toEqual([['one', false, true]]);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(mocks.refresh.mock.calls).toEqual([['one', false, true], ['one']]);
  await act(() => vi.advanceTimersByTimeAsync(300_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
});

it('can title a continuously running task after thirty seconds', async () => {
  mocks.lastOutput.mockImplementation(() => Date.now());
  renderHook(() => useSessionContext());
  await act(() => vi.advanceTimersByTimeAsync(25_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
});

it('throttles changed output and stops polling on unmount', async () => {
  const { unmount } = renderHook(() => useSessionContext());
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  mocks.capture.mockReturnValue('New progress '.repeat(15));
  mocks.lastOutput.mockReturnValue(110_000);
  await act(() => vi.advanceTimersByTimeAsync(115_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(mocks.refresh).toHaveBeenCalledTimes(3);
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(300_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(3);
});
