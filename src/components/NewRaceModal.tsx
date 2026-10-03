import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, Flag, FolderOpen, Plus, Trash2 } from 'lucide-react';
import { allAgentSpecs, isCustomAgent, type AgentKind } from '../lib/agents';
import { CLAUDE_MODELS } from '../lib/claudeModels';
import { modelsForAgent } from '../lib/agentModels';
import { reportInvokeFailure } from '../lib/errorReporter';
import { knownRepoPaths, repoPathForTerminal, type TaskProfile } from '../lib/tasks';
import {
  MAX_CONTENDERS, MIN_CONTENDERS, averageContenderCost, contenderLabel, formatCost, launchRace, promptDeliveryFor,
  winRateFor, winRates, type RaceContenderInput,
} from '../lib/races';
import { useAppStore } from '../store/appStore';
import { useRaceStore } from '../store/raceStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { Modal } from './ui/Modal';

const INPUT = 'w-full bg-elevation-0 text-text-primary text-[13px] px-2.5 py-1.5 rounded-md ring-1 ring-border-light focus:ring-accent-primary outline-none';

/** Model choices for an agent: '' = the CLI's default (no --model flag). */
function modelOptions(kind: AgentKind): { value: string; label: string }[] {
  if (kind === 'claude') return CLAUDE_MODELS.filter((m) => m.alias !== 'default').map((m) => ({ value: m.alias, label: m.label }));
  return modelsForAgent(kind).map((m) => ({ value: m.alias, label: m.label }));
}

function defaultContenders(): RaceContenderInput[] {
  const kinds = allAgentSpecs().map((s) => s.kind);
  const second: AgentKind = kinds.includes('codex') ? 'codex' : 'claude';
  return [{ agent: 'claude', model: null }, { agent: second, model: second === 'claude' ? 'sonnet' : null }];
}

/**
 * New Race: one prompt, 2-4 agent/model contenders, each in its own task
 * worktree from the same base commit. Contenders open in a grid.
 */
export function NewRaceModal() {
  const close = useAppStore((s) => s.closeNewRaceModal);
  const presetRepo = useAppStore((s) => s.newRaceRepoPath);
  const presetPrompt = useAppStore((s) => s.newRacePrompt);
  const checkCommands = useAppStore((s) => s.raceCheckCommands);
  const races = useRaceStore((s) => s.races);
  const repoOptions = useMemo(() => knownRepoPaths(), []);
  const [repoPath, setRepoPath] = useState(
    () => presetRepo ?? repoPathForTerminal(useTerminalStore.getState().activeTerminalId) ?? repoOptions[0] ?? '',
  );
  const [title, setTitle] = useState(() => presetPrompt?.split('\n')[0].slice(0, 80) ?? '');
  const [prompt, setPrompt] = useState(presetPrompt ?? '');
  const [contenders, setContenders] = useState<RaceContenderInput[]>(defaultContenders);
  const [baseBranch, setBaseBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [checkCommand, setCheckCommand] = useState('');
  const [profiles, setProfiles] = useState<TaskProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const launching = useRef(false);
  const profile = profiles.find((p) => p.id === profileId) ?? null;

  const history = useMemo(() => Object.values(races), [races]);
  const rates = useMemo(() => winRates(history), [history]);
  const avgCost = useMemo(() => averageContenderCost(history), [history]);
  const specs = allAgentSpecs();

  useEffect(() => {
    let cancelled = false;
    invoke<TaskProfile[]>('get_profiles')
      .then((list) => { if (!cancelled) setProfiles(list.filter((p) => p.working_directory.trim() !== '')); })
      .catch((err) => reportInvokeFailure('get_profiles', err));
    return () => { cancelled = true; };
  }, []);

  // Remembered per repo; switching repos reloads it.
  useEffect(() => { setCheckCommand(checkCommands[repoPath] ?? ''); }, [repoPath, checkCommands]);

  useEffect(() => {
    let cancelled = false;
    setBranches([]);
    setCurrentBranch(null);
    setBaseBranch('');
    if (!repoPath) return;
    const handle = setTimeout(() => {
      invoke<{ current: string | null; branches: string[] }>('list_task_base_branches', { repoPath })
        .then((b) => { if (!cancelled) { setBranches(b.branches); setCurrentBranch(b.current); } })
        // Untrusted or not a repo yet (mid-typing): start_race reports the
        // real reason on submit, and "Current branch" still works.
        .catch(() => {});
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [repoPath]);

  useEffect(() => {
    if (profile) setRepoPath(profile.working_directory);
  }, [profile]);

  const browse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, defaultPath: repoPath || undefined });
      if (selected && typeof selected === 'string') setRepoPath(selected);
    } catch (err) {
      reportInvokeFailure('dialog_open_directory', err);
    }
  };

  const updateContender = (i: number, patch: Partial<RaceContenderInput>) =>
    setContenders((list) => list.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const submit = async () => {
    if (launching.current) return;
    launching.current = true;
    setBusy(true);
    setError('');
    try {
      useAppStore.getState().setRaceCheckCommand(repoPath, checkCommand);
      const result = await launchRace({
        repoPath, title: title.trim(), prompt, baseBranch, contenders, checkCommand, profile,
      });
      useRaceStore.getState().upsert(result.race);
      close();
      toast.success('Race started', result.staged.length > 0
        ? `${result.race.contenders.length} contenders are running. ${result.staged.length} could not take the task at start: use "Send to all waiting" once they are ready.`
        : `${result.race.contenders.length} contenders received the task.`);
    } catch (err) {
      // Validation and git refusals arrive as plain messages (user_err);
      // internal failures were reported by wrap_cmd / createTerminal.
      setError(String(err));
    } finally {
      launching.current = false;
      setBusy(false);
    }
  };

  const n = contenders.length;
  const canSubmit = !busy && repoPath.trim() !== '' && title.trim() !== '' && prompt.trim() !== ''
    && n >= MIN_CONTENDERS && n <= MAX_CONTENDERS;

  return (
    <Modal title="New Race" showHeader onClose={() => { if (!busy) close(); }} panelClassName="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
      <form className="p-4 flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); if (canSubmit) void submit(); }}>
        <p className="text-[12px] text-text-secondary">
          Send one task to {MIN_CONTENDERS}-{MAX_CONTENDERS} agents at once. Each works in its own worktree from the same commit; compare the results and merge the winner.
        </p>
        <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
          Race title
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Fix the login redirect loop" className={INPUT} disabled={busy} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
          Task prompt (sent to every contender)
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={7} disabled={busy}
            placeholder="Describe the task. Every contender gets exactly this text."
            className={`${INPUT} font-mono text-[12px] resize-y min-h-[120px]`} />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
            Repository
            <div className="flex gap-2">
              <input aria-label="Repository" list="new-race-repos" value={repoPath} onChange={(e) => setRepoPath(e.target.value)}
                placeholder="Path to a git repository" className={`${INPUT} font-mono text-[12px]`} disabled={busy} />
              <datalist id="new-race-repos">{repoOptions.map((r) => <option key={r} value={r} />)}</datalist>
              <button type="button" onClick={browse} disabled={busy} aria-label="Browse for repository"
                className="px-2 rounded-md ring-1 ring-border-light text-text-secondary hover:bg-fill-hover">
                <FolderOpen size={14} />
              </button>
            </div>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
            Launch settings
            <select aria-label="Profile" value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={busy} className={INPUT}>
              <option value="">Default agent arguments</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>Profile: {p.name}</option>)}
            </select>
          </label>
        </div>

        <fieldset disabled={busy} className="flex flex-col gap-2">
          <legend className="text-[12px] text-text-secondary mb-1">Contenders</legend>
          {contenders.map((c, i) => {
            const models = modelOptions(c.agent);
            const rate = winRateFor(rates, c.agent, c.model);
            const staged = promptDeliveryFor(c.agent) === 'staged';
            return (
              <div key={i} className="flex items-center gap-2">
                <span className="w-5 text-[11px] text-text-tertiary tabular-nums">{String.fromCharCode(65 + i)}</span>
                <select aria-label={`Contender ${i + 1} agent`} value={c.agent} className={`${INPUT} w-44`}
                  onChange={(e) => updateContender(i, { agent: e.target.value as AgentKind, model: null })}>
                  {specs.map((s) => <option key={s.kind} value={s.kind}>{s.displayName}</option>)}
                </select>
                {isCustomAgent(c.agent) || models.length === 0 ? (
                  <input aria-label={`Contender ${i + 1} model`} value={c.model ?? ''} placeholder="Model (optional)"
                    onChange={(e) => updateContender(i, { model: e.target.value || null })} className={`${INPUT} flex-1 font-mono text-[12px]`} />
                ) : (
                  <select aria-label={`Contender ${i + 1} model`} value={c.model ?? ''} className={`${INPUT} flex-1`}
                    onChange={(e) => updateContender(i, { model: e.target.value || null })}>
                    <option value="">Default model</option>
                    {models.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                )}
                <span className="w-36 text-[10.5px] text-text-tertiary leading-tight">
                  {rate ? `Won ${rate.wins}/${rate.races} past race(s)` : 'No past races'}
                  {staged && <span className="block text-warning">Task staged, send when ready</span>}
                </span>
                <button type="button" aria-label={`Remove ${contenderLabel(c.agent, c.model)}`} disabled={n <= MIN_CONTENDERS}
                  onClick={() => setContenders((list) => list.filter((_, j) => j !== i))}
                  className="p-1.5 rounded text-text-tertiary hover:text-error hover:bg-fill-hover disabled:opacity-30">
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
          {n < MAX_CONTENDERS && (
            <button type="button" onClick={() => setContenders((list) => [...list, { agent: 'claude', model: null }])}
              className="self-start flex items-center gap-1.5 px-2 h-7 rounded-md text-[12px] text-text-secondary hover:text-text-primary hover:bg-fill-hover">
              <Plus size={13} /> Add contender
            </button>
          )}
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
            Base branch
            <select value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} className={`${INPUT} font-mono text-[12px]`} disabled={busy}>
              <option value="">{currentBranch ? `Current branch (${currentBranch})` : 'Current branch'}</option>
              {branches.filter((b) => b !== currentBranch).map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
            Check command (optional, remembered for this repo)
            <input value={checkCommand} onChange={(e) => setCheckCommand(e.target.value)} placeholder="e.g. npm test"
              className={`${INPUT} font-mono text-[12px]`} disabled={busy} spellCheck={false} />
          </label>
        </div>

        <div className="flex items-start gap-2 rounded-lg ring-1 ring-warning/40 bg-warning/5 p-2.5 text-[12px] text-text-secondary">
          <AlertTriangle size={14} className="text-warning mt-0.5 flex-shrink-0" />
          <span>
            Cost scales with the number of contenders: {n} agents will each work on the full task.
            {avgCost && ` Past races averaged ${formatCost(avgCost.avg)} per contender (${avgCost.samples} measured).`}
          </span>
        </div>

        {error && <p role="alert" className="text-[12px] text-error whitespace-pre-wrap">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" disabled={busy} onClick={close} className="px-3 py-1.5 text-[13px] text-text-secondary">Cancel</button>
          <button type="submit" disabled={!canSubmit}
            className="px-4 py-1.5 rounded-lg bg-accent-primary text-white text-[13px] font-medium disabled:opacity-50 flex items-center gap-1.5">
            <Flag size={13} />
            {busy ? 'Creating worktrees...' : `Start race (${n})`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
