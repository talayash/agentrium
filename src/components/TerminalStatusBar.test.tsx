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
  it('no longer shows the insight toggle (it lives in the session header)', () => {
    seed(makeConfig('a', { view_mode: 'cli' }));
    render(<TerminalStatusBar terminalId="a" />);
    expect(screen.queryByRole('button', { name: 'Insight layer' })).toBeNull();
  });
});

describe('TerminalStatusBar restart', () => {
  it('keeps the view mode when restarting', async () => {
    const closeTerminal = vi.fn(async () => undefined);
    const createTerminal = vi.fn(async () => 'new');
    seed(makeConfig('r', { view_mode: 'mixed' }));
    useTerminalStore.setState({ closeTerminal, createTerminal } as never);
    const { container } = render(<TerminalStatusBar terminalId="r" />);
    const btn = container.querySelector('svg.lucide-rotate-cw')!.closest('button')!;
    await act(async () => { fireEvent.click(btn); });
    expect(closeTerminal).toHaveBeenCalledWith('r');
    expect(createTerminal).toHaveBeenCalledTimes(1);
    const args = createTerminal.mock.calls[0] as unknown[];
    expect(args[10]).toBe('claude');
    expect(args[13]).toEqual({ viewMode: 'mixed' });
  });
});
