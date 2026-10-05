import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStateDetection } from './useSessionStateDetection';
import { useSessionAttentionStore } from '../store/sessionAttentionStore';

const mocks = vi.hoisted(() => ({
  notify: vi.fn(), sound: vi.fn(), focused: false, dnd: false,
  lastOutput: vi.fn(), submission: vi.fn(), classify: vi.fn(), setState: vi.fn(),
  terminals: new Map<string, unknown>(), states: new Map<string, string>(),
  app: { dndEnabled: false, dndStart: '22:00', dndEnd: '08:00', notificationSoundEnabled: true, notificationSoundRepeat: false },
}));
vi.mock('../store/terminalStore', () => ({ useTerminalStore: { getState: () => ({
  terminals: mocks.terminals, terminalStates: mocks.states, activeTerminalId: 'one', setTerminalState: mocks.setState,
}) } }));
vi.mock('../store/appStore', () => ({ useAppStore: { getState: () => mocks.app } }));
vi.mock('../lib/terminalActivity', () => ({ getLastOutputAt: mocks.lastOutput, getLastSubmissionAt: mocks.submission }));
vi.mock('../lib/terminalState', async (original) => ({ ...await original<typeof import('../lib/terminalState')>(), classifySettled: mocks.classify }));
vi.mock('../lib/notificationGate', () => ({ isWithinDnd: () => mocks.dnd, playNotificationSound: mocks.sound }));
vi.mock('./useNotification', () => ({ useNotification: () => ({ notify: mocks.notify }) }));
vi.mock('./useWindowFocused', () => ({ useWindowFocused: () => mocks.focused }));

function terminal(overrides = {}) {
  return {
    config: { status: 'Running', nickname: 'Review', label: 'One' },
    xterm: { buffer: { active: { length: 1, getLine: () => ({ translateToString: () => 'Continue?' }) } } },
    ...overrides,
  };
}
const tick = () => act(() => vi.advanceTimersByTime(500));

describe('session state polling and notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    vi.clearAllMocks();
    useSessionAttentionStore.setState({ pending: new Set(), acknowledged: new Set() });
    mocks.terminals.clear();
    mocks.states.clear();
    mocks.focused = false;
    mocks.dnd = false;
    mocks.app.dndEnabled = false;
    mocks.app.notificationSoundEnabled = true;
    mocks.app.notificationSoundRepeat = false;
    mocks.lastOutput.mockReturnValue(undefined);
    mocks.submission.mockReturnValue(undefined);
    mocks.classify.mockReturnValue('waiting');
    mocks.setState.mockImplementation((id: string, state: string) => mocks.states.set(id, state));
    mocks.terminals.set('one', terminal());
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('notifies once per waiting episode and rearms after activity', () => {
    renderHook(useSessionStateDetection);
    tick();
    tick();
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith('Session needs your input', 'Review is waiting for your response.');
    expect(mocks.sound).toHaveBeenCalledOnce();
    mocks.classify.mockReturnValue('busy');
    tick();
    mocks.classify.mockReturnValue('waiting');
    tick();
    expect(mocks.notify).toHaveBeenCalledTimes(2);
  });

  it('treats recent output as busy before classifying the settled buffer', () => {
    mocks.lastOutput.mockReturnValue(10_000);
    renderHook(useSessionStateDetection);
    tick();
    expect(mocks.states.get('one')).toBe('busy');
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
    tick();
    expect(mocks.classify).toHaveBeenCalledWith(['Continue?']);
    expect(mocks.states.get('one')).toBe('waiting');
  });

  it('suppresses notifications for the focused active terminal and reads subsequent focus changes', () => {
    mocks.focused = true;
    const { rerender } = renderHook(useSessionStateDetection);
    tick();
    expect(mocks.notify).not.toHaveBeenCalled();
    mocks.classify.mockReturnValue('idle');
    tick();
    mocks.focused = false;
    rerender();
    mocks.classify.mockReturnValue('waiting');
    tick();
    expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it('respects do-not-disturb while still updating session state', () => {
    mocks.app.dndEnabled = true;
    mocks.dnd = true;
    renderHook(useSessionStateDetection);
    tick();
    expect(mocks.states.get('one')).toBe('waiting');
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.sound).not.toHaveBeenCalled();
  });

  it('supports silent notifications', () => {
    mocks.app.notificationSoundEnabled = false;
    renderHook(useSessionStateDetection);
    tick();
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.sound).not.toHaveBeenCalled();
  });

  it('marks exited sessions stopped and skips shells and script children', () => {
    mocks.terminals.set('one', terminal({ config: { status: 'Stopped' } }));
    mocks.terminals.set('shell', terminal({ isShellTerminal: true }));
    mocks.terminals.set('script', terminal({ scriptParentId: 'one' }));
    renderHook(useSessionStateDetection);
    tick();
    expect(mocks.setState).toHaveBeenCalledExactlyOnceWith('one', 'stopped');
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('preserves known state when the terminal buffer is not mounted', () => {
    mocks.terminals.set('one', terminal({ xterm: null }));
    mocks.states.set('one', 'busy');
    renderHook(useSessionStateDetection);
    tick();
    expect(mocks.states.get('one')).toBe('busy');
    expect(mocks.classify).not.toHaveBeenCalled();
  });

  it('stops polling after unmount', () => {
    const { unmount } = renderHook(useSessionStateDetection);
    unmount();
    tick();
    expect(mocks.setState).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  function readyTerminal(lines = ['Answer completed.', '❯ ']) {
    return terminal({ xterm: { buffer: { active: { length: lines.length, getLine: (i: number) => ({ translateToString: () => lines[i] }) } } } });
  }

  it('alerts on a finished turn, not just a blocking question, and latches until viewed', () => {
    mocks.terminals.set('one', readyTerminal());
    mocks.classify.mockReturnValue('idle');
    mocks.submission.mockReturnValue(9000);
    mocks.lastOutput.mockReturnValue(10000);
    const { rerender } = renderHook(useSessionStateDetection);
    tick();
    expect(useSessionAttentionStore.getState().pending.size).toBe(0);
    act(() => vi.advanceTimersByTime(1000));
    expect(useSessionAttentionStore.getState().pending.has('one')).toBe(true);
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith('Response ready', 'Review has finished. Open the session to review its response.');
    // A footer repaint must not erase the unread completed response.
    mocks.lastOutput.mockImplementation(() => Date.now());
    tick();
    expect(useSessionAttentionStore.getState().pending.has('one')).toBe(true);
    mocks.focused = true;
    rerender();
    tick();
    expect(useSessionAttentionStore.getState().pending.size).toBe(0);
    mocks.focused = false;
    rerender();
    act(() => vi.advanceTimersByTime(5000));
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it('does not alarm for startup, silent work, or an old answer after a new submission', () => {
    mocks.terminals.set('one', readyTerminal());
    mocks.classify.mockReturnValue('idle');
    mocks.lastOutput.mockReturnValue(9000);
    renderHook(useSessionStateDetection);
    tick();
    expect(useSessionAttentionStore.getState().pending.size).toBe(0);
    mocks.submission.mockReturnValue(11000);
    tick();
    expect(useSessionAttentionStore.getState().pending.size).toBe(0);
    mocks.lastOutput.mockReturnValue(12000);
    mocks.terminals.set('one', readyTerminal(['Working… esc to interrupt', '❯ ']));
    act(() => vi.advanceTimersByTime(5000));
    expect(useSessionAttentionStore.getState().pending.size).toBe(0);
  });

  it('recognizes an already-finished turn from its completion footer', () => {
    mocks.terminals.set('one', readyTerminal(['✻ Worked for 32s', '❯ ']));
    mocks.classify.mockReturnValue('idle');
    mocks.lastOutput.mockReturnValue(9000);
    renderHook(useSessionStateDetection);
    tick();
    expect(useSessionAttentionStore.getState().pending.has('one')).toBe(true);
  });

  it('plays one sound per alert when repeat is off', () => {
    mocks.terminals.set('two', terminal());
    renderHook(useSessionStateDetection);
    tick();
    expect(mocks.sound).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(12000));
    expect(mocks.sound).toHaveBeenCalledTimes(1);
    expect(useSessionAttentionStore.getState().pending.size).toBe(2);
  });

  it('repeats one sound for multiple pending sessions and stops after acknowledgement', () => {
    mocks.app.notificationSoundRepeat = true;
    mocks.terminals.set('two', terminal());
    renderHook(useSessionStateDetection);
    tick();
    expect(mocks.sound).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(4000));
    expect(mocks.sound).toHaveBeenCalledTimes(2);
    expect(mocks.notify).toHaveBeenCalledTimes(2);
    useSessionAttentionStore.getState().acknowledge('one');
    useSessionAttentionStore.getState().acknowledge('two');
    act(() => vi.advanceTimersByTime(8000));
    expect(mocks.sound).toHaveBeenCalledTimes(2);
    expect(useSessionAttentionStore.getState().pending.size).toBe(0);
  });

  it('acknowledges on focus and does not resume an alarm when looking away', () => {
    const { rerender } = renderHook(useSessionStateDetection);
    tick();
    expect(useSessionAttentionStore.getState().pending.has('one')).toBe(true);
    mocks.focused = true;
    rerender();
    tick();
    expect(useSessionAttentionStore.getState().pending.size).toBe(0);
    mocks.focused = false;
    rerender();
    act(() => vi.advanceTimersByTime(8000));
    expect(mocks.sound).toHaveBeenCalledTimes(1);
    mocks.classify.mockReturnValue('idle');
    tick();
    mocks.classify.mockReturnValue('waiting');
    tick();
    expect(useSessionAttentionStore.getState().pending.has('one')).toBe(true);
    expect(mocks.sound).toHaveBeenCalledTimes(2);
  });

  it('keeps the visual alert during DND and clears closed sessions', () => {
    mocks.app.dndEnabled = true;
    mocks.dnd = true;
    renderHook(useSessionStateDetection);
    tick();
    expect(useSessionAttentionStore.getState().pending.has('one')).toBe(true);
    act(() => vi.advanceTimersByTime(8000));
    expect(mocks.sound).not.toHaveBeenCalled();
    mocks.terminals.clear();
    tick();
    expect(useSessionAttentionStore.getState().pending.size).toBe(0);
  });
});
