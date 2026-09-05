import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => 'C:\\w' }));

import { NewTerminalModal } from './NewTerminalModal';
import { useAgentRegistryStore } from '../store/agentRegistryStore';
import { useAppStore } from '../store/appStore';

const cred = { id: 'c1', label: 'Work Anthropic', provider: 'anthropic', env_name: 'ANTHROPIC_API_KEY', endpoint_env: null, has_key: true, has_endpoint: false, masked_tail: 'Zk3q', created_at: '', last_used_at: null } as const;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_profiles') return [];
    if (cmd === 'create_terminal') return { id: 't1', label: 'Terminal 1', nickname: null, profile_id: null, working_directory: 'C:\\w', claude_args: [], env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'claude', credential_bindings: [{ env: 'ANTHROPIC_API_KEY', credential_id: 'c1' }] };
    return [];
  });
  useAppStore.setState({ newTerminalModalOpen: true, newTerminalPreselectedAgent: null });
  useAgentRegistryStore.setState({ credentials: [cred], customAgents: [], builtinBindings: { claude: [{ env: 'ANTHROPIC_API_KEY', credential_id: 'c1' }] }, loaded: true });
});
afterEach(() => cleanup());

describe('NewTerminalModal authentication', () => {
  it('API key mode sends credential_bindings and never a key value', async () => {
    render(<NewTerminalModal />);
    fireEvent.click(await screen.findByText('API key'));
    // "Work Anthropic" appears twice: once in the row label and once as
    // a <select> <option>. Either occurrence proves the auth row rendered.
    expect(screen.getAllByText('Work Anthropic').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Start Session'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('create_terminal', expect.anything()));
    const call = invoke.mock.calls.find(c => c[0] === 'create_terminal')!;
    const req = (call[1] as { request: { credential_bindings: unknown; env_vars: Record<string, string> } }).request;
    expect(req.credential_bindings).toEqual([{ env: 'ANTHROPIC_API_KEY', credential_id: 'c1' }]);
    expect(JSON.stringify(req)).not.toContain('Zk3q');
    expect(Object.keys(req.env_vars)).not.toContain('ANTHROPIC_API_KEY');
  });

  it('CLI login mode (default) sends no bindings', async () => {
    // Override the shared beforeEach seed: without a built-in binding, the
    // seeding effect leaves authMode='cli' and sessionBindings empty, so
    // bindingsToSend is [] on submit. (The plan text says "default", but
    // with a seeded binding the modal actually opens in 'key' mode - we
    // clear the seed to exercise the true CLI-login path.)
    useAgentRegistryStore.setState({ builtinBindings: {} });
    render(<NewTerminalModal />);
    await screen.findByText('CLI login');
    fireEvent.click(screen.getByText('Start Session'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('create_terminal', expect.anything()));
    const call = invoke.mock.calls.find(c => c[0] === 'create_terminal')!;
    expect((call[1] as { request: { credential_bindings: unknown[] } }).request.credential_bindings).toEqual([]);
  });
});
