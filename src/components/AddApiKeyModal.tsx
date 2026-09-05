import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Eye, EyeOff, KeyRound, Play, ShieldCheck } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { useAgentRegistryStore } from '../store/agentRegistryStore';
import { allAgentSpecs, isCustomAgent, type AgentKind } from '../lib/agents';
import { ENV_NAME_RE, PROVIDERS, providerDefaults, type ProviderId } from '../lib/agentPresets';
import { testCredential, type CredentialMeta, type CredentialTestResult } from '../lib/credentials';
import { invoke } from '@tauri-apps/api/core';

const BUILTIN_REQUIRED_ENV: Record<string, string[]> = {
  claude: ['ANTHROPIC_API_KEY'],
  codex: ['OPENAI_API_KEY'],
  cursor: ['CURSOR_API_KEY'],
  antigravity: [],
};

const inputCls = 'w-full bg-elevation-2 ring-1 ring-seam rounded-lg h-9 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors';
const chip = (sel: boolean) =>
  `h-[30px] px-3 rounded-lg text-[12px] font-medium transition-colors ${sel ? 'bg-accent-primary text-white shadow-[0_2px_8px_var(--accent-glow-md)]' : 'bg-fill-hover ring-1 ring-seam text-text-secondary hover:bg-fill-active hover:text-text-primary'}`;

/**
 * Create or edit a credential. The key value goes to Rust exactly once via
 * `save_credential`; the modal never receives it back (only a masked tail).
 * `editing` = an existing CredentialMeta; blank key field then means "keep".
 */
export function AddApiKeyModal({ editing }: { editing?: CredentialMeta | null } = {}) {
  const { closeAddKey, keyPrefill, saveCredential, credentials, setBindings, defaultBindingsFor } = useAgentRegistryStore();
  const [provider, setProvider] = useState<ProviderId>(editing?.provider ?? keyPrefill?.provider ?? 'anthropic');
  const [label, setLabel] = useState(editing?.label ?? keyPrefill?.label ?? '');
  const [envName, setEnvName] = useState(editing?.env_name ?? keyPrefill?.env_name ?? providerDefaults('anthropic').envName);
  const [key, setKey] = useState(keyPrefill?.key ?? '');
  const [showKey, setShowKey] = useState(false);
  const [endpointEnv, setEndpointEnv] = useState<string>(editing?.endpoint_env ?? providerDefaults('anthropic').endpointEnv ?? '');
  const [endpoint, setEndpoint] = useState('');
  const [endpointOpen, setEndpointOpen] = useState(!!editing?.has_endpoint);
  const [useFor, setUseFor] = useState<Set<AgentKind>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<CredentialTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  // Provider pick fills the env defaults unless the user already typed one.
  const pickProvider = (p: ProviderId) => {
    setProvider(p);
    const d = providerDefaults(p);
    if (!editing) {
      setEnvName(d.envName);
      setEndpointEnv(d.endpointEnv ?? '');
    }
  };

  const candidateAgents = useMemo(
    () => allAgentSpecs().filter(s => (isCustomAgent(s.kind) ? s.requiredEnv ?? [] : BUILTIN_REQUIRED_ENV[s.kind] ?? []).includes(envName)),
    [envName],
  );
  useEffect(() => { setUseFor(new Set()); }, [envName]);

  const validate = (): string | null => {
    if (!label.trim() || label.trim().length > 40) return 'Label is required (1-40 characters).';
    if (credentials.some(c => c.label === label.trim() && c.id !== editing?.id)) return `A key labelled "${label.trim()}" already exists.`;
    if (!ENV_NAME_RE.test(envName)) return 'Environment variable must look like ANTHROPIC_API_KEY.';
    const hasKey = key.trim().length > 0 || !!editing?.has_key;
    const hasEndpoint = endpoint.trim().length > 0 || !!editing?.has_endpoint;
    if (hasEndpoint && !ENV_NAME_RE.test(endpointEnv)) return 'Endpoint variable must look like ANTHROPIC_BASE_URL.';
    if (!hasKey && !hasEndpoint) return 'Enter an API key or an endpoint override.';
    return null;
  };

  const handleSave = async () => {
    const v = validate();
    if (v) { setError(v); return; }
    setError(null);
    setSaving(true);
    try {
      const meta: CredentialMeta = {
        id: editing?.id ?? '',
        label: label.trim(),
        provider,
        env_name: envName,
        endpoint_env: endpointEnv || null,
        has_key: false, has_endpoint: false, masked_tail: null, created_at: '', last_used_at: null,
      };
      const saved = await saveCredential(meta, key.trim() || undefined, endpoint.trim() || undefined);
      for (const kind of useFor) {
        const existing = defaultBindingsFor(kind).filter(b => b.env !== envName);
        await setBindings(kind, [...existing, { env: envName, credential_id: saved.id }]);
      }
      if (keyPrefill?.fromProfileId) {
        // Moving a plaintext var out of a profile: drop it there now that the
        // value lives in the OS store.
        await invoke('strip_profile_env_var', { profileId: keyPrefill.fromProfileId, env: envName, credentialId: saved.id });
      }
      toast.success('Key saved', `"${saved.label}" is stored in your OS credential store.`);
      closeAddKey();
    } catch (err) {
      setError(String(err));
      reportInvokeFailure('save_credential', err);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    // Test needs a saved row (values live only in the OS store), so save first.
    const v = validate();
    if (v) { setError(v); return; }
    setTesting(true);
    try {
      const meta: CredentialMeta = {
        id: editing?.id ?? '', label: label.trim(), provider, env_name: envName, endpoint_env: endpointEnv || null,
        has_key: false, has_endpoint: false, masked_tail: null, created_at: '', last_used_at: null,
      };
      const saved = await saveCredential(meta, key.trim() || undefined, endpoint.trim() || undefined);
      setKey('');
      setTest(await testCredential(saved.id));
    } catch (err) {
      setTest({ ok: false, detail: String(err), latency_ms: 0 });
    } finally {
      setTesting(false);
    }
  };

  const toggleUseFor = (kind: AgentKind) => setUseFor(prev => {
    const next = new Set(prev);
    if (next.has(kind)) next.delete(kind); else next.add(kind);
    return next;
  });

  return (
    <Modal onClose={closeAddKey} closeOn="doubleClick" scrimClassName="bg-black/50 z-[60]" panelClassName="w-full max-w-lg max-h-[90vh] flex flex-col" showHeader title={editing ? 'Edit API Key' : 'Add API Key'} icon={<KeyRound size={16} className="text-text-secondary" />}>
      <div className="p-5 space-y-5 overflow-y-auto flex-1 min-h-0">
        <div>
          <label className="block text-text-tertiary text-[11px] font-semibold uppercase tracking-wider mb-2">Provider</label>
          <div className="flex flex-wrap gap-1.5">
            {PROVIDERS.map(p => (
              <button key={p.id} type="button" onClick={() => pickProvider(p.id)} className={chip(provider === p.id)}>{p.label}</button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label htmlFor="cred-label" className="block text-text-secondary text-[12px] mb-1.5">Label</label>
            <input id="cred-label" value={label} onChange={e => setLabel(e.target.value)} placeholder="Work Anthropic" className={inputCls} />
          </div>
          <div>
            <label htmlFor="cred-env" className="block text-text-secondary text-[12px] mb-1.5">Environment variable</label>
            <input id="cred-env" value={envName} onChange={e => setEnvName(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} />
          </div>
        </div>

        <div>
          <label htmlFor="cred-key" className="block text-text-secondary text-[12px] mb-1.5">API key</label>
          <div className="relative">
            <input
              id="cred-key" type={showKey ? 'text' : 'password'} value={key} onChange={e => setKey(e.target.value)}
              autoComplete="off" spellCheck={false}
              placeholder={editing?.has_key ? `Stored (…${editing.masked_tail ?? ''}) - leave blank to keep` : 'Paste your key'}
              className={`${inputCls} font-mono pr-10`}
            />
            <button type="button" aria-label={showKey ? 'Hide key' : 'Show key'} onClick={() => setShowKey(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-text-tertiary hover:text-text-secondary">
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <div className="mt-2 flex items-start gap-2 p-2.5 rounded-lg bg-success/[0.08] ring-1 ring-success/20">
            <ShieldCheck size={14} className="text-success mt-0.5 flex-shrink-0" />
            <p className="text-text-secondary text-[11.5px] leading-relaxed">
              Saved to your OS credential store. Agentrium keeps only the label and variable name; the value is read at launch and handed to the agent process, never written to profiles, session logs or telemetry.
            </p>
          </div>
        </div>

        <div className="rounded-xl ring-1 ring-seam bg-elevation-2 overflow-hidden">
          <button type="button" onClick={() => setEndpointOpen(v => !v)} aria-expanded={endpointOpen} className="w-full flex items-center gap-2 h-[38px] px-3 text-left">
            <ChevronDown size={12} className={`text-text-tertiary transition-transform ${endpointOpen ? '' : '-rotate-90'}`} />
            <span className="flex-1 text-text-primary text-[12px] font-semibold">Endpoint override</span>
            <span className="text-text-tertiary text-[11px]">Local models, proxies, gateways</span>
          </button>
          {endpointOpen && (
            <div className="px-3 pb-3 space-y-2">
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label htmlFor="cred-endpoint-env" className="block text-text-tertiary text-[11px] font-mono mb-1.5">Endpoint variable</label>
                  <input id="cred-endpoint-env" value={endpointEnv} onChange={e => setEndpointEnv(e.target.value.toUpperCase())} placeholder="ANTHROPIC_BASE_URL" className={`${inputCls} font-mono bg-elevation-0`} />
                </div>
                <div>
                  <label htmlFor="cred-endpoint" className="block text-text-tertiary text-[11px] font-mono mb-1.5">URL</label>
                  <input id="cred-endpoint" value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder={editing?.has_endpoint ? 'Stored - leave blank to keep' : providerDefaults(provider).defaultEndpoint ?? 'http://localhost:11434'} className={`${inputCls} font-mono bg-elevation-0`} />
                </div>
              </div>
              <p className="text-text-tertiary text-[11px] leading-relaxed">Ollama 0.14+ speaks the Anthropic Messages API natively at http://localhost:11434. Empty keeps the provider's default endpoint.</p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" icon={<Play size={12} />} onClick={handleTest} loading={testing}>Test connection</Button>
          {test && (
            <span className={`text-[12px] ${test.ok ? 'text-text-secondary' : 'text-error'}`}>
              {test.ok ? <>Authenticated · <span className="font-mono text-text-primary">{test.detail}</span> · {test.latency_ms} ms</> : test.detail}
            </span>
          )}
        </div>

        {candidateAgents.length > 0 && (
          <div>
            <label className="block text-text-secondary text-[12px] mb-1.5">Use as default for</label>
            <div className="flex flex-wrap gap-1.5">
              {candidateAgents.map(s => (
                <button key={s.kind} type="button" aria-pressed={useFor.has(s.kind)} onClick={() => toggleUseFor(s.kind)} className={`h-7 px-2.5 rounded-lg text-[12px] transition-colors ${useFor.has(s.kind) ? 'bg-accent-primary/12 ring-1 ring-accent-primary/45 text-text-primary' : 'bg-fill-hover ring-1 ring-seam text-text-secondary hover:bg-fill-active'}`}>
                  {s.displayName}
                </button>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="p-3 rounded-md bg-error/5 ring-1 ring-error/20"><p className="text-error text-[12px]">{error}</p></div>
        )}
      </div>
      <div className="flex justify-end gap-2 p-3 border-t border-seam">
        <Button variant="ghost" onClick={closeAddKey}>Cancel</Button>
        <Button variant="primary" onClick={handleSave} loading={saving}>Save Key</Button>
      </div>
    </Modal>
  );
}
