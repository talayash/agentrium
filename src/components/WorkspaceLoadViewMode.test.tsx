import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('../store/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../lib/errorReporter', () => ({ reportInvokeFailure: vi.fn() }));

import { WorkspaceModal } from './WorkspaceModal';
import { WorkspacesPanel } from './WorkspacesPanel';
import { useTerminalStore } from '../store/terminalStore';

const SAVED = [
  { label: 'a', working_directory: 'C:\\a', claude_args: [], env_vars: {}, agent: 'claude', view_mode: 'insight' },
  { label: 'b', working_directory: 'C:\\b', claude_args: [], env_vars: {}, agent: 'claude', insight_layer: true },
  { label: 'c', working_directory: 'C:\\c', claude_args: [], env_vars: {}, agent: 'claude' },
];

const createTerminal = vi.fn();

beforeEach(() => {
  createTerminal.mockReset().mockResolvedValue('new');
  invoke.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd === 'get_workspaces') return [{ name: 'ws', terminal_count: 3, created_at: '2026-01-01' }];
    if (cmd === 'load_workspace') return SAVED;
    return undefined;
  });
  useTerminalStore.setState({ terminals: new Map(), createTerminal } as never);
});
afterEach(cleanup);

const modes = () => createTerminal.mock.calls.map((c) => (c[13] as { viewMode?: string } | undefined)?.viewMode);

describe('loading a named workspace keeps each saved view mode', () => {
  it('WorkspacesPanel', async () => {
    await act(async () => { render(<WorkspacesPanel />); });
    await act(async () => { fireEvent.click(await screen.findByLabelText('Load workspace ws')); });
    expect(modes()).toEqual(['insight', 'mixed', 'cli']);
  });

  it('WorkspaceModal', async () => {
    await act(async () => { render(<WorkspaceModal />); });
    await act(async () => { fireEvent.click(await screen.findByText('ws')); });
    await act(async () => { fireEvent.click(screen.getByText('Load Workspace')); });
    expect(modes()).toEqual(['insight', 'mixed', 'cli']);
  });
});
