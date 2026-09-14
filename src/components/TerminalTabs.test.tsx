import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const dialog = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: dialog.confirm }));
vi.mock('./FileEditorView', () => ({ FileEditorView: () => null }));
vi.mock('./TerminalView', () => ({ TerminalView: () => null }));
vi.mock('./FileTreePanel', () => ({ FileTreePanel: () => null }));
vi.mock('./SplitView', () => ({ SplitView: () => null }));
vi.mock('./TerminalGrid', () => ({ TerminalGrid: () => null }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue([]) }));
import { TerminalTabs } from './TerminalTabs';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';

beforeEach(() => {
  useTerminalStore.setState({ terminals: new Map(), activeTerminalId: null });
  useAppStore.setState({ gridMode: false, splitMode: false, activeFilePath: 'dirty.ts', openFiles: [{ path: 'dirty.ts', content: 'unsaved', original: 'disk', loading: false, saving: false, error: null, mode: 'edit', headContent: '', repoRoot: null, relativePath: null }] });
});
afterEach(cleanup);

describe('dirty file close controls', () => {
  it.each(['Enter', ' '])('confirms %s and preserves content when cancelled', async (key) => {
    dialog.confirm.mockResolvedValue(false);
    render(<TerminalTabs />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Unsaved changes' }), { key });
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalledOnce());
    expect(useAppStore.getState().openFiles[0].content).toBe('unsaved');
  });
  it('closes with keyboard after discard is confirmed', async () => {
    dialog.confirm.mockResolvedValue(true);
    render(<TerminalTabs />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Unsaved changes' }), { key: 'Enter' });
    await waitFor(() => expect(useAppStore.getState().openFiles).toEqual([]));
  });
});
