import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InlineDiffView } from './InlineDiffView';
import { useHunkUndoStore } from '../store/hunkUndoStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../lib/errorReporter', () => ({ reportInvokeFailure: vi.fn() }));

const { invoke } = await import('@tauri-apps/api/core');
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

const smallDiff = `@@ -1,3 +1,3 @@
 keep
-old
+new
`;

const largeDiff = (() => {
  const parts = ['@@ -1,50 +1,50 @@'];
  for (let i = 0; i < 25; i++) parts.push(`-line${i}`);
  for (let i = 0; i < 25; i++) parts.push(`+newline${i}`);
  return parts.join('\n') + '\n';
})();

function mockFileDiff(diff: string, flags: Partial<{ is_new_file: boolean; is_deleted_file: boolean; is_binary: boolean }> = {}) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_file_diff' || cmd === 'get_path_file_diff') {
      return {
        file_path: 'a.ts',
        diff_text: diff,
        is_new_file: false,
        is_deleted_file: false,
        is_binary: false,
        ...flags,
      };
    }
    return undefined;
  });
}

describe('InlineDiffView hunk actions', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useHunkUndoStore.getState().clear();
  });

  it('renders checkmark and X buttons for a text hunk on unstaged view', async () => {
    mockFileDiff(smallDiff);
    render(<InlineDiffView repoPath="/r" filePath="a.ts" terminalId="t1" />);
    expect(await screen.findByRole('button', { name: /Stage hunk/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Discard hunk/i })).toBeInTheDocument();
  });

  it('suppresses buttons for binary file', async () => {
    mockFileDiff('', { is_binary: true });
    render(<InlineDiffView repoPath="/r" filePath="img.png" terminalId="t1" />);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Stage hunk/i })).toBeNull();
    });
  });

  it('suppresses buttons for new file', async () => {
    mockFileDiff(smallDiff, { is_new_file: true });
    render(<InlineDiffView repoPath="/r" filePath="a.ts" terminalId="t1" />);
    await waitFor(() => {
      // Content should render but buttons should not appear.
      expect(screen.queryByText(/keep/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Stage hunk/i })).toBeNull();
    });
  });

  it('clicking stage button calls apply_hunk with mode stage and pushes to undo store', async () => {
    mockFileDiff(smallDiff);
    render(<InlineDiffView repoPath="/r" filePath="a.ts" terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Stage hunk/i }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('apply_hunk', expect.objectContaining({
        mode: 'stage', repoPath: '/r', filePath: 'a.ts',
      }));
    });
    expect(useHunkUndoStore.getState().stack.length).toBe(1);
    expect(useHunkUndoStore.getState().stack[0].kind).toBe('stage');
  });

  it('clicking discard button on small hunk immediately fires discard', async () => {
    mockFileDiff(smallDiff);
    render(<InlineDiffView repoPath="/r" filePath="a.ts" terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Discard hunk/i }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('apply_hunk', expect.objectContaining({ mode: 'discard' }));
    });
  });

  it('clicking discard button on large hunk shows inline confirm bar', async () => {
    mockFileDiff(largeDiff);
    render(<InlineDiffView repoPath="/r" filePath="b.ts" terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Discard hunk/i }));
    expect(screen.getByText(/Really discard 50 lines/)).toBeInTheDocument();
    // Only initial get_file_diff should have been invoked, no apply_hunk yet.
    const applyCalls = invokeMock.mock.calls.filter(([c]) => c === 'apply_hunk');
    expect(applyCalls).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: /^Discard$/ }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('apply_hunk', expect.objectContaining({ mode: 'discard' }));
    });
  });

  it('confirm bar Cancel returns to buttons without firing', async () => {
    mockFileDiff(largeDiff);
    render(<InlineDiffView repoPath="/r" filePath="b.ts" terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Discard hunk/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    // Confirm bar dismissed, buttons reappear.
    expect(await screen.findByRole('button', { name: /Discard hunk/i })).toBeInTheDocument();
    const applyCalls = invokeMock.mock.calls.filter(([c]) => c === 'apply_hunk');
    expect(applyCalls).toEqual([]);
  });
});
