import { create } from 'zustand';
import {
  BUILTIN_AGENT_KINDS, customKind, isCustomAgent, monogramFor, setCustomAgentSpecs,
  type AgentKind, type AgentSpec, type BuiltinAgentKind,
} from '../lib/agents';
import {
  deleteCredential as ipcDeleteCredential, deleteCustomAgent as ipcDeleteCustomAgent,
  getAgentBindings, listCredentials, listCustomAgents, probeBinary,
  saveCredential as ipcSaveCredential, saveCustomAgent as ipcSaveCustomAgent, setAgentBindings,
  type BinaryProbe, type CredentialBinding, type CredentialMeta, type CustomAgent,
} from '../lib/credentials';

export function toSpec(a: CustomAgent): AgentSpec {
  return {
    kind: customKind(a.id),
    displayName: a.name,
    binary: a.binary,
    installUrl: a.install_url ?? '',
    installHint: a.install_hint ?? '',
    defaultArgsHint: a.default_args.join('\n'),
    color: a.color,
    monogram: monogramFor(a.name),
    defaultArgs: a.default_args,
    resumeFlag: a.resume_flag,
    requiredEnv: a.required_env,
  };
}

export interface KeyPrefill {
  provider?: CredentialMeta['provider'];
  label?: string;
  env_name?: string;
  key?: string;
  /** Profile id whose env var is being moved; the modal removes it on save. */
  fromProfileId?: string;
}

interface AgentRegistryState {
  customAgents: CustomAgent[];
  credentials: CredentialMeta[];
  builtinBindings: Partial<Record<BuiltinAgentKind, CredentialBinding[]>>;
  probes: Record<string, BinaryProbe>;
  loaded: boolean;

  refresh: () => Promise<void>;
  probe: (binary: string) => Promise<BinaryProbe>;
  saveAgent: (agent: CustomAgent) => Promise<CustomAgent>;
  deleteAgent: (id: string) => Promise<void>;
  saveCredential: (meta: CredentialMeta, key?: string, endpoint?: string) => Promise<CredentialMeta>;
  deleteCredential: (id: string) => Promise<void>;
  setBindings: (kind: AgentKind, bindings: CredentialBinding[]) => Promise<void>;
  defaultBindingsFor: (kind: AgentKind) => CredentialBinding[];
  credentialsForEnv: (env: string) => CredentialMeta[];

  addAgentOpen: boolean;
  editingAgentId: string | null;
  openAddAgent: (editId?: string) => void;
  closeAddAgent: () => void;
  addKeyOpen: boolean;
  keyPrefill: KeyPrefill | null;
  openAddKey: (prefill?: KeyPrefill) => void;
  closeAddKey: () => void;
}

export const useAgentRegistryStore = create<AgentRegistryState>((set, get) => ({
  customAgents: [],
  credentials: [],
  builtinBindings: {},
  probes: {},
  loaded: false,

  refresh: async () => {
    const [customAgents, credentials, ...bindingLists] = await Promise.all([
      listCustomAgents(),
      listCredentials(),
      ...BUILTIN_AGENT_KINDS.map(k => getAgentBindings(k)),
    ]);
    const builtinBindings: Partial<Record<BuiltinAgentKind, CredentialBinding[]>> = {};
    BUILTIN_AGENT_KINDS.forEach((k, i) => { builtinBindings[k] = bindingLists[i]; });
    setCustomAgentSpecs(customAgents.map(toSpec));
    set({ customAgents, credentials, builtinBindings, loaded: true });
  },

  probe: async (binary) => {
    const result = await probeBinary(binary);
    set(s => ({ probes: { ...s.probes, [binary]: result } }));
    return result;
  },

  saveAgent: async (agent) => {
    const saved = await ipcSaveCustomAgent(agent);
    set(s => {
      const rest = s.customAgents.filter(a => a.id !== saved.id);
      const customAgents = [...rest, saved].sort((a, b) => a.created_at.localeCompare(b.created_at));
      setCustomAgentSpecs(customAgents.map(toSpec));
      return { customAgents };
    });
    return saved;
  },

  deleteAgent: async (id) => {
    await ipcDeleteCustomAgent(id);
    set(s => {
      const customAgents = s.customAgents.filter(a => a.id !== id);
      setCustomAgentSpecs(customAgents.map(toSpec));
      return { customAgents };
    });
  },

  saveCredential: async (meta, key, endpoint) => {
    const saved = await ipcSaveCredential(meta, key, endpoint);
    set(s => ({ credentials: [...s.credentials.filter(c => c.id !== saved.id), saved] }));
    return saved;
  },

  deleteCredential: async (id) => {
    await ipcDeleteCredential(id);
    // Mirror the backend cascade so the UI never shows a dangling binding.
    set(s => {
      const strip = (b: CredentialBinding[]) => b.filter(x => x.credential_id !== id);
      const builtinBindings: Partial<Record<BuiltinAgentKind, CredentialBinding[]>> = {};
      for (const k of Object.keys(s.builtinBindings) as BuiltinAgentKind[]) builtinBindings[k] = strip(s.builtinBindings[k] ?? []);
      return {
        credentials: s.credentials.filter(c => c.id !== id),
        customAgents: s.customAgents.map(a => ({ ...a, bindings: strip(a.bindings) })),
        builtinBindings,
      };
    });
  },

  setBindings: async (kind, bindings) => {
    await setAgentBindings(kind, bindings);
    if (isCustomAgent(kind)) {
      set(s => ({ customAgents: s.customAgents.map(a => customKind(a.id) === kind ? { ...a, bindings } : a) }));
    } else {
      set(s => ({ builtinBindings: { ...s.builtinBindings, [kind]: bindings } }));
    }
  },

  defaultBindingsFor: (kind) => {
    const s = get();
    if (isCustomAgent(kind)) return s.customAgents.find(a => customKind(a.id) === kind)?.bindings ?? [];
    return s.builtinBindings[kind] ?? [];
  },

  credentialsForEnv: (env) => get().credentials.filter(c => c.env_name === env),

  addAgentOpen: false,
  editingAgentId: null,
  openAddAgent: (editId) => set({ addAgentOpen: true, editingAgentId: editId ?? null }),
  closeAddAgent: () => set({ addAgentOpen: false, editingAgentId: null }),
  addKeyOpen: false,
  keyPrefill: null,
  openAddKey: (prefill) => set({ addKeyOpen: true, keyPrefill: prefill ?? null }),
  closeAddKey: () => set({ addKeyOpen: false, keyPrefill: null }),
}));
