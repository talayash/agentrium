import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useHunkUndoStore } from './hunkUndoStore';
import type { HunkAction } from '../types/git';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

const { invoke } = await import('@tauri-apps/api/core');
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

function action(overrides: Partial<HunkAction> = {}): HunkAction {
  return {
    kind: 'stage',
    repoPath: '/repo',
    filePath: 'a.ts',
    hunkPatch: '@@ -1 +1 @@\n-a\n+b\n',
    atLine: 1,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('hunkUndoStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useHunkUndoStore.getState().clear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('push adds action', () => {
    useHunkUndoStore.getState().push(action());
    expect(useHunkUndoStore.getState().stack.length).toBe(1);
  });

  it('timeout clears stack after 5s', () => {
    useHunkUndoStore.getState().push(action());
    vi.advanceTimersByTime(5001);
    expect(useHunkUndoStore.getState().stack.length).toBe(0);
  });

  it('second push within 5s resets timer', () => {
    useHunkUndoStore.getState().push(action());
    vi.advanceTimersByTime(3000);
    useHunkUndoStore.getState().push(action({ atLine: 2 }));
    vi.advanceTimersByTime(3000);
    expect(useHunkUndoStore.getState().stack.length).toBe(2);
    vi.advanceTimersByTime(2001);
    expect(useHunkUndoStore.getState().stack.length).toBe(0);
  });

  it('undoAll reverses stack LIFO and uses apply_hunk with reverse mode', async () => {
    useHunkUndoStore.getState().push(action({ kind: 'stage', filePath: 'x' }));
    useHunkUndoStore.getState().push(action({ kind: 'discard', filePath: 'y' }));

    const promise = useHunkUndoStore.getState().undoAll();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ ok: 2, failed: 0 });
    // LIFO: discard on 'y' was pushed last, undoes first with mode='restore'.
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'apply_hunk', expect.objectContaining({
      mode: 'restore', filePath: 'y',
    }));
    // stage on 'x' undoes with mode='unstage'.
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'apply_hunk', expect.objectContaining({
      mode: 'unstage', filePath: 'x',
    }));
    expect(useHunkUndoStore.getState().stack.length).toBe(0);
  });

  it('undoAll reports partial failure without throwing', async () => {
    invokeMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce('context mismatch');
    useHunkUndoStore.getState().push(action({ filePath: 'a' }));
    useHunkUndoStore.getState().push(action({ filePath: 'b' }));

    const promise = useHunkUndoStore.getState().undoAll();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ ok: 1, failed: 1 });
  });

  it('clear cancels the timer', () => {
    useHunkUndoStore.getState().push(action());
    useHunkUndoStore.getState().clear();
    expect(useHunkUndoStore.getState().stack.length).toBe(0);
    vi.advanceTimersByTime(10000);
    expect(useHunkUndoStore.getState().stack.length).toBe(0);
  });
});
