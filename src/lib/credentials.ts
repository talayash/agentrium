import { invoke } from '@tauri-apps/api/core';
import type { AgentKind } from './agents';
import type { ProviderId } from './agentPresets';

export interface CredentialBinding { env: string; credential_id: string }

/** Mirrors Rust `credentials::CredentialMeta`. Never contains a key value. */
export interface CredentialMeta {
  id: string;
  label: string;
  provider: ProviderId;
  env_name: string;
  endpoint_env: string | null;
  has_key: boolean;
  has_endpoint: boolean;
  masked_tail: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** Mirrors Rust `custom_agents::CustomAgent`. */
export interface CustomAgent {
  id: string;
  name: string;
  binary: string;
  default_args: string[];
  resume_flag: string | null;
  color: string;
  required_env: string[];
  bindings: CredentialBinding[];
  install_url: string | null;
  install_hint: string | null;
  created_at: string;
  updated_at: string;
}

export interface BinaryProbe { found: boolean; resolved_path: string | null; version: string | null }
export interface CredentialTestResult { ok: boolean; detail: string; latency_ms: number }

export const listCredentials = () => invoke<CredentialMeta[]>('list_credentials');
/** `key`/`endpoint`: undefined = unchanged, '' = clear, string = set. */
export const saveCredential = (meta: CredentialMeta, key?: string, endpoint?: string) =>
  invoke<CredentialMeta>('save_credential', { meta, key: key ?? null, endpoint: endpoint ?? null });
export const deleteCredential = (id: string) => invoke<void>('delete_credential', { id });
export const testCredential = (id: string) => invoke<CredentialTestResult>('test_credential', { id });
export const listCustomAgents = () => invoke<CustomAgent[]>('list_custom_agents');
export const saveCustomAgent = (agent: CustomAgent) => invoke<CustomAgent>('save_custom_agent', { agent });
export const deleteCustomAgent = (id: string) => invoke<void>('delete_custom_agent', { id });
export const probeBinary = (binary: string) => invoke<BinaryProbe>('probe_binary', { binary });
export const getAgentBindings = (agent: AgentKind) => invoke<CredentialBinding[]>('get_agent_bindings', { agent });
export const setAgentBindings = (agent: AgentKind, bindings: CredentialBinding[]) =>
  invoke<void>('set_agent_bindings', { agent, bindings });
