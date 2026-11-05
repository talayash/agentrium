import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const invokeMock = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import { TerminalStatusBar } from './TerminalStatusBar';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';

function makeConfig(id: string, overrides: Partial<TerminalConfig> = {}): TerminalConfig {
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
    ...overrides,
  };
}

function seed(config: TerminalConfig, extra: Record<string, unknown> = {}) {
  useTerminalStore.setState({
    terminals: new Map([[config.id, { config, xterm: null, isWorktree: false, ...extra }]]),
    activeTerminalId: config.id,
  });
}

beforeEach(() => invokeMock.mockClear());
afterEach(cleanup);

describe('TerminalStatusBar insight toggle', () => {
  it('insight toggle reflects and flips the flag', async () => {
    seed(makeConfig('a', { insight_layer: false }));
    render(<TerminalStatusBar terminalId="a" />);
    const btn = screen.getByRole('button', { name: 'Insight layer' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { fireEvent.click(btn); });
    expect(invokeMock).toHaveBeenCalledWith('set_terminal_insight_layer', { id: 'a', enabled: true });
    expect(screen.getByRole('button', { name: 'Insight layer' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('insight toggle is hidden for shell terminals', () => {
    seed(makeConfig('s', { agent: 'claude' }), { isShellTerminal: true });
    render(<TerminalStatusBar terminalId="s" />);
    expect(screen.queryByRole('button', { name: 'Insight layer' })).toBeNull();
  });

  it('insight toggle is hidden for script children', () => {
    seed(makeConfig('c'), { scriptParentId: 'p' });
    render(<TerminalStatusBar terminalId="c" />);
    expect(screen.queryByRole('button', { name: 'Insight layer' })).toBeNull();
  });
});
