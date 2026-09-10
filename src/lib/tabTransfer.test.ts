import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTransferReceiver, requestTransfer, routeTabDrop } from './tabTransfer';
import type { TerminalConfig } from '../store/terminalStore';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), emit: vi.fn(), listen: vi.fn(), windows: vi.fn(),
  detach: vi.fn(), focus: vi.fn(), create: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ emit: mocks.emit, listen: mocks.listen }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getAllWebviewWindows: mocks.windows,
  getCurrentWebviewWindow: () => ({ setFocus: mocks.focus }),
  WebviewWindow: class { constructor(...args: unknown[]) { mocks.create(...args); } once = vi.fn(); },
}));
vi.mock('../store/terminalStore', () => ({ useTerminalStore: { getState: () => ({ detachTerminals: mocks.detach }) } }));
vi.mock('./errorReporter', () => ({ reportError: vi.fn() }));
import { reportError } from './errorReporter';

const transfer = 'ct://tab-transfer';
const done = 'ct://tab-transfer-done';
const windowAt = (label: string, x = 0) => ({
  label, outerPosition: vi.fn().mockResolvedValue({ x, y: 0 }),
  outerSize: vi.fn().mockResolvedValue({ width: 100, height: 100 }),
});
const config = { id: 'one', label: 'One' } as TerminalConfig;

describe('tab transfer protocol', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.invoke.mockResolvedValue([50, 50]);
    mocks.emit.mockResolvedValue(undefined);
    mocks.focus.mockResolvedValue(undefined);
    mocks.windows.mockResolvedValue([]);
    mocks.listen.mockResolvedValue(vi.fn());
  });

  it('does no desktop work for an empty selection', async () => {
    await routeTabDrop([], 'main');
    await requestTransfer('other', [], 'main');
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('transfers to a hit window while excluding the source and drag overlay', async () => {
    mocks.windows.mockResolvedValue([windowAt('main'), windowAt('drag-preview'), windowAt('target')]);
    await routeTabDrop(['one'], 'main');
    expect(mocks.emit).toHaveBeenCalledWith(transfer, { targetLabel: 'target', ids: ['one'], sourceLabel: 'main' });
    expect(mocks.detach).toHaveBeenCalledWith(['one']);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('skips a window that closes during hit testing', async () => {
    const closed = windowAt('closed');
    closed.outerPosition.mockRejectedValue(new Error('closed'));
    mocks.windows.mockResolvedValue([closed, windowAt('target')]);
    await routeTabDrop(['one'], 'main');
    expect(mocks.emit).toHaveBeenCalledWith(transfer, expect.objectContaining({ targetLabel: 'target' }));
  });

  it('opens a detached view outside other windows without killing the PTY', async () => {
    mocks.windows.mockResolvedValue([windowAt('target', 500)]);
    await routeTabDrop(['one', 'two'], 'main');
    expect(mocks.create).toHaveBeenCalledWith(expect.stringMatching(/^detached-/), expect.objectContaining({
      url: 'index.html?mode=detached&ids=one%2Ctwo',
    }));
    expect(mocks.detach).toHaveBeenCalledWith(['one', 'two']);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps source tabs when the cursor lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.invoke.mockRejectedValue(new Error('cursor unavailable'));
    await routeTabDrop(['one'], 'main');
    expect(mocks.detach).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('keeps source tabs if emitting the handoff fails', async () => {
    mocks.windows.mockResolvedValue([windowAt('target')]);
    mocks.emit.mockRejectedValue(new Error('event failed'));
    await expect(routeTabDrop(['one'], 'main')).rejects.toThrow('event failed');
    expect(mocks.detach).not.toHaveBeenCalled();
  });

  function receive() {
    const adopt = vi.fn();
    const detach = vi.fn();
    const dispose = installTransferReceiver('target', adopt, detach);
    const handler = (name: string) => mocks.listen.mock.calls.find(([event]) => event === name)![1];
    return { adopt, detach, dispose, handler };
  }

  it('ignores transfers for other windows and self-originated requests', async () => {
    const { handler, adopt } = receive();
    await handler(transfer)({ payload: { targetLabel: 'other', sourceLabel: 'main', ids: ['one'] } });
    await handler(transfer)({ payload: { targetLabel: 'target', sourceLabel: 'target', ids: ['one'] } });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
  });

  it('adopts an existing PTY with scrollback before acknowledging and focusing', async () => {
    mocks.invoke.mockResolvedValueOnce([config]).mockResolvedValueOnce('saved output');
    const { handler, adopt } = receive();
    await handler(transfer)({ payload: { targetLabel: 'target', sourceLabel: 'main', ids: ['one'] } });
    expect(adopt).toHaveBeenCalledWith(config, 'saved output');
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'get_session_log', { terminalId: 'one' });
    expect(mocks.emit).toHaveBeenCalledWith(done, { ids: ['one'], byLabel: 'target' });
    expect(adopt.mock.invocationCallOrder[0]).toBeLessThan(mocks.emit.mock.invocationCallOrder[0]);
    expect(mocks.focus).toHaveBeenCalledOnce();
  });

  it('can adopt without scrollback when the session log is unavailable', async () => {
    mocks.invoke.mockResolvedValueOnce([config]).mockRejectedValueOnce(new Error('no log'));
    const { handler, adopt } = receive();
    await handler(transfer)({ payload: { targetLabel: 'target', sourceLabel: 'main', ids: ['one'] } });
    expect(adopt).toHaveBeenCalledWith(config, undefined);
    expect(mocks.emit).toHaveBeenCalledOnce();
  });

  it('reports failed adoption without acknowledging it', async () => {
    mocks.invoke.mockRejectedValue(new Error('backend unavailable'));
    const { handler, adopt } = receive();
    await handler(transfer)({ payload: { targetLabel: 'target', sourceLabel: 'main', ids: ['one'] } });
    expect(adopt).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith('tab_transfer_adopt', 'backend unavailable');
  });

  it('releases tabs adopted elsewhere but retains its own adopted tabs', () => {
    const { handler, detach } = receive();
    handler(done)({ payload: { ids: ['one'], byLabel: 'target' } });
    expect(detach).not.toHaveBeenCalled();
    handler(done)({ payload: { ids: ['one'], byLabel: 'other' } });
    expect(detach).toHaveBeenCalledWith(['one']);
  });

  it('cleans up event registrations even when they resolve after disposal', async () => {
    const resolvers: Array<(fn: () => void) => void> = [];
    mocks.listen.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const { dispose } = receive();
    dispose();
    const unlisteners = [vi.fn(), vi.fn()];
    resolvers.forEach((resolve, i) => resolve(unlisteners[i]));
    await Promise.resolve();
    unlisteners.forEach((fn) => expect(fn).toHaveBeenCalledOnce());
  });
});
