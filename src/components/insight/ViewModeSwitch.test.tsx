import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const invokeMock = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import { ViewModeSwitch } from './ViewModeSwitch';
import { useTerminalStore, type TerminalConfig } from '../../store/terminalStore';

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

describe('ViewModeSwitch', () => {
  it('renders three segments with the current one checked', () => {
    seed(makeConfig('a', { view_mode: 'mixed' }));
    render(<ViewModeSwitch terminalId="a" />);
    expect(screen.getByRole('radiogroup', { name: 'View mode' })).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'Mixed' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'CLI' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('radio', { name: 'Insight' }).getAttribute('aria-checked')).toBe('false');
  });

  it("click Insight calls setViewMode('insight')", async () => {
    seed(makeConfig('a', { view_mode: 'cli' }));
    render(<ViewModeSwitch terminalId="a" />);
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Insight' })); });
    expect(invokeMock).toHaveBeenCalledWith('set_terminal_view_mode', { id: 'a', mode: 'insight' });
  });

  it('insight segment disabled for cursor', async () => {
    seed(makeConfig('a', { agent: 'cursor', view_mode: 'mixed' }));
    render(<ViewModeSwitch terminalId="a" />);
    const seg = screen.getByRole('radio', { name: 'Insight' });
    expect(seg.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { fireEvent.click(seg); });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('every segment has an accessible name even when its text is hidden', () => {
    seed(makeConfig('a', { view_mode: 'cli' }));
    render(<ViewModeSwitch terminalId="a" />);
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['CLI', 'Mixed', 'Insight']);
  });

  it('the group tooltip has no hard-coded shortcut text', async () => {
    vi.useFakeTimers();
    try {
      seed(makeConfig('a', { view_mode: 'cli' }));
      render(<ViewModeSwitch terminalId="a" />);
      fireEvent.mouseEnter(screen.getByRole('radiogroup'));
      await act(async () => { vi.advanceTimersByTime(500); });
      expect(screen.getByRole('tooltip').textContent).toBe('View mode');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['codex', 'Insight view is not available for Codex yet'],
    ['cursor', 'No structured data for this agent'],
  ] as const)('disabled Insight segment tooltip for %s', async (agent, text) => {
    vi.useFakeTimers();
    try {
      seed(makeConfig('a', { agent, view_mode: 'mixed' }));
      render(<ViewModeSwitch terminalId="a" />);
      fireEvent.mouseEnter(screen.getByRole('radio', { name: 'Insight' }));
      await act(async () => { vi.advanceTimersByTime(500); });
      expect(screen.getAllByRole('tooltip').map((t) => t.textContent)).toContain(text);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the effective mode when the stored one is unavailable', () => {
    seed(makeConfig('a', { agent: 'cursor', view_mode: 'insight' }));
    render(<ViewModeSwitch terminalId="a" />);
    expect(screen.getByRole('radio', { name: 'Mixed' }).getAttribute('aria-checked')).toBe('true');
  });

  it('hidden for shell terminals', () => {
    seed(makeConfig('s'), { isShellTerminal: true });
    render(<ViewModeSwitch terminalId="s" />);
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });
});
