import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';

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

  it('cycle skips insight for codex', () => {
    renderHook(() => useKeyboardShortcuts());
    seed('codex', 'mixed');
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

describe('shortcuts from the Insight prompt bar', () => {
  const focusBar = () => {
    const bar = document.createElement('textarea');
    bar.setAttribute('data-terminal-input', '');
    document.body.appendChild(bar);
    bar.focus();
    return bar;
  };

  it('Ctrl+Shift+L fires while the bar has focus', () => {
    renderHook(() => useKeyboardShortcuts());
    seed('claude', 'insight');
    const bar = focusBar();
    press();
    bar.remove();
    expect(setViewMode).toHaveBeenLastCalledWith('a', 'cli');
  });

  it('Ctrl+P fires while the bar has focus', () => {
    const toggleCommandPalette = vi.fn();
    const prev = useAppStore.getState().toggleCommandPalette;
    useAppStore.setState({ toggleCommandPalette });
    renderHook(() => useKeyboardShortcuts());
    const bar = focusBar();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, cancelable: true }));
    bar.remove();
    useAppStore.setState({ toggleCommandPalette: prev });
    expect(toggleCommandPalette).toHaveBeenCalledTimes(1);
  });

  it('a plain text field still keeps Ctrl+P', () => {
    const toggleCommandPalette = vi.fn();
    const prev = useAppStore.getState().toggleCommandPalette;
    useAppStore.setState({ toggleCommandPalette });
    renderHook(() => useKeyboardShortcuts());
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, cancelable: true }));
    input.remove();
    useAppStore.setState({ toggleCommandPalette: prev });
    expect(toggleCommandPalette).not.toHaveBeenCalled();
  });
});
