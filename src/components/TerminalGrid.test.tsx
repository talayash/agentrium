import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('./TerminalView', () => ({ TerminalView: () => null }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue([]) }));

import { TerminalGrid } from './TerminalGrid';
import { useAppStore } from '../store/appStore';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';

function makeConfig(id: string): TerminalConfig {
  return {
    id,
    label: id,
    nickname: null,
    profile_id: null,
    working_directory: `C:/repos/${id}`,
    claude_args: [],
    env_vars: {},
    created_at: '2026-01-01T00:00:00Z',
    status: 'Running',
    color_tag: null,
    agent: 'claude',
  };
}

function seedGrid(ids: string[], activeTerminalId: string | null, gridFocusedIndex: number | null) {
  useTerminalStore.setState({
    terminals: new Map(ids.map((id) => [id, { config: makeConfig(id), xterm: null, isWorktree: false }])),
    activeTerminalId,
    unreadTerminalIds: new Set(ids),
  });
  useAppStore.setState({
    gridMode: true,
    gridTerminalIds: ids,
    gridLayout: '1x2',
    gridFocusedIndex,
    pinnedTabIds: [],
  });
}

beforeEach(() => {
  seedGrid(['alpha', 'beta'], 'alpha', null);
});
afterEach(cleanup);

/**
 * The Inspector's Changes panel (and the file tree, and the title-bar git
 * chip) all read terminalStore.activeTerminalId. Grid panes used to track
 * focus only in appStore.gridFocusedIndex, so moving between panes left every
 * context panel pinned to whichever tab was last clicked - issue #71.
 */
describe('grid focus drives the active terminal', () => {
  it('makes a clicked pane the active terminal', () => {
    render(<TerminalGrid />);

    fireEvent.click(screen.getByText('beta'));

    expect(useTerminalStore.getState().activeTerminalId).toBe('beta');
    expect(useAppStore.getState().gridFocusedIndex).toBe(1);
  });

  it('follows Alt+Arrow pane navigation', () => {
    render(<TerminalGrid />);

    fireEvent.keyDown(window, { key: 'ArrowRight', code: 'ArrowRight', altKey: true });
    expect(useTerminalStore.getState().activeTerminalId).toBe('alpha');

    fireEvent.keyDown(window, { key: 'ArrowRight', code: 'ArrowRight', altKey: true });
    expect(useTerminalStore.getState().activeTerminalId).toBe('beta');
  });

  it('follows Alt+digit jumps', () => {
    render(<TerminalGrid />);

    fireEvent.keyDown(window, { key: '2', code: 'Digit2', altKey: true });

    expect(useTerminalStore.getState().activeTerminalId).toBe('beta');
  });

  it('reconciles a stale focused index when the grid mounts', () => {
    // Focus pane 1, leave grid mode, click tab "alpha", come back: the ring is
    // on beta but the panels were still showing alpha.
    seedGrid(['alpha', 'beta'], 'alpha', 1);

    render(<TerminalGrid />);

    expect(useTerminalStore.getState().activeTerminalId).toBe('beta');
  });

  it('follows the terminal that a swap moves into the focused pane', () => {
    seedGrid(['alpha', 'beta'], 'alpha', 0);
    render(<TerminalGrid />);
    expect(useTerminalStore.getState().activeTerminalId).toBe('alpha');

    act(() => useAppStore.getState().swapGridPositions(0, 1));

    expect(useTerminalStore.getState().activeTerminalId).toBe('beta');
  });

  it('leaves the active terminal alone when no pane is focused', () => {
    render(<TerminalGrid />);

    expect(useTerminalStore.getState().activeTerminalId).toBe('alpha');
  });

  it('does not steal focus back from a terminal appended to the grid', () => {
    // Creating a session from grid view sets it active, then appends it to the
    // grid without moving the ring. The sync must not undo that.
    seedGrid(['alpha', 'beta'], 'alpha', 0);
    const { rerender } = render(<TerminalGrid />);

    act(() => {
      useTerminalStore.setState({ activeTerminalId: 'gamma' });
      useAppStore.setState({ gridTerminalIds: ['alpha', 'beta', 'gamma'] });
    });
    rerender(<TerminalGrid />);

    expect(useTerminalStore.getState().activeTerminalId).toBe('gamma');
  });

  it('clears the unread badge for the pane it focuses', () => {
    render(<TerminalGrid />);

    fireEvent.click(screen.getByText('beta'));

    expect(useTerminalStore.getState().unreadTerminalIds.has('beta')).toBe(false);
  });
});

/**
 * AnimatePresence mode="popLayout" wraps every child in framer-motion's
 * PopChild, which attaches a ref to measure the element before pulling it out
 * of document flow. A plain function component silently swallows that ref, so
 * the measurement never happens and React logs a console error on every grid
 * layout change. ToastContainer already learned this (see ToastCard's
 * forwardRef); the empty grid cell had the same bug.
 */
describe('empty grid cells animate without React warnings', () => {
  it('renders empty panes with no ref warning', () => {
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args);
    });

    try {
      // 2x2 holds four panes; two terminals leaves two empty cells.
      useAppStore.setState({ gridLayout: '2x2' });
      render(<TerminalGrid />);
    } finally {
      spy.mockRestore();
    }

    const refWarnings = errors.filter((args) =>
      args.some((a) => typeof a === 'string' && a.includes('Function components cannot be given refs'))
    );
    expect(refWarnings).toEqual([]);
  });
});
