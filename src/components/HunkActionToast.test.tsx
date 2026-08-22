import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { HunkActionToast } from './HunkActionToast';
import { useHunkUndoStore } from '../store/hunkUndoStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));

const push = () => useHunkUndoStore.getState().push({
  kind: 'stage',
  repoPath: '/r',
  filePath: 'a.ts',
  hunkPatch: '@@ -1 +1 @@\n-a\n+b\n',
  atLine: 12,
  timestamp: Date.now(),
});

describe('HunkActionToast', () => {
  beforeEach(() => {
    useHunkUndoStore.getState().clear();
  });

  it('renders nothing when stack is empty', () => {
    render(<HunkActionToast />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows single action label', () => {
    render(<HunkActionToast />);
    act(() => push());
    expect(screen.getByText(/Staged hunk @L12/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Undo/i })).toBeInTheDocument();
  });

  it('shows coalesced label when multiple actions of same kind', () => {
    render(<HunkActionToast />);
    act(() => { push(); push(); push(); });
    expect(screen.getByText(/Staged 3 hunks/)).toBeInTheDocument();
  });

  it('shows mixed label when kinds differ', () => {
    render(<HunkActionToast />);
    act(() => {
      useHunkUndoStore.getState().push({
        kind: 'stage', repoPath: '/r', filePath: 'a', hunkPatch: 'p', atLine: 1, timestamp: 0,
      });
      useHunkUndoStore.getState().push({
        kind: 'discard', repoPath: '/r', filePath: 'b', hunkPatch: 'p', atLine: 2, timestamp: 0,
      });
    });
    expect(screen.getByText(/Actioned 2 hunks/)).toBeInTheDocument();
  });

  it('shows Discarded verb for single discard', () => {
    render(<HunkActionToast />);
    act(() => {
      useHunkUndoStore.getState().push({
        kind: 'discard', repoPath: '/r', filePath: 'a', hunkPatch: 'p', atLine: 5, timestamp: 0,
      });
    });
    expect(screen.getByText(/Discarded hunk @L5/)).toBeInTheDocument();
  });
});
