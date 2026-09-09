import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Code2, KeyRound, Plus, PlusSquare, Terminal, Trash2 } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { useAgentRegistryStore } from '../store/agentRegistryStore';
import { monogramFor } from '../lib/agents';
import { AGENT_COLORS, AGENT_PRESETS, ENV_NAME_RE, type AgentColor, type AgentPreset } from '../lib/agentPresets';
import type { BinaryProbe, CredentialBinding, CustomAgent } from '../lib/credentials';

const inputCls = 'w-full bg-elevation-2 ring-1 ring-seam rounded-lg h-9 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors';

type Tab = 'cli' | 'key';

/**
 * Register or edit a local agent CLI. Presets pre-fill every field; "Custom
 * binary" clears them. The Command field is probed live (debounced 400 ms)
 * through `probe_binary`; a missing binary warns but does not block saving.
 * The "Hosted API (key only)" tab swaps the body for the Add API Key form.
 */
export function AddAgentModal() {
  const { closeAddAgent, editingAgentId, customAgents, saveAgent, deleteAgent, probe, credentialsForEnv, openAddKey } = useAgentRegistryStore();
  const editing = useMemo(() => customAgents.find(a => a.id === editingAgentId) ?? null, [customAgents, editingAgentId]);

  const [tab, setTab] = useState<Tab>('cli');
  const [presetId, setPresetId] = useState<string | null>(null);
  const [name, setName] = useState(editing?.name ?? '');
  const [binary, setBinary] = useState(editing?.binary ?? '');
  const [argsText, setArgsText] = useState(editing?.default_args.join('\n') ?? '');
  const [resumeFlag, setResumeFlag] = useState(editing?.resume_flag ?? '');
  const [color, setColor] = useState<AgentColor>((editing?.color as AgentColor) ?? AGENT_COLORS[0]);
  const [requiredEnv, setRequiredEnv] = useState<string[]>(editing?.required_env ?? []);
  const [bindings, setBindings] = useState<CredentialBinding[]>(editing?.bindings ?? []);
  const [newEnv, setNewEnv] = useState('');
  const [installUrl, setInstallUrl] = useState<string | null>(editing?.install_url ?? null);
  const [installHint, setInstallHint] = useState<string | null>(editing?.install_hint ?? null);
  const [probeResult, setProbeResult] = useState<BinaryProbe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyPreset = (p: AgentPreset) => {
    setPresetId(p.id);
    setName(p.name);
    setBinary(p.binary);
    setArgsText(p.defaultArgs.join('\n'));
    setResumeFlag(p.resumeFlag ?? '');
    setColor(p.color);
    setRequiredEnv([...p.requiredEnv]);
    setBindings([]);
    setInstallUrl(p.installUrl);
    setInstallHint(p.installHint);
  };

  // Debounced live probe. Cleared when the command empties.
  useEffect(() => {
    if (probeTimer.current) clearTimeout(probeTimer.current);
    const b = binary.trim();
    if (!b) { setProbeResult(null); return; }
    probeTimer.current = setTimeout(() => {
      // Best-effort: a probe failure (bad chars, IPC error) just shows no status.
      probe(b).then(setProbeResult).catch(() => setProbeResult(null));
    }, 400);
    return () => { if (probeTimer.current) clearTimeout(probeTimer.current); };
  }, [binary, probe]);

  const validate = (): string | null => {
    if (!name.trim() || name.trim().length > 40) return 'Display name is required (1-40 characters).';
    if (!binary.trim()) return 'Command is required.';
    const rf = resumeFlag.trim();
    if (rf && (rf.match(/\{id\}/g) ?? []).length > 1) return 'Resume flag may contain {id} at most once.';
    for (const e of requiredEnv) if (!ENV_NAME_RE.test(e)) return `"${e}" is not a valid environment variable name.`;
    return null;
  };

  const handleSave = async () => {
    const v = validate();
    if (v) { setError(v); return; }
    setError(null);
    setSaving(true);
    try {
      const agent: CustomAgent = {
        id: editing?.id ?? '',
        name: name.trim(),
        binary: binary.trim(),
        default_args: argsText.split('\n').map(s => s.trim()).filter(Boolean),
        resume_flag: resumeFlag.trim() || null,
        color,
        required_env: requiredEnv,
        bindings: bindings.filter(b => requiredEnv.includes(b.env)),
        install_url: installUrl,
        install_hint: installHint,
        created_at: editing?.created_at ?? '',
        updated_at: '',
      };
      const saved = await saveAgent(agent);
      toast.success(editing ? 'Agent updated' : 'Agent added', `"${saved.name}" is ready in the agent picker.`);
      closeAddAgent();
    } catch (err) {
      setError(String(err));
      reportInvokeFailure('save_custom_agent', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editing) return;
    try {
      await deleteAgent(editing.id);
      toast.success('Agent removed', `"${editing.name}" no longer appears in the picker.`);
      closeAddAgent();
    } catch (err) {
      toast.error('Delete failed', String(err));
      reportInvokeFailure('delete_custom_agent', err);
    }
  };

  const setBindingFor = (env: string, credentialId: string | '') => {
    setBindings(prev => {
      const rest = prev.filter(b => b.env !== env);
      return credentialId ? [...rest, { env, credential_id: credentialId }] : rest;
    });
  };

  const addEnv = () => {
    const e = newEnv.trim().toUpperCase();
    if (!e) return;
    if (!ENV_NAME_RE.test(e)) { setError(`"${e}" is not a valid environment variable name.`); return; }
    if (!requiredEnv.includes(e)) setRequiredEnv(prev => [...prev, e]);
    setNewEnv('');
    setError(null);
  };

  const commandPreview = [binary.trim(), ...argsText.split('\n').map(s => s.trim()).filter(Boolean)].filter(Boolean).join(' ');

  return (
    <Modal onClose={closeAddAgent} closeOn="doubleClick" scrimClassName="bg-black/50 z-[55]" panelClassName="w-full max-w-lg max-h-[90vh] flex flex-col" showHeader title={editing ? 'Edit Agent' : 'New Agent'} icon={<PlusSquare size={16} className="text-text-secondary" />}>
      <div className="p-5 space-y-5 overflow-y-auto flex-1 min-h-0">
        {!editing && (
          <div className="flex gap-1 p-[3px] rounded-[10px] bg-elevation-2 ring-1 ring-seam">
            {([['cli', 'Local CLI', Terminal], ['key', 'Hosted API (key only)', KeyRound]] as const).map(([id, label, Icon]) => (
              <button key={id} type="button" onClick={() => setTab(id)} aria-pressed={tab === id} className={`flex-1 h-[30px] flex items-center justify-center gap-1.5 rounded-lg text-[12px] transition-colors ${tab === id ? 'bg-elevation-4 text-text-primary font-semibold shadow-elevation-2' : 'text-text-secondary hover:text-text-primary'}`}>
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>
        )}

        {tab === 'key' ? (
          <p className="text-text-secondary text-[12.5px]">Store a provider key without adding a CLI. <button type="button" className="text-accent-primary hover:underline" onClick={() => openAddKey()}>Open Add API Key</button></p>
        ) : (
        <>
          {!editing && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-text-tertiary text-[11px] font-semibold uppercase tracking-wider">Start from</label>
                <span className="text-text-tertiary text-[11px]">Presets fill in binary, args and key name</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {AGENT_PRESETS.map(p => {
                  const sel = presetId === p.id;
                  const isCustom = p.id === 'custom';
                  return (
                    <button key={p.id} type="button" onClick={() => applyPreset(p)} aria-pressed={sel}
                      className={`flex flex-col items-center gap-1.5 p-3 rounded-xl transition-colors ${isCustom ? 'border border-dashed border-[rgba(255,255,255,0.14)] text-text-tertiary hover:bg-fill-hover' : sel ? 'bg-accent-primary/12 ring-1 ring-accent-primary/45' : 'bg-fill-hover ring-1 ring-seam hover:bg-fill-active'}`}>
                      {isCustom ? <Code2 size={18} /> : (
                        <span className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-[6px] text-[12px] font-bold" style={{ background: p.color, color: '#0F1320' }}>{monogramFor(p.name)}</span>
                      )}
                      <span className="text-[12px] font-medium text-text-primary">{isCustom ? 'Custom binary' : p.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label htmlFor="agent-name" className="block text-text-secondary text-[12px] mb-1.5">Display name</label>
              <input id="agent-name" value={name} onChange={e => setName(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label htmlFor="agent-binary" className="block text-text-secondary text-[12px] mb-1.5">Command</label>
              <input id="agent-binary" value={binary} onChange={e => setBinary(e.target.value)} placeholder="opencode" className={`${inputCls} font-mono`} spellCheck={false} />
            </div>
          </div>
          {probeResult && (
            <p className={`-mt-2 flex items-center gap-2 text-[11px] font-mono ${probeResult.found ? 'text-text-tertiary' : 'text-warning'}`}>
              {probeResult.found ? <Check size={13} className="text-success" /> : null}
              {probeResult.found
                ? `Found ${probeResult.resolved_path ?? binary.trim()}${probeResult.version ? ` · v${probeResult.version.replace(/^v/, '')}` : ''}`
                : 'Not found on PATH - you can still save and install it later.'}
            </p>
          )}

          <div>
            <label htmlFor="agent-args" className="block text-text-secondary text-[12px] mb-1.5">Default arguments <span className="text-text-tertiary">(one per line)</span></label>
            <textarea id="agent-args" value={argsText} onChange={e => setArgsText(e.target.value)} className={`${inputCls} h-16 py-2 font-mono text-[12px] resize-none`} spellCheck={false} />
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label htmlFor="agent-resume" className="block text-text-secondary text-[12px] mb-1.5">Resume flag</label>
              <input id="agent-resume" value={resumeFlag} onChange={e => setResumeFlag(e.target.value)} placeholder="--session {id}" className={`${inputCls} font-mono`} spellCheck={false} />
              <p className="text-text-tertiary text-[11px] mt-1 leading-relaxed">Use {'{id}'} to resume by id, or a plain flag like --continue for "continue most recent". Leave empty if the CLI cannot resume.</p>
            </div>
            <div>
              <label className="block text-text-secondary text-[12px] mb-1.5">Tile colour</label>
              <div className="flex items-center gap-2 h-9">
                {AGENT_COLORS.map(c => (
                  <button key={c} type="button" aria-label={`Colour ${c}`} aria-pressed={color === c} onClick={() => setColor(c)} className="w-[22px] h-[22px] rounded-[6px] transition-shadow" style={{ background: c, boxShadow: color === c ? '0 0 0 2px var(--elevation-4), 0 0 0 3.5px rgb(var(--text-primary))' : undefined }} />
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-text-secondary text-[12px] mb-1.5">Credentials this agent needs</label>
            <div className="rounded-xl ring-1 ring-seam bg-elevation-2 divide-y divide-[var(--seam)]">
              {requiredEnv.map(env => {
                const options = credentialsForEnv(env);
                const current = bindings.find(b => b.env === env)?.credential_id ?? '';
                return (
                  <div key={env} className="flex items-center gap-2.5 h-[42px] px-3">
                    <span className="flex-1 font-mono text-[12px] text-text-primary">{env}</span>
                    <select aria-label={`Credential for ${env}`} value={current} onChange={e => setBindingFor(env, e.target.value)} className="bg-elevation-0 text-text-primary text-[12px] px-2 h-7 rounded ring-1 ring-border-light">
                      <option value="">None</option>
                      {options.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                    <button type="button" aria-label={`Add key for ${env}`} onClick={() => openAddKey({ env_name: env })} className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-fill-hover"><KeyRound size={13} /></button>
                    <button type="button" aria-label={`Remove ${env}`} onClick={() => { setRequiredEnv(prev => prev.filter(x => x !== env)); setBindingFor(env, ''); }} className="p-1 rounded text-text-tertiary hover:text-error hover:bg-error/10"><Trash2 size={13} /></button>
                  </div>
                );
              })}
              <div className="flex items-center gap-2 h-9 px-3">
                <input aria-label="New variable name" value={newEnv} onChange={e => setNewEnv(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEnv(); } }} placeholder="ANOTHER_API_KEY" className="flex-1 bg-transparent font-mono text-[12px] text-text-primary focus:outline-none" spellCheck={false} />
                <button type="button" onClick={addEnv} className="flex items-center gap-1 text-accent-primary text-[12px]"><Plus size={12} strokeWidth={2.5} /> Add variable</button>
              </div>
            </div>
            <p className="text-text-tertiary text-[11px] mt-1.5 leading-relaxed">Values live in the OS credential store and are injected only into this agent's process at launch. Profiles and logs never see them.</p>
          </div>
        </>
        )}

        {error && (
          <div className="p-3 rounded-md bg-error/5 ring-1 ring-error/20"><p className="text-error text-[12px]">{error}</p></div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 p-3 border-t border-seam">
        <span className="font-mono text-[11px] text-text-tertiary truncate">{commandPreview}</span>
        <div className="flex items-center gap-2 flex-shrink-0">
          {editing && (confirmDelete
            ? <Button variant="ghost" onClick={handleDelete} className="text-error">Confirm delete</Button>
            : <Button variant="ghost" onClick={() => setConfirmDelete(true)}>Delete agent</Button>)}
          <Button variant="ghost" onClick={closeAddAgent}>Cancel</Button>
          {tab === 'cli' && <Button variant="primary" onClick={handleSave} loading={saving}>{editing ? 'Save' : 'Add Agent'}</Button>}
        </div>
      </div>
    </Modal>
  );
}
