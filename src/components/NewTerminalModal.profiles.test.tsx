import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => 'C:\\w' }));

import { NewTerminalModal } from './NewTerminalModal';
import { useAgentRegistryStore } from '../store/agentRegistryStore';
import { useAppStore } from '../store/appStore';

const profile = (id: string, name: string, is_default: boolean) => ({
  id, name, description: null, working_directory: `C:\\repos\\${id}`,
  claude_args: [], env_vars: {}, is_default, agent: 'claude',
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_profiles') return [profile('p1', 'Agentrium', false), profile('p2', 'Agentrium Dev', true)];
    return [];
  });
  useAppStore.setState({ newTerminalModalOpen: true, newTerminalPreselectedAgent: null, pinnedProfileIds: [] });
  useAgentRegistryStore.setState({ credentials: [], customAgents: [], builtinBindings: {}, loaded: true });
});
afterEach(() => cleanup());

describe('NewTerminalModal profile picker', () => {
  it('exposes the list as a radiogroup with exactly one checked row', async () => {
    render(<NewTerminalModal />);
    const group = await screen.findByRole('radiogroup', { name: 'Profile' });
    await within(group).findByRole('radio', { name: /Agentrium Dev/ });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map(r => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
    expect(within(group).getByRole('radio', { name: /No Profile/ }).getAttribute('aria-checked')).toBe('false');
  });

  it('moves the checked state when another row is clicked', async () => {
    render(<NewTerminalModal />);
    const group = await screen.findByRole('radiogroup', { name: 'Profile' });
    const dev = await within(group).findByRole('radio', { name: /Agentrium Dev/ });
    const ag = within(group).getByRole('radio', { name: /^Agentrium C:/ });
    fireEvent.click(ag);
    expect(ag.getAttribute('aria-checked')).toBe('true');
    expect(dev.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(within(group).getByRole('radio', { name: /No Profile/ }));
    expect(ag.getAttribute('aria-checked')).toBe('false');
    expect(within(group).getByRole('radio', { name: /No Profile/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('marks every row with a radio ring and no longer uses a trailing check icon', async () => {
    render(<NewTerminalModal />);
    const group = await screen.findByRole('radiogroup', { name: 'Profile' });
    await within(group).findByRole('radio', { name: /Agentrium Dev/ });
    // The ring is the visible affordance on every row, so unselected rows
    // read as "not this one" instead of showing nothing.
    expect(group.querySelectorAll('[data-testid="profile-radio-ring"]').length).toBe(3);
    // The lone lucide check in the hover-action slot was the confusing "V".
    expect(group.querySelector('.lucide-check')).toBeNull();
  });
});
