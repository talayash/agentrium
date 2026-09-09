import { useEffect, useState } from 'react';
import { KeyRound, Plus, Server } from 'lucide-react';
import { useAppStore } from '../../../store/appStore';
import { useAgentRegistryStore } from '../../../store/agentRegistryStore';
import { PageHeader } from '../SettingRow';
import { registerSetting } from '../index';
import { BrandIcon } from '../../BrandIcon';
import { allAgentSpecs, isCustomAgent, customIdOf, type AgentKind } from '../../../lib/agents';
import type { BinaryProbe } from '../../../lib/credentials';
import { toast } from '../../../store/toastStore';
import { reportInvokeFailure } from '../../../lib/errorReporter';
import { invoke } from '@tauri-apps/api/core';

const cat = { group: 'claude', page: 'agents-keys' } as const;
registerSetting({ category: cat, id: 'agents', label: 'Agents', keywords: ['agent', 'cli', 'opencode', 'gemini', 'aider', 'goose', 'custom', 'binary'] });
registerSetting({ category: cat, id: 'api-keys', label: 'API keys', keywords: ['key', 'credential', 'keychain', 'token', 'anthropic', 'openai', 'ollama', 'endpoint'] });

const BUILTIN_REQUIRED_ENV: Record<string, string[]> = { claude: ['ANTHROPIC_API_KEY'], codex: ['OPENAI_API_KEY'], cursor: ['CURSOR_API_KEY'], antigravity: [] };

function relative(iso: string | null): string {
  if (!iso) return 'Never used';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 60) return `Used ${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `Used ${h} h ago`;
  return `Used ${Math.round(h / 24)} d ago`;
}

type Status = { dot: string; word: string; action: { label: string; run: () => void } | null };

export default function AgentsKeysPage() {
  const { customAgents, credentials, builtinBindings, refresh, deleteCredential, openAddAgent, openAddKey } = useAgentRegistryStore();
  const openSettingsPage = useAppStore((s) => s.openSettings);
  const [probes, setProbes] = useState<Record<string, BinaryProbe | null>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    refresh().catch((e) => setLoadError(String(e)));
  }, [refresh]);

  // One probe per agent, in parallel, cached for the page lifetime.
  const specs = allAgentSpecs();
  useEffect(() => {
    for (const s of specs) {
      if (s.binary in probes) continue;
      setProbes((p) => ({ ...p, [s.binary]: null }));
      invoke<BinaryProbe>('probe_binary', { binary: s.binary })
        .then((r) => setProbes((p) => ({ ...p, [s.binary]: r })))
        .catch(() => setProbes((p) => ({ ...p, [s.binary]: { found: false, resolved_path: null, version: null } })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specs.map((s) => s.binary).join('|')]);

  const bindingsFor = (kind: AgentKind) =>
    isCustomAgent(kind) ? customAgents.find((a) => customIdOf(kind) === a.id)?.bindings ?? [] : builtinBindings[kind] ?? [];

  const statusFor = (kind: AgentKind, binary: string): Status => {
    const probe = probes[binary];
    const required = isCustomAgent(kind) ? allAgentSpecs().find((s) => s.kind === kind)?.requiredEnv ?? [] : BUILTIN_REQUIRED_ENV[kind] ?? [];
    if (probe === undefined || probe === null) return { dot: 'bg-text-tertiary', word: 'Checking', action: null };
    if (!probe.found) {
      const spec = allAgentSpecs().find((s) => s.kind === kind);
      return { dot: 'bg-error', word: 'Missing', action: spec?.installUrl ? { label: 'Install', run: () => { invoke('open_external_url', { url: spec.installUrl }).catch(() => {}); } } : null };
    }
    const bound = new Set(bindingsFor(kind).map((b) => b.env));
    const unbound = required.filter((e) => !bound.has(e));
    // Cursor is the only built-in that cannot run on CLI login alone.
    if (unbound.length && (kind === 'cursor' || isCustomAgent(kind))) {
      return { dot: 'bg-warning', word: 'No key', action: { label: 'Add key', run: () => openAddKey({ env_name: unbound[0] }) } };
    }
    return { dot: 'bg-success', word: 'Ready', action: null };
  };

  const handleDeleteKey = async (id: string, label: string) => {
    setConfirmDeleteId(null);
    try {
      await deleteCredential(id);
      toast.success('Key removed', `"${label}" was deleted from your OS credential store.`);
    } catch (err) {
      toast.error('Remove failed', String(err));
      reportInvokeFailure('delete_credential', err);
    }
  };

  const usersOf = (credId: string): string[] =>
    specs.filter((s) => bindingsFor(s.kind).some((b) => b.credential_id === credId)).map((s) => s.displayName);

  return (
    <div>
      <PageHeader title="Agents & Keys" description="Which coding agents Agentrium can launch, and the credentials it hands them." />

      {loadError && (
        <div className="mb-4 p-3 rounded-md bg-error/5 ring-1 ring-error/20 text-error text-[12px]">Credential store unavailable: {loadError}</div>
      )}

      <section className="mb-6">
        <div className="flex items-center justify-between mb-1.5">
          <h3 className="text-text-primary text-[13px] font-semibold">Agents</h3>
          <button onClick={() => openAddAgent()} className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-accent-primary text-white text-[11.5px] font-semibold hover:bg-accent-secondary">
            <Plus size={12} strokeWidth={2.5} /> Add agent
          </button>
        </div>
        <div className="bg-elevation-2 rounded-xl ring-1 ring-seam px-3.5 divide-y divide-[var(--seam)]">
          {specs.map((s) => {
            const st = statusFor(s.kind, s.binary);
            const probe = probes[s.binary];
            const custom = isCustomAgent(s.kind);
            const keyLabels = bindingsFor(s.kind).map((b) => credentials.find((c) => c.id === b.credential_id)?.label).filter(Boolean);
            const sub = [
              s.binary,
              probe?.version ? `v${probe.version.replace(/^v/, '')}` : probe && !probe.found ? 'not found on PATH' : null,
              keyLabels.length ? `key: ${keyLabels.join(', ')}` : null,
              custom && s.resumeFlag ? `resume ${s.resumeFlag}` : null,
            ].filter(Boolean).join(' · ');
            return (
              <div key={s.kind} className="flex items-center gap-3 h-[46px]">
                <BrandIcon kind={s.kind} size={18} />
                <div className="flex-1 min-w-0">
                  <p className="text-text-primary text-[13px] truncate">{s.displayName} <span className="text-text-tertiary text-[11px] ml-1.5">{custom ? 'Local CLI' : 'Built in'}</span></p>
                  <p className="text-text-tertiary text-[11px] font-mono truncate">{sub}</p>
                </div>
                <span className={`w-[7px] h-[7px] rounded-full ${st.dot}`} />
                <span className="text-text-tertiary text-[12px] w-[70px]">{st.word}</span>
                {st.action
                  ? <button onClick={st.action.run} className="text-accent-primary text-[12px] hover:underline">{st.action.label}</button>
                  : custom
                    ? <button onClick={() => openAddAgent(customIdOf(s.kind)!)} className="text-accent-primary text-[12px] hover:underline">Edit</button>
                    : s.kind === 'claude'
                      ? <button onClick={() => openSettingsPage()} className="text-accent-primary text-[12px] hover:underline">Defaults</button>
                      : <span className="w-[52px]" />}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <div className="flex items-start justify-between mb-1.5">
          <div>
            <h3 className="text-text-primary text-[13px] font-semibold">API keys</h3>
            <p className="text-text-tertiary text-[11.5px]">Stored in your OS credential store. Agentrium keeps labels only.</p>
          </div>
          <button onClick={() => openAddKey()} className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-fill-hover ring-1 ring-seam text-text-primary text-[11.5px] font-semibold hover:bg-fill-active">
            <Plus size={12} strokeWidth={2.5} /> Add key
          </button>
        </div>
        <div className="bg-elevation-2 rounded-xl ring-1 ring-seam px-3.5 divide-y divide-[var(--seam)]">
          {credentials.length === 0 && (
            <p className="py-4 text-text-tertiary text-[12px]">No keys yet. Agents use their own CLI login until you add one.</p>
          )}
          {credentials.map((c) => {
            const users = usersOf(c.id);
            const sub = [
              c.env_name,
              c.has_key ? `…${c.masked_tail ?? '****'}` : null,
              c.has_endpoint && c.endpoint_env ? `${c.endpoint_env} set` : null,
              users.length ? `used by ${users.join(', ')}` : null,
            ].filter(Boolean).join(' · ');
            return (
              <div key={c.id} className="flex items-center gap-3 h-[46px]">
                {c.has_key ? <KeyRound size={15} className="text-accent-primary flex-shrink-0" /> : <Server size={15} className="text-text-tertiary flex-shrink-0" />}
                <div className="flex-1 min-w-0">
                  <p className="text-text-primary text-[13px] truncate">{c.label}</p>
                  <p className="text-text-tertiary text-[11px] font-mono truncate">{sub}</p>
                </div>
                <span className="text-text-tertiary text-[12px]">{relative(c.last_used_at)}</span>
                {confirmDeleteId === c.id
                  ? <button onClick={() => handleDeleteKey(c.id, c.label)} className="text-error text-[12px] font-semibold">Confirm</button>
                  : <button onClick={() => setConfirmDeleteId(c.id)} className="text-error text-[12px] hover:underline">Remove</button>}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
