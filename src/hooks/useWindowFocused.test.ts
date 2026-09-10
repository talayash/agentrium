import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWindowFocused } from './useWindowFocused';

const win = vi.hoisted(() => ({ isFocused: vi.fn(), onFocusChanged: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }));

describe('useWindowFocused', () => {
  beforeEach(() => {
    win.isFocused.mockResolvedValue(true);
    win.onFocusChanged.mockResolvedValue(vi.fn());
  });
  afterEach(cleanup);

  it('loads initial focus and follows focus events', async () => {
    win.isFocused.mockResolvedValue(false);
    const { result } = renderHook(useWindowFocused);
    await act(async () => {});
    expect(result.current).toBe(false);
    act(() => win.onFocusChanged.mock.calls[0][0]({ payload: true }));
    expect(result.current).toBe(true);
  });

  it('keeps the safe default when native APIs fail', async () => {
    win.isFocused.mockRejectedValue(new Error('unavailable'));
    win.onFocusChanged.mockRejectedValue(new Error('unavailable'));
    const { result } = renderHook(useWindowFocused);
    await act(async () => {});
    expect(result.current).toBe(true);
  });

  it('unregisters a listener that resolves after unmount', async () => {
    let resolve!: (fn: () => void) => void;
    const unlisten = vi.fn();
    win.onFocusChanged.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { unmount } = renderHook(useWindowFocused);
    unmount();
    await act(async () => resolve(unlisten));
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('unregisters an already installed listener', async () => {
    const unlisten = vi.fn();
    win.onFocusChanged.mockResolvedValue(unlisten);
    const { unmount } = renderHook(useWindowFocused);
    await act(async () => {});
    unmount();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('does not overwrite a newer focus event with a stale initial query', async () => {
    let resolve!: (focused: boolean) => void;
    win.isFocused.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result } = renderHook(useWindowFocused);
    act(() => win.onFocusChanged.mock.calls[0][0]({ payload: false }));
    await act(async () => resolve(true));
    expect(result.current).toBe(false);
  });
});
