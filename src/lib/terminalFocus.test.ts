import { beforeEach, describe, expect, it, vi } from 'vitest';
import { focusTerminalInput, inputGoesToPromptBar, promptBarFor, registerPromptBar } from './terminalFocus';
import { useInsightStore } from '../store/insightStore';
import { useTerminalStore } from '../store/terminalStore';

const ID = 't1';
const xtermFocus = vi.fn();

function seed(viewMode: 'cli' | 'mixed' | 'insight', drawerOpen = false, agent = 'claude') {
  useTerminalStore.setState({
    terminals: new Map([[ID, { xterm: { focus: xtermFocus }, config: { view_mode: viewMode, agent } } as never]]),
  });
  useInsightStore.setState({ byId: new Map([[ID, { records: [], drawerOpen } as never]]) });
}

beforeEach(() => xtermFocus.mockReset());

describe('focusTerminalInput', () => {
  it('focuses the xterm for cli and mixed sessions', () => {
    const bar = { focus: vi.fn(), insertText: vi.fn() };
    const off = registerPromptBar(ID, bar);
    for (const mode of ['cli', 'mixed'] as const) {
      seed(mode);
      xtermFocus.mockReset();
      expect(inputGoesToPromptBar(ID)).toBe(false);
      focusTerminalInput(ID);
      expect(xtermFocus).toHaveBeenCalledTimes(1);
    }
    expect(bar.focus).not.toHaveBeenCalled();
    off();
  });

  it('focuses the prompt bar, never the xterm, in insight mode with the drawer closed', () => {
    seed('insight');
    const bar = { focus: vi.fn(), insertText: vi.fn() };
    const off = registerPromptBar(ID, bar);
    expect(inputGoesToPromptBar(ID)).toBe(true);
    focusTerminalInput(ID);
    expect(bar.focus).toHaveBeenCalledTimes(1);
    expect(xtermFocus).not.toHaveBeenCalled();
    off();
  });

  it('does nothing in insight mode when no bar is mounted yet', () => {
    seed('insight');
    focusTerminalInput(ID);
    expect(xtermFocus).not.toHaveBeenCalled();
  });

  it('focuses the xterm in insight mode while the drawer is open', () => {
    seed('insight', true);
    const bar = { focus: vi.fn(), insertText: vi.fn() };
    const off = registerPromptBar(ID, bar);
    expect(inputGoesToPromptBar(ID)).toBe(false);
    focusTerminalInput(ID);
    expect(xtermFocus).toHaveBeenCalledTimes(1);
    expect(bar.focus).not.toHaveBeenCalled();
    off();
  });

  it('uses the effective mode: an agent without insight support falls back to the xterm', () => {
    seed('insight', false, 'cursor');
    expect(inputGoesToPromptBar(ID)).toBe(false);
  });

  it('unregister only removes its own handle', () => {
    const a = { focus: vi.fn(), insertText: vi.fn() };
    const b = { focus: vi.fn(), insertText: vi.fn() };
    const offA = registerPromptBar(ID, a);
    const offB = registerPromptBar(ID, b);
    offA();
    expect(promptBarFor(ID)).toBe(b);
    offB();
    expect(promptBarFor(ID)).toBeUndefined();
  });
});
