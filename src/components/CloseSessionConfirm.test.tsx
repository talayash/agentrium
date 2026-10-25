import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('../lib/tabTransfer', () => ({ createDetachedWindow: vi.fn() }));
import { SessionCards } from './SessionCards';
import { CloseSessionConfirm } from './CloseSessionConfirm';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { useSessionAttentionStore } from '../store/sessionAttentionStore';
import { closeConfirmWarning, confirmPopoverPosition, useCloseConfirmStore } from '../lib/closeConfirm';
import type { AgentKind } from '../lib/agents';

const closeTerminal = vi.fn().mockResolvedValue(undefined);

function seed(agent: AgentKind, state: 'busy' | 'waiting' | 'idle', task?: unknown) {
  useTerminalStore.setState({
    terminals: new Map([['one', {
      config: { id: 'one', label: 'fix-auth', nickname: null, profile_id: null, working_directory: '/project', claude_args: [], env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent, task },
      xterm: null, isWorktree: false,
    }]]),
    activeTerminalId: 'one', unreadTerminalIds: new Set(), gitInfoCache: new Map(), terminalMetrics: new Map(),
    terminalStates: new Map([['one', state]]),
    closeTerminal,
  } as never);
}

function renderApp() {
  render(<><SessionCards /><CloseSessionConfirm /></>);
}

const clickCardX = () => fireEvent.click(screen.getByRole('button', { name: 'Close fix-auth' }));

beforeEach(() => {
  closeTerminal.mockClear();
  useSessionAttentionStore.setState({ pending: new Set(), acknowledged: new Set() });
  useAppStore.setState({ pinnedTabIds: [], gridTerminalIds: [], confirmCloseSession: true, finishTaskTerminalId: null });
  useCloseConfirmStore.setState({ pending: null });
});
afterEach(cleanup);

describe('close session confirmation', () => {
  it('asks before closing and names the session agent', () => {
    seed('codex', 'busy');
    renderApp();
    clickCardX();
    expect(screen.getByRole('alertdialog').textContent).toContain('Close "fix-auth"?');
    expect(screen.getByText('Codex is still working on a response.')).toBeTruthy();
    expect(closeTerminal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(closeTerminal).toHaveBeenCalledWith('one');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('uses the Claude Code name for a Claude session and no warning when idle', () => {
    seed('claude', 'waiting');
    renderApp();
    clickCardX();
    expect(screen.getByText('Claude Code is waiting for your input.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    seed('claude', 'idle');
    clickCardX();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.queryByText(/is still working|is waiting/)).toBeNull();
  });

  it('keeps the session on Cancel, Escape and outside click', () => {
    seed('claude', 'idle');
    renderApp();
    clickCardX();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    clickCardX();
    fireEvent.keyDown(document, { key: 'Escape' });
    clickCardX();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(closeTerminal).not.toHaveBeenCalled();
  });

  it('"Don\'t ask again" turns the setting off and later closes go straight through', () => {
    seed('claude', 'idle');
    renderApp();
    clickCardX();
    fireEvent.click(screen.getByRole('checkbox', { name: "Don't ask again" }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useAppStore.getState().confirmCloseSession).toBe(false);
    closeTerminal.mockClear();
    clickCardX();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(closeTerminal).toHaveBeenCalledWith('one');
  });

  it('task sessions skip the popover and open the finish dialog', () => {
    seed('claude', 'busy', { slug: 'x', branch: 'agentrium/x' });
    renderApp();
    clickCardX();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(useAppStore.getState().finishTaskTerminalId).toBe('one');
    expect(closeTerminal).not.toHaveBeenCalled();
  });
});

describe('closeConfirm helpers', () => {
  it('only warns for busy or waiting sessions', () => {
    expect(closeConfirmWarning('Codex', 'busy')).toBe('Codex is still working on a response.');
    expect(closeConfirmWarning('Codex', 'waiting')).toBe('Codex is waiting for your input.');
    expect(closeConfirmWarning('Codex', 'idle')).toBeNull();
    expect(closeConfirmWarning('Codex', undefined)).toBeNull();
  });

  it('places the popover under the anchor, flips above near the bottom, clamps to the viewport', () => {
    const size = { width: 268, height: 120 };
    const vp = { width: 1000, height: 800 };
    expect(confirmPopoverPosition({ top: 100, bottom: 118, left: 300, right: 318 }, size, vp)).toEqual({ left: 50, top: 124 });
    expect(confirmPopoverPosition({ top: 700, bottom: 718, left: 300, right: 318 }, size, vp)).toEqual({ left: 50, top: 574 });
    expect(confirmPopoverPosition({ top: 100, bottom: 118, left: 0, right: 18 }, size, vp).left).toBe(8);
    expect(confirmPopoverPosition(null, size, vp)).toEqual({ left: 366, top: 64 });
  });
});

describe('close session confirmation placement', () => {
  it('is placed on screen on the first and every later open, without waiting for a state change', () => {
    seed('claude', 'idle');
    renderApp();
    for (let i = 0; i < 3; i++) {
      clickCardX();
      const box = screen.getByRole('alertdialog');
      // jsdom rects are all zero: under the anchor, clamped to the margin.
      expect(box.style.left).toBe('8px');
      expect(box.style.top).toBe('6px');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    }
  });
});
