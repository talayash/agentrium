import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook, screen } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }));
vi.mock('../PrChip', () => ({ PrChip: () => null }));
vi.mock('../TaskBadge', () => ({ TaskBadge: () => null }));
vi.mock('../CiRepairBadge', () => ({ CiRepairBadge: () => null }));
vi.mock('../ScriptsMenu', () => ({ ScriptsMenu: () => null }));

import { SessionActions, SessionIdentity, useSessionHeaderVisible } from './SessionHeader';
import { useTerminalStore, type TerminalConfig } from '../../store/terminalStore';
import { useAppStore } from '../../store/appStore';

function makeConfig(id: string, overrides: Partial<TerminalConfig> = {}): TerminalConfig {
  return {
    id,
    label: 'Creditly',
    nickname: null,
    profile_id: null,
    working_directory: 'C:/repos/creditly-folder',
    claude_args: [],
    env_vars: {},
    created_at: '2026-01-01T00:00:00Z',
    status: 'Running',
    color_tag: null,
    agent: 'claude',
    ...overrides,
  };
}

beforeEach(() => {
  const config = makeConfig('a');
  useTerminalStore.setState({
    terminals: new Map([['a', { config, xterm: null, isWorktree: false }]]),
    activeTerminalId: 'a',
  });
  useAppStore.setState({ gridMode: false, splitMode: false, splitTerminalIds: null, activeFilePath: null, openFiles: [] });
});
afterEach(cleanup);

describe('merged session header', () => {
  it('is visible for an active session and yields to grid mode', () => {
    const { result, rerender } = renderHook(() => useSessionHeaderVisible());
    expect(result.current).toBe(true);
    useAppStore.setState({ gridMode: true });
    rerender();
    expect(result.current).toBe(false);
  });

  it('is hidden with no active session', () => {
    useTerminalStore.setState({ activeTerminalId: null });
    const { result } = renderHook(() => useSessionHeaderVisible());
    expect(result.current).toBe(false);
  });

  it('shows the session name once and not the folder (the breadcrumb has it)', () => {
    render(<SessionIdentity />);
    expect(screen.getByText('Creditly')).toBeTruthy();
    expect(screen.queryByText('creditly-folder')).toBeNull();
  });

  it('renders a labelled view switch and the close-session anchor', () => {
    const { container } = render(<SessionActions />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['CLI', 'Mixed', 'Insight']);
    expect(radios.map((r) => r.textContent)).toEqual(['CLI', 'Mixed', 'Insight']);
    const close = screen.getByRole('button', { name: 'Close Session' });
    expect(close.hasAttribute('data-close-session-anchor')).toBe(true);
    expect(container.querySelectorAll('[data-close-session-anchor]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-session-divider]')).toHaveLength(1);
  });

  it('hides the actions while a file is focused', () => {
    useAppStore.setState({ activeFilePath: 'x.ts' });
    render(<SessionActions />);
    expect(screen.queryByRole('button', { name: 'Close Session' })).toBeNull();
  });
});
