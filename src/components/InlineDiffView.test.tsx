import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { InlineDiffView } from './InlineDiffView';
import { useReviewStore, commentsFor } from '../store/reviewStore';

const diff = '@@ -40,2 +40,3 @@\n context\n+  const answer = 42;\n tail\n';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ file_path: 'a.ts', diff_text: diff, is_new_file: false, is_deleted_file: false, is_binary: false });
  useReviewStore.setState({ comments: [] });
});
afterEach(() => cleanup());

describe('InlineDiffView review comments', () => {
  it('adds a comment with Ctrl+Enter and renders it under the line', async () => {
    render(<InlineDiffView filePath="a.ts" terminalId="t1" />);
    const btn = await screen.findByLabelText('Comment on line 41');
    fireEvent.click(btn);
    fireEvent.change(screen.getByLabelText('Review comment'), { target: { value: 'use a constant' } });
    fireEvent.keyDown(screen.getByLabelText('Review comment'), { key: 'Enter', ctrlKey: true });
    const [saved] = commentsFor('t1');
    expect(saved).toMatchObject({ filePath: 'a.ts', side: 'new', line: 41, snippet: 'const answer = 42;', body: 'use a constant' });
    expect(screen.getByText('use a constant')).toBeTruthy();
    expect(screen.queryByLabelText('Review comment')).toBeNull();
  });

  it('Esc discards an empty editor', async () => {
    render(<InlineDiffView filePath="a.ts" terminalId="t1" />);
    fireEvent.click(await screen.findByLabelText('Comment on line 41'));
    fireEvent.keyDown(screen.getByLabelText('Review comment'), { key: 'Escape' });
    expect(screen.queryByLabelText('Review comment')).toBeNull();
    expect(commentsFor('t1')).toHaveLength(0);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
  });
});
