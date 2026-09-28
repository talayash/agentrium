import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
import { AttentionInbox } from './AttentionInbox';
import { useAttentionStore } from '../store/attentionStore';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';

beforeEach(() => {
  useTerminalStore.setState({ terminals: new Map([['target', { xterm: null, isWorktree: false, config: {
    id: 'target', label: 'Fix login', nickname: null, profile_id: null, working_directory: '/project',
    claude_args: [], env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'codex',
  } }]]), activeTerminalId: null });
  useAttentionStore.setState({ items: [] });
  useAppStore.setState({ gridMode: true, splitMode: true });
});
afterEach(cleanup);

it('opens the relevant session even when it is outside the visible grid and acknowledges the item', () => {
  useAttentionStore.getState().put({ terminalId: 'target', targetId: 'target', kind: 'input', title: 'Fix login', detail: 'Waiting for input' });
  render(<AttentionInbox />);
  fireEvent.click(screen.getByRole('button', { name: 'Open Fix login: Needs input' }));
  expect(useTerminalStore.getState().activeTerminalId).toBe('target');
  expect(useAppStore.getState().gridMode).toBe(false);
  expect(useAppStore.getState().splitMode).toBe(false);
  expect(screen.getByText('Nothing needs attention')).toBeTruthy();
});

it('dismisses without switching sessions', () => {
  useAttentionStore.getState().put({ terminalId: 'target', targetId: 'target', kind: 'review', title: 'Fix login', detail: 'Review output' });
  render(<AttentionInbox />);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss Fix login' }));
  expect(useTerminalStore.getState().activeTerminalId).toBeNull();
  expect(useAttentionStore.getState().items).toEqual([]);
});
