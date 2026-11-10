import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
import { ContextBar, ContextMeter } from './ContextMeter';
import { useAppStore } from '../store/appStore';
import { useContextUsageStore } from '../store/contextUsageStore';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';
import type { ContextUsage } from '../lib/contextMeter';

const config: TerminalConfig = {
  id: 's1', label: 'Sync fix', nickname: null, profile_id: null, working_directory: '/src/app', claude_args: [],
  env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'claude', credential_bindings: [],
};
const writeToTerminal = vi.fn().mockResolvedValue(undefined);
const usage = (used: number, model: string | null = null, configured_model: string | null = null): ContextUsage => ({
  used_tokens: used, window_tokens: null, model, configured_model,
});

beforeEach(() => {
  writeToTerminal.mockClear();
  useTerminalStore.setState({
    terminals: new Map([['s1', { config, xterm: null, isWorktree: false }]]),
    activeTerminalId: 's1',
    writeToTerminal,
  });
  useAppStore.setState({ contextMeterEnabled: true, claudeContextWindow: '200k' });
  useContextUsageStore.setState({
    byId: new Map([['s1', usage(124_000, 'claude-opus-4-1')]]),
    seenOver200k: new Set(),
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
  useContextUsageStore.setState({ byId: new Map([['s1', usage(185_000)]]) });
  const { container } = render(<><ContextMeter terminalId="s1" /><ContextBar terminalId="s1" /></>);
  expect(screen.getByRole('button', { name: 'Context window 93% full' }).getAttribute('data-context-meter')).toBe('crit');
  expect(container.querySelector('[data-context-bar="crit"]')).not.toBeNull();
});

it('renders nothing when the setting is off or there is no data', () => {
  useAppStore.setState({ contextMeterEnabled: false });
  const { container, rerender } = render(<><ContextMeter terminalId="s1" /><ContextBar terminalId="s1" /></>);
  expect(container.innerHTML).toBe('');
  useAppStore.setState({ contextMeterEnabled: true, claudeContextWindow: '200k' });
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

it('issue #120: a [1m] configured model reads against 1M, not 200k', () => {
  useAppStore.setState({ claudeContextWindow: 'auto' });
  useContextUsageStore.setState({ byId: new Map([['s1', usage(74_600, 'claude-sonnet-5-5', 'sonnet[1m]')]]) });
  render(<ContextMeter terminalId="s1" />);
  const chip = screen.getByRole('button', { name: 'Context window 7% full' });
  expect(chip.getAttribute('data-context-meter')).toBe('ok');
  fireEvent.click(chip);
  expect(screen.getByRole('dialog').textContent).toContain('75k of 1M tokens');
});

it('shows tokens only, never a warning, when the window is unknown', () => {
  useAppStore.setState({ claudeContextWindow: 'auto' });
  useContextUsageStore.setState({ byId: new Map([['s1', usage(185_000, 'claude-sonnet-5-5')]]) });
  const { container } = render(<><ContextMeter terminalId="s1" /><ContextBar terminalId="s1" /></>);
  const chip = screen.getByRole('button', { name: 'Context window: 185k tokens used, window size unknown' });
  expect(chip.getAttribute('data-context-meter')).toBe('unknown');
  expect(chip.textContent).toBe('185k');
  expect(container.querySelector('.context-meter-crit')).toBeNull();
  // a fill bar needs a window, so the sidebar card shows none
  expect(container.querySelector('[data-context-bar]')).toBeNull();
  fireEvent.click(chip);
  const dialog = screen.getByRole('dialog').textContent ?? '';
  expect(dialog).toMatch(/185k\s*tokens used/);
  expect(dialog).toContain('Settings > General');
  expect(dialog).not.toContain('%');
  // /compact stays available
  expect(screen.getByRole('button', { name: /Type \/compact/ })).toBeTruthy();
});

it('latches to 1M after the session has gone over 200k, even after /compact', () => {
  useAppStore.setState({ claudeContextWindow: 'auto' });
  useContextUsageStore.setState({ byId: new Map(), seenOver200k: new Set() });
  useContextUsageStore.getState().replace({ s1: usage(250_000) });
  useContextUsageStore.getState().replace({ s1: usage(40_000) });
  render(<ContextMeter terminalId="s1" />);
  expect(screen.getByRole('button', { name: 'Context window 4% full' })).toBeTruthy();
});
