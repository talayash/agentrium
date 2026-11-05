import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAWER_CLOSE_DELAY_MS, DRAWER_POLL_MS, useTerminalDrawer } from './useTerminalDrawer';
import { useSessionAttentionStore } from '../store/sessionAttentionStore';

const mocks = vi.hoisted(() => ({
  lines: [] as string[],
  active: 'other',
  terminals: new Map<string, unknown>(),
  states: new Map<string, string>(),
}));
vi.mock('../store/terminalStore', () => ({ useTerminalStore: { getState: () => ({
  terminals: mocks.terminals, terminalStates: mocks.states, activeTerminalId: mocks.active,
}) } }));

const PERMISSION = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don’t ask again for: node sizes.js', '   3. No', ' Esc to cancel · Tab to amend'];
const CALM = ['working on it', ''];
const tick = (ms = DRAWER_POLL_MS) => act(() => { vi.advanceTimersByTime(ms); });

describe('useTerminalDrawer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    useSessionAttentionStore.setState({ pending: new Set(), acknowledged: new Set() });
    mocks.lines = CALM;
    mocks.active = 'other';
    mocks.states.clear();
    mocks.terminals.clear();
    mocks.terminals.set('t1', { xterm: { buffer: { active: {
      get length() { return mocks.lines.length; },
      getLine: (i: number) => ({ translateToString: () => mocks.lines[i] }),
    } } } });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('opens for the permission prompt regardless of session state', () => {
    mocks.states.set('t1', 'busy');
    const { result } = renderHook(() => useTerminalDrawer('t1', true, false));
    expect(result.current.open).toBe(false);
    mocks.lines = PERMISSION;
    tick();
    expect(result.current.open).toBe(true);
    expect(result.current.openedBy).toBe('auto');
  });

  it('closes 1 s after the prompt disappears', () => {
    const { result } = renderHook(() => useTerminalDrawer('t1', true, false));
    mocks.lines = PERMISSION;
    tick();
    mocks.lines = CALM;
    tick();
    expect(result.current.open).toBe(true);
    tick(DRAWER_CLOSE_DELAY_MS);
    expect(result.current.open).toBe(false);
    expect(result.current.openedBy).toBeNull();
  });

  it('keeps the drawer open if the prompt returns before the delay', () => {
    const { result } = renderHook(() => useTerminalDrawer('t1', true, false));
    mocks.lines = PERMISSION;
    tick();
    mocks.lines = CALM;
    tick();
    mocks.lines = PERMISSION;
    tick();
    mocks.lines = CALM;
    tick();
    expect(result.current.open).toBe(true);
  });

  it('user-opened drawer stays open', () => {
    const { result } = renderHook(() => useTerminalDrawer('t1', true, false));
    act(() => result.current.openByUser());
    expect(result.current.openedBy).toBe('user');
    tick(DRAWER_CLOSE_DELAY_MS * 3);
    expect(result.current.open).toBe(true);
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
  });

  it('requests attention once per opening for a background terminal', () => {
    const { result } = renderHook(() => useTerminalDrawer('t1', true, false));
    mocks.lines = PERMISSION;
    tick();
    tick();
    expect(useSessionAttentionStore.getState().pending.has('t1')).toBe(true);
    const request = vi.spyOn(useSessionAttentionStore.getState(), 'request');
    useSessionAttentionStore.setState({ pending: new Set(), acknowledged: new Set() });
    tick();
    expect(request).not.toHaveBeenCalled();
    expect(useSessionAttentionStore.getState().pending.size).toBe(0);
    mocks.lines = CALM;
    tick(DRAWER_CLOSE_DELAY_MS + DRAWER_POLL_MS);
    expect(result.current.open).toBe(false);
    mocks.lines = PERMISSION;
    tick();
    expect(useSessionAttentionStore.getState().pending.has('t1')).toBe(true);
  });

  it('does not request attention for the active terminal', () => {
    mocks.active = 't1';
    renderHook(() => useTerminalDrawer('t1', true, false));
    mocks.lines = PERMISSION;
    tick();
    expect(useSessionAttentionStore.getState().pending.size).toBe(0);
  });

  it('does nothing when disabled', () => {
    const { result } = renderHook(() => useTerminalDrawer('t1', false, false));
    mocks.lines = PERMISSION;
    tick(DRAWER_POLL_MS * 4);
    expect(result.current.open).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes and stops polling when disabled mid-way', () => {
    const { result, rerender } = renderHook(({ e }) => useTerminalDrawer('t1', e, false), { initialProps: { e: true } });
    mocks.lines = PERMISSION;
    tick();
    expect(result.current.open).toBe(true);
    rerender({ e: false });
    expect(result.current.open).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
