import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const invoke = vi.fn();
const listen = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listen(...a) }));

import { useInsightFeed } from './useInsightFeed';
import { useInsightStore, MAX_RECORDS } from '../store/insightStore';
import type { InsightRecord } from '../lib/insightModel';

type Handler = (e: { payload: { id: string; records: InsightRecord[]; reset: boolean } }) => void;
let handler: Handler;
const unlisten = vi.fn();
const rec = (n: number) => ({ kind: 'user_text', text: `m${n}` }) as unknown as InsightRecord;
const emit = (id: string, records: InsightRecord[], reset = false) => handler({ payload: { id, records, reset } });
const recordsOf = (id: string) => useInsightStore.getState().byId.get(id)?.records ?? [];

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset().mockResolvedValue({ supported: true });
  unlisten.mockReset();
  listen.mockReset().mockImplementation(async (_n: string, h: Handler) => { handler = h; return unlisten; });
  useInsightStore.setState({ byId: new Map() });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('useInsightFeed', () => {
  it('does nothing when disabled', () => {
    renderHook(() => useInsightFeed('t1', false));
    expect(listen).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('starts and stops the tailer', async () => {
    const { unmount } = renderHook(() => useInsightFeed('t1', true));
    await vi.advanceTimersByTimeAsync(0);
    expect(listen).toHaveBeenCalledWith('insight-records', expect.any(Function));
    expect(invoke).toHaveBeenCalledWith('insight_start', { id: 't1' });
    expect(useInsightStore.getState().byId.get('t1')?.supported).toBe(true);
    unmount();
    expect(unlisten).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('insight_stop', { id: 't1' });
  });

  it('throttles flushes to 300 ms', async () => {
    renderHook(() => useInsightFeed('t1', true));
    await vi.advanceTimersByTimeAsync(0);
    let updates = 0;
    const unsub = useInsightStore.subscribe(() => { updates++; });
    emit('t1', [rec(1)]);
    await vi.advanceTimersByTimeAsync(50);
    emit('t1', [rec(2)]);
    await vi.advanceTimersByTimeAsync(50);
    emit('t1', [rec(3)]);
    expect(recordsOf('t1')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(updates).toBe(1);
    expect(recordsOf('t1')).toHaveLength(3);
    unsub();
  });

  it('ignores other terminal ids', async () => {
    renderHook(() => useInsightFeed('t1', true));
    await vi.advanceTimersByTimeAsync(0);
    emit('other', [rec(1)]);
    await vi.advanceTimersByTimeAsync(400);
    expect(recordsOf('t1')).toHaveLength(0);
    expect(useInsightStore.getState().byId.has('other')).toBe(false);
  });

  it('reset replaces records', async () => {
    renderHook(() => useInsightFeed('t1', true));
    await vi.advanceTimersByTimeAsync(0);
    emit('t1', [rec(1), rec(2)]);
    await vi.advanceTimersByTimeAsync(300);
    expect(recordsOf('t1')).toHaveLength(2);
    emit('t1', [rec(3)]);
    emit('t1', [rec(9)], true);
    await vi.advanceTimersByTimeAsync(300);
    expect(recordsOf('t1')).toEqual([rec(9)]);
  });

  it('caps stored records at 5000', async () => {
    renderHook(() => useInsightFeed('t1', true));
    await vi.advanceTimersByTimeAsync(0);
    emit('t1', Array.from({ length: MAX_RECORDS }, (_, i) => rec(i)));
    await vi.advanceTimersByTimeAsync(300);
    emit('t1', [rec(-1), rec(-2)]);
    await vi.advanceTimersByTimeAsync(300);
    const r = recordsOf('t1');
    expect(r).toHaveLength(MAX_RECORDS);
    expect(r[r.length - 1]).toEqual(rec(-2));
    expect(r[0]).toEqual(rec(2));
  });
});
