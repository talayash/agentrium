import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { useAgentRegistryStore } from './agentRegistryStore';
import { specFor, allAgentSpecs } from '../lib/agents';
import type { CredentialMeta, CustomAgent } from '../lib/credentials';

const agentRow: CustomAgent = {
  id: 'a1', name: 'OpenCode', binary: 'opencode', default_args: ['--agent', 'build'],
  resume_flag: '--session {id}', color: '#30C55E', required_env: ['OPENAI_API_KEY'],
  bindings: [{ env: 'OPENAI_API_KEY', credential_id: 'c1' }],
  install_url: null, install_hint: null, created_at: '', updated_at: '',
};
const credRow: CredentialMeta = {
  id: 'c1', label: 'Work OpenAI', provider: 'openai', env_name: 'OPENAI_API_KEY', endpoint_env: 'OPENAI_BASE_URL',
  has_key: true, has_endpoint: false, masked_tail: '9fQ2', created_at: '', last_used_at: null,
};

beforeEach(() => {
  invoke.mockReset();
  useAgentRegistryStore.setState({ customAgents: [], credentials: [], builtinBindings: {}, loaded: false, addAgentOpen: false, editingAgentId: null, addKeyOpen: false, keyPrefill: null });
});

describe('agentRegistryStore', () => {
  it('refresh loads agents, credentials and builtin bindings, and registers custom specs', async () => {
    invoke.mockImplementation(async (cmd: string, args?: { agent?: string }) => {
      if (cmd === 'list_custom_agents') return [agentRow];
      if (cmd === 'list_credentials') return [credRow];
      if (cmd === 'get_agent_bindings') return args?.agent === 'claude' ? [{ env: 'ANTHROPIC_API_KEY', credential_id: 'c1' }] : [];
      return [];
    });
    await useAgentRegistryStore.getState().refresh();
    const s = useAgentRegistryStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.customAgents).toHaveLength(1);
    expect(s.credentials[0].label).toBe('Work OpenAI');
    expect(s.builtinBindings.claude).toEqual([{ env: 'ANTHROPIC_API_KEY', credential_id: 'c1' }]);
    expect(specFor('custom:a1').monogram).toBe('OC');
    expect(allAgentSpecs()).toHaveLength(5);
  });

  it('defaultBindingsFor reads custom rows or the builtin map', async () => {
    useAgentRegistryStore.setState({ customAgents: [agentRow], builtinBindings: { codex: [{ env: 'OPENAI_API_KEY', credential_id: 'c9' }] } });
    const s = useAgentRegistryStore.getState();
    expect(s.defaultBindingsFor('custom:a1')).toEqual(agentRow.bindings);
    expect(s.defaultBindingsFor('codex')[0].credential_id).toBe('c9');
    expect(s.defaultBindingsFor('cursor')).toEqual([]);
  });

  it('deleteCredential removes the row locally and strips bindings', async () => {
    invoke.mockResolvedValue(undefined);
    useAgentRegistryStore.setState({ customAgents: [agentRow], credentials: [credRow], builtinBindings: { claude: [{ env: 'ANTHROPIC_API_KEY', credential_id: 'c1' }] } });
    await useAgentRegistryStore.getState().deleteCredential('c1');
    const s = useAgentRegistryStore.getState();
    expect(invoke).toHaveBeenCalledWith('delete_credential', { id: 'c1' });
    expect(s.credentials).toEqual([]);
    expect(s.customAgents[0].bindings).toEqual([]);
    expect(s.builtinBindings.claude).toEqual([]);
  });

  it('credentialsForEnv filters by env name', () => {
    useAgentRegistryStore.setState({ credentials: [credRow, { ...credRow, id: 'c2', label: 'Anth', env_name: 'ANTHROPIC_API_KEY' }] });
    expect(useAgentRegistryStore.getState().credentialsForEnv('OPENAI_API_KEY').map(c => c.id)).toEqual(['c1']);
  });
});
