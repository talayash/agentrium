import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../lib/confirmDialog', () => ({ confirmAction: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { confirmAction } from '../lib/confirmDialog';
import { useMemoryDocument } from './useMemoryDocument';

type File = { path: string };
const A: File = { path: '/mem/a.md' };
const B: File = { path: '/mem/b.md' };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(confirmAction).mockReset();
});

describe('useMemoryDocument', () => {
  it('ignores a slow read that resolves after another file was picked', async () => {
    const slowA = deferred<string>();
    vi.mocked(invoke).mockImplementation(async (_cmd, args) => {
      const path = (args as { path: string }).path;
      return path === A.path ? slowA.promise : 'content of B';
    });
    const { result } = renderHook(() => useMemoryDocument<File>(() => {}));

    let pendingA!: Promise<void>;
    act(() => { pendingA = result.current.select(A); });
    await act(async () => { await result.current.select(B); });
    await act(async () => { slowA.resolve('content of A'); await pendingA; });

    expect(result.current.selected?.path).toBe(B.path);
    expect(result.current.content).toBe('content of B');
    expect(result.current.loading).toBe(false);
  });

  it('saves to the file the text was read from and cannot save after a failed read', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('A text');
    const { result } = renderHook(() => useMemoryDocument<File>(() => {}));
    await act(async () => { await result.current.select(A); });
    act(() => result.current.edit('A text, edited'));
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await act(async () => { await result.current.save(); });
    expect(invoke).toHaveBeenLastCalledWith('write_memory_file', { path: A.path, content: 'A text, edited' });

    vi.mocked(invoke).mockRejectedValueOnce('read denied');
    await act(async () => { await result.current.select(B); });
    act(() => result.current.edit('typed into a file that never loaded'));
    expect(result.current.canSave).toBe(false);
  });

  it('asks before discarding unsaved edits and stays put on cancel', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('A text');
    const { result } = renderHook(() => useMemoryDocument<File>(() => {}));
    await act(async () => { await result.current.select(A); });
    act(() => result.current.edit('unsaved'));

    vi.mocked(confirmAction).mockResolvedValueOnce(false);
    await act(async () => { await result.current.select(B); });

    expect(confirmAction).toHaveBeenCalledWith('Discard unsaved changes in a.md?', { okLabel: 'Discard' });
    expect(result.current.selected?.path).toBe(A.path);
    expect(result.current.content).toBe('unsaved');
  });
});
