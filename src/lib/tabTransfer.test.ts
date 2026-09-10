import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDetachedWindow, installTransferReceiver, requestTransfer, routeTabDrop } from './tabTransfer';
import type { TerminalConfig } from '../store/terminalStore';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), emit: vi.fn(), listen: vi.fn(), windows: vi.fn(),
  detach: vi.fn(), focus: vi.fn(), create: vi.fn(), close: vi.fn(), once: vi.fn(),
  handlers: new Map<string, Set<(e: any) => unknown>>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ emit: mocks.emit, listen: mocks.listen }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getAllWebviewWindows: mocks.windows,
  getCurrentWebviewWindow: () => ({ label: 'main', setFocus: mocks.focus }),
  WebviewWindow: class {
    constructor(...args: unknown[]) { mocks.create(...args); }
    once = mocks.once; close = mocks.close;
    setPosition = vi.fn().mockResolvedValue(undefined);
    setSize = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('../store/terminalStore', () => ({ useTerminalStore: { getState: () => ({ detachTerminals: mocks.detach }) } }));
vi.mock('./errorReporter', () => ({ reportError: vi.fn() }));
const transfer = 'ct://tab-transfer';
const done = 'ct://tab-transfer-done';
const ready = 'ct://tab-transfer-ready';
const config = { id: 'one', label: 'One' } as TerminalConfig;
const dispatch = async (name: string, payload: unknown) => {
  for (const fn of [...(mocks.handlers.get(name) ?? [])]) await fn({ payload });
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const request = () => mocks.emit.mock.calls.find(([name]) => name === transfer)![1];
const payload = () => ({ ids: ['one'], targetLabel: 'target', sourceLabel: 'main', requestId: 'r1', expiresAt: Date.now() + 15000 });
const windowAt = (label: string) => ({ label, outerPosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }), outerSize: vi.fn().mockResolvedValue({ width: 100, height: 100 }) });

beforeEach(() => {
  vi.resetAllMocks(); mocks.handlers.clear();
  mocks.invoke.mockResolvedValue([50, 50]);
  mocks.windows.mockResolvedValue([]);
  mocks.focus.mockResolvedValue(undefined); mocks.close.mockResolvedValue(undefined);
  mocks.once.mockResolvedValue(() => {});
  mocks.listen.mockImplementation(async (name, fn) => {
    if (!mocks.handlers.has(name)) mocks.handlers.set(name, new Set());
    mocks.handlers.get(name)!.add(fn);
    return () => mocks.handlers.get(name)?.delete(fn);
  });
  mocks.emit.mockImplementation(dispatch);
});
afterEach(() => vi.useRealTimers());

describe('acknowledged tab transfers', () => {
  it('does no work for empty selections', async () => {
    await routeTabDrop([], 'main'); await requestTransfer('target', [], 'main');
    expect(mocks.emit).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('retains source tabs until matching destination acknowledgement', async () => {
    mocks.windows.mockResolvedValue([windowAt('main'), windowAt('drag-preview'), windowAt('target')]);
    const pending = routeTabDrop(['one'], 'main');
    await flush();
    expect(mocks.detach).not.toHaveBeenCalled();
    await dispatch(done, { ids: ['one'], byLabel: 'other', requestId: request().requestId });
    expect(mocks.detach).not.toHaveBeenCalled();
    await dispatch(done, { ids: ['one'], byLabel: 'target', requestId: request().requestId });
    await pending;
    expect(mocks.detach).toHaveBeenCalledWith(['one']);
    expect(mocks.handlers.get(done)?.size).toBe(0);
  });
  it('retains source tabs on timeout and ignores late acknowledgements', async () => {
    vi.useFakeTimers();
    const pending = requestTransfer('target', ['one'], 'main');
    const failed = expect(pending).rejects.toThrow('timed out');
    await flush();
    await vi.advanceTimersByTimeAsync(15000);
    await failed;
    await dispatch(done, { ids: ['one'], byLabel: 'target', requestId: request().requestId });
    expect(mocks.detach).not.toHaveBeenCalled();
    expect(mocks.handlers.get(done)?.size).toBe(0);
  });
  it('retains source tabs when sending fails', async () => {
    mocks.emit.mockRejectedValue(new Error('event failed'));
    await expect(requestTransfer('target', ['one'], 'main')).rejects.toThrow('event failed');
    expect(mocks.detach).not.toHaveBeenCalled();
    expect(mocks.handlers.get(done)?.size).toBe(0);
  });
  it('retains source tabs when destination rejects adoption', async () => {
    const pending = requestTransfer('target', ['one'], 'main');
    const failed = expect(pending).rejects.toThrow('backend unavailable');
    await flush();
    await dispatch(done, { ids: [], byLabel: 'target', requestId: request().requestId, error: 'backend unavailable' });
    await failed; expect(mocks.detach).not.toHaveBeenCalled();
  });
  it('waits for a new window receiver before requesting adoption', async () => {
    const pending = createDetachedWindow(['one'], 50, 50);
    await flush();
    expect(mocks.emit).not.toHaveBeenCalledWith(transfer, expect.anything());
    const label = mocks.create.mock.calls[0][0];
    expect(mocks.create.mock.calls[0][1].url).toBe('index.html?mode=detached');
    await dispatch(ready, { label }); await flush();
    expect(mocks.detach).not.toHaveBeenCalled();
    await dispatch(done, { ids: ['one'], byLabel: label, requestId: request().requestId });
    await pending; expect(mocks.detach).toHaveBeenCalledWith(['one']);
  });
  it('keeps source tabs when window creation fails', async () => {
    const pending = createDetachedWindow(['one'], 50, 50);
    const failed = expect(pending).rejects.toThrow('Window creation failed');
    await flush();
    mocks.once.mock.calls[0][1]({ payload: 'unavailable' });
    await failed; expect(mocks.detach).not.toHaveBeenCalled(); expect(mocks.close).toHaveBeenCalledOnce();
  });
});

describe('transfer receiver', () => {
  it('announces readiness after registration and acknowledges adopted IDs', async () => {
    mocks.invoke.mockResolvedValueOnce([config]).mockResolvedValueOnce('saved output');
    const adopt = vi.fn(); const dispose = installTransferReceiver('target', adopt, vi.fn());
    await flush(); expect(mocks.emit).toHaveBeenCalledWith(ready, { label: 'target' });
    await dispatch(transfer, payload());
    expect(adopt).toHaveBeenCalledWith(config, 'saved output');
    expect(mocks.emit).toHaveBeenCalledWith(done, { ids: ['one'], byLabel: 'target', requestId: 'r1' });
    dispose(); expect(mocks.handlers.get(transfer)?.size).toBe(0);
  });
  it('rejects missing IDs without partially adopting the selection', async () => {
    mocks.invoke.mockResolvedValue([config]);
    const adopt = vi.fn(); const dispose = installTransferReceiver('target', adopt, vi.fn());
    await flush();
    await dispatch(transfer, { ...payload(), ids: ['one', 'missing'] });
    expect(adopt).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledWith(done, expect.objectContaining({ ids: [], error: expect.any(String) }));
    dispose();
  });
  it('does not adopt after the source request has expired', async () => {
    mocks.invoke.mockResolvedValue([config]);
    const adopt = vi.fn(); const dispose = installTransferReceiver('target', adopt, vi.fn());
    await flush();
    await dispatch(transfer, { ...payload(), expiresAt: Date.now() - 1 });
    expect(adopt).not.toHaveBeenCalled(); dispose();
  });
  it('rolls back destination views if acknowledgement fails', async () => {
    mocks.invoke.mockResolvedValueOnce([config]).mockResolvedValueOnce(null);
    const detach = vi.fn(); const dispose = installTransferReceiver('target', vi.fn(), detach);
    await flush();
    mocks.emit.mockImplementation(async (event) => { if (event === done) throw new Error('IPC failed'); });
    await dispatch(transfer, payload());
    expect(detach).toHaveBeenCalledWith(['one']); dispose();
  });
  it('rolls back a destination after late source cancellation', async () => {
    mocks.invoke.mockResolvedValueOnce([config]).mockResolvedValueOnce(null);
    const detach = vi.fn(); const dispose = installTransferReceiver('target', vi.fn(), detach);
    await flush();
    await dispatch(transfer, payload());
    await dispatch('ct://tab-transfer-cancel', { targetLabel: 'target', requestId: 'r1' });
    expect(detach).toHaveBeenCalledWith(['one']); dispose();
  });
  it('cleans up registration that resolves after disposal', async () => {
    let resolve!: (fn: () => void) => void;
    mocks.listen.mockImplementation(() => new Promise(r => { resolve = r; }));
    const dispose = installTransferReceiver('target', vi.fn(), vi.fn()); dispose();
    const unlisten = vi.fn(); resolve(unlisten); await flush();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
