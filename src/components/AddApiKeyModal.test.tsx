import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { AddApiKeyModal } from './AddApiKeyModal';
import { useAgentRegistryStore } from '../store/agentRegistryStore';

beforeEach(() => {
  invoke.mockReset();
  useAgentRegistryStore.setState({ addKeyOpen: true, keyPrefill: null, credentials: [], customAgents: [], builtinBindings: {} });
});
// Vitest globals is off, so testing-library skips auto-cleanup - the exit
// animation of Modal (opacity:0) would leave a duplicate Save Key button in
// the DOM for the next test and every getByText would collide.
afterEach(() => cleanup());

describe('AddApiKeyModal', () => {
  it('picking a provider fills env var and endpoint var; saving sends key but never echoes it', async () => {
    invoke.mockImplementation(async (cmd: string, args: { meta?: { env_name: string }; key?: string }) => {
      if (cmd === 'save_credential') return { id: 'c1', label: 'Work', provider: 'openai', env_name: args.meta!.env_name, endpoint_env: 'OPENAI_BASE_URL', has_key: true, has_endpoint: false, masked_tail: 'abcd', created_at: '', last_used_at: null };
      if (cmd === 'set_agent_bindings') return undefined;
      return [];
    });
    render(<AddApiKeyModal />);
    fireEvent.click(screen.getByText('OpenAI'));
    expect((screen.getByLabelText('Environment variable') as HTMLInputElement).value).toBe('OPENAI_API_KEY');
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Work' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-proj-secretabcd' } });
    fireEvent.click(screen.getByText('Save Key'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('save_credential', expect.objectContaining({ key: 'sk-proj-secretabcd' })));
    expect(useAgentRegistryStore.getState().credentials[0].masked_tail).toBe('abcd');
    expect(useAgentRegistryStore.getState().addKeyOpen).toBe(false);
  });

  it('blocks save when neither key nor endpoint is given', () => {
    render(<AddApiKeyModal />);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Empty' } });
    fireEvent.click(screen.getByText('Save Key'));
    expect(screen.getByText('Enter an API key or an endpoint override.')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith('save_credential', expect.anything());
  });
});
