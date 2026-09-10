import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveTerminalIds } from '../lib/terminalActivity';
import { useNowTick } from './useNowTick';

vi.mock('../lib/terminalActivity', () => ({ getActiveTerminalIds: vi.fn() }));

describe('useNowTick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    vi.mocked(getActiveTerminalIds).mockReturnValue(['active']);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('updates the activity clock every half second while work continues', () => {
    const { result } = renderHook(useNowTick);
    expect(result.current).toBe(10_000);
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(10_500);
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(11_000);
    expect(getActiveTerminalIds).toHaveBeenCalledWith(5000);
  });

  it('stops updating when idle and resumes after a new activity burst', () => {
    vi.mocked(getActiveTerminalIds).mockReturnValue([]);
    const { result } = renderHook(useNowTick);
    act(() => vi.advanceTimersByTime(500));
    const idleTime = result.current;
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current).toBe(idleTime);
    vi.mocked(getActiveTerminalIds).mockReturnValue(['active']);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(Date.now());
  });

  it.each([true, false])('cleans up all timers when unmounted (active=%s)', (active) => {
    vi.mocked(getActiveTerminalIds).mockReturnValue(active ? ['active'] : []);
    const { unmount } = renderHook(useNowTick);
    act(() => vi.advanceTimersByTime(500));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
