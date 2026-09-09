import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { AddAgentModal } from './AddAgentModal';
import { useAgentRegistryStore } from '../store/agentRegistryStore';

beforeEach(() => {
  invoke.mockReset();
  useAgentRegistryStore.setState({ addAgentOpen: true, editingAgentId: null, customAgents: [], credentials: [], builtinBindings: {}, probes: {} });
});
afterEach(() => cleanup());  // vitest config has globals: false, so @testing-library's auto-cleanup does not fire

describe('AddAgentModal', () => {
  it('a preset fills the form, the probe reports the binary, and save posts a CustomAgent', async () => {
    invoke.mockImplementation(async (cmd: string, args: { agent?: { name: string; binary: string; color: string } }) => {
      if (cmd === 'probe_binary') return { found: true, resolved_path: 'C:\\npm\\opencode.cmd', version: '1.4.2' };
      if (cmd === 'save_custom_agent') return { id: 'a1', ...args.agent, default_args: [], resume_flag: '--session {id}', required_env: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'], bindings: [], install_url: null, install_hint: null, created_at: '1', updated_at: '1' };
      return [];
    });
    render(<AddAgentModal />);
    fireEvent.click(screen.getByText('OpenCode'));
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('OpenCode');
    expect((screen.getByLabelText('Command') as HTMLInputElement).value).toBe('opencode');
    await waitFor(() => expect(screen.getByText(/Found/)).toBeTruthy(), { timeout: 2000 });
    expect(screen.getByText(/v1\.4\.2/)).toBeTruthy();
    fireEvent.click(screen.getByText('Add Agent'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('save_custom_agent', expect.objectContaining({ agent: expect.objectContaining({ binary: 'opencode', color: '#30C55E' }) })));
    expect(useAgentRegistryStore.getState().customAgents).toHaveLength(1);
    expect(useAgentRegistryStore.getState().addAgentOpen).toBe(false);
  });

  it('rejects an empty command before calling the backend', () => {
    render(<AddAgentModal />);
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Thing' } });
    fireEvent.click(screen.getByText('Add Agent'));
    expect(screen.getByText('Command is required.')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith('save_custom_agent', expect.anything());
  });
});
