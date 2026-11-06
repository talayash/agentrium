import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
import { ContextBar, ContextMeter } from './ContextMeter';
import { useAppStore } from '../store/appStore';
import { useContextUsageStore } from '../store/contextUsageStore';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';

const config: TerminalConfig = {
  id: 's1', label: 'Sync fix', nickname: null, profile_id: null, working_directory: '/src/app', claude_args: [],
  env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'claude', credential_bindings: [],
};
const writeToTerminal = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  writeToTerminal.mockClear();
  useTerminalStore.setState({
    terminals: new Map([['s1', { config, xterm: null, isWorktree: false }]]),
    activeTerminalId: 's1',
    writeToTerminal,
  });
  useAppStore.setState({ contextMeterEnabled: true });
  useContextUsageStore.setState({
    byId: new Map([['s1', { used_tokens: 124_000, window_tokens: null, model: 'claude-opus-4-1' }]]),
  });
});
afterEach(cleanup);

it('shows the fill and opens the breakdown', () => {
  render(<ContextMeter terminalId="s1" />);
  const chip = screen.getByRole('button', { name: 'Context window 62% full' });
  expect(chip.getAttribute('data-context-meter')).toBe('ok');
  fireEvent.click(chip);
  expect(screen.getByRole('dialog', { name: 'Context window' }).textContent).toContain('124k of 200k tokens');
});

it('types /compact without pressing Enter', () => {
  render(<ContextMeter terminalId="s1" />);
  fireEvent.click(screen.getByRole('button', { name: /Context window/ }));
  fireEvent.click(screen.getByRole('button', { name: /Type \/compact/ }));
  expect(writeToTerminal).toHaveBeenCalledWith('s1', '/compact');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('turns red at 90% and marks the sidebar bar', () => {
  useContextUsageStore.setState({ byId: new Map([['s1', { used_tokens: 185_000, window_tokens: null, model: null }]]) });
  const { container } = render(<><ContextMeter terminalId="s1" /><ContextBar terminalId="s1" /></>);
  expect(screen.getByRole('button', { name: 'Context window 93% full' }).getAttribute('data-context-meter')).toBe('crit');
  expect(container.querySelector('[data-context-bar="crit"]')).not.toBeNull();
});

it('renders nothing when the setting is off or there is no data', () => {
  useAppStore.setState({ contextMeterEnabled: false });
  const { container, rerender } = render(<><ContextMeter terminalId="s1" /><ContextBar terminalId="s1" /></>);
  expect(container.innerHTML).toBe('');
  useAppStore.setState({ contextMeterEnabled: true });
  useContextUsageStore.setState({ byId: new Map() });
  rerender(<><ContextMeter terminalId="s1" /><ContextBar terminalId="s1" /></>);
  expect(container.innerHTML).toBe('');
});

it('stays hidden for agents with no known window', () => {
  useTerminalStore.setState({
    terminals: new Map([['s1', { config: { ...config, agent: 'cursor' }, xterm: null, isWorktree: false }]]),
  });
  const { container } = render(<ContextMeter terminalId="s1" />);
  expect(container.innerHTML).toBe('');
});
