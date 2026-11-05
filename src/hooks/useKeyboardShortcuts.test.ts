import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';

const setViewMode = vi.fn(async () => undefined);

function seed(agent: string, view_mode?: string, extra: Record<string, unknown> = {}) {
  const config = { id: 'a', agent, view_mode } as unknown as TerminalConfig;
  useTerminalStore.setState({
    terminals: new Map([['a', { config, xterm: null, isWorktree: false, ...extra }]]) as never,
    activeTerminalId: 'a',
    setViewMode,
  } as never);
}

afterEach(() => {
  cleanup();
  setViewMode.mockClear();
});

function press(repeat = false) {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true, repeat, bubbles: true, cancelable: true }),
  );
}

describe('Ctrl+Shift+L', () => {
  it('cycles cli -> mixed -> insight -> cli', () => {
    renderHook(() => useKeyboardShortcuts());
    seed('claude', 'cli');
    press();
    expect(setViewMode).toHaveBeenLastCalledWith('a', 'mixed');
    seed('claude', 'mixed');
    press();
    expect(setViewMode).toHaveBeenLastCalledWith('a', 'insight');
    seed('claude', 'insight');
    press();
    expect(setViewMode).toHaveBeenLastCalledWith('a', 'cli');
  });

  it('cycle skips insight for cursor', () => {
    renderHook(() => useKeyboardShortcuts());
    seed('cursor', 'mixed');
    press();
    expect(setViewMode).toHaveBeenLastCalledWith('a', 'cli');
  });

  it('does nothing for shell terminals', () => {
    renderHook(() => useKeyboardShortcuts());
    seed('claude', 'cli', { isShellTerminal: true });
    press();
    expect(setViewMode).not.toHaveBeenCalled();
  });

  it('ignores key repeat', () => {
    renderHook(() => useKeyboardShortcuts());
    seed('claude', 'cli');
    press(false);
    press(true);
    press(true);
    expect(setViewMode).toHaveBeenCalledTimes(1);
  });
});
