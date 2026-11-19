import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen } from 'lucide-react';
import { reportInvokeFailure } from '../lib/errorReporter';
import {
  beginFactoryImport, listFactoryCandidates, pollFactoryImport, readFactoryDefinitionFile, saveFactory,
  type DefinitionReview, type FactoryCandidate, type LintItem,
} from '../lib/factory';
import { launchImportSession } from '../lib/factoryActions';
import { knownRepoPaths, repoPathForTerminal } from '../lib/tasks';
import { useAppStore } from '../store/appStore';
import { useFactoryStore } from '../store/factoryStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { Modal } from './ui/Modal';

const FIELD = 'bg-elevation-0 text-text-primary text-[13px] px-2.5 py-1.5 rounded-md ring-1 ring-border-light focus:ring-accent-primary outline-none';
const INPUT = `w-full ${FIELD}`;
const BTN = 'px-3 h-8 rounded-md text-[12px] ring-1 ring-border-light text-text-secondary hover:bg-fill-hover disabled:opacity-40';
const BTN_PRIMARY = 'px-3 h-8 rounded-md text-[12px] bg-accent-primary text-white disabled:opacity-40';
const TAG = 'text-[10.5px] px-1.5 py-0.5 rounded bg-fill-hover text-text-tertiary';

const POLL_MS = 2000;
const IMPORT_TIMEOUT_MS = 5 * 60 * 1000;
const STEPS = ['Repo', 'Factory file', 'Check what Agentrium understood', 'Ready'];

function LintList({ items, tone }: { items: LintItem[]; tone: 'error' | 'warning' }) {
  if (items.length === 0) return null;
  return (
    <ul className={`flex flex-col gap-1 text-[12px] ${tone === 'error' ? 'text-error' : 'text-warning'}`}>
      {items.map((it, i) => (
        <li key={i}>{it.step_id ? `${it.step_id}: ` : ''}{it.message}</li>
      ))}
    </ul>
  );
}

/**
 * Add a factory: pick a repo and a Markdown file, let an agent read it when
 * it has no definition yet, review what was understood, then confirm.
 */
export function AddFactoryModal() {
  const close = useAppStore((s) => s.closeAddFactoryModal);
  const repoOptions = useMemo(() => knownRepoPaths(), []);
  const [step, setStep] = useState(1);
  const [repoPath, setRepoPath] = useState(
    () => repoPathForTerminal(useTerminalStore.getState().activeTerminalId) ?? repoOptions[0] ?? '',
  );
  const [candidates, setCandidates] = useState<FactoryCandidate[]>([]);
  const [sourcePath, setSourcePath] = useState('');
  const [review, setReview] = useState<DefinitionReview | null>(null);
  const [fromAgent, setFromAgent] = useState(false);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const working = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const giveUpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped whenever polling stops, so a poll already in flight is ignored.
  const pollGen = useRef(0);

  const stopPolling = useCallback(() => {
    pollGen.current += 1;
    if (pollTimer.current) clearInterval(pollTimer.current);
    if (giveUpTimer.current) clearTimeout(giveUpTimer.current);
    pollTimer.current = null;
    giveUpTimer.current = null;
    setImporting(false);
  }, []);
  // False after unmount: async steps must not start timers or set state then.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stopPolling(); };
  }, [stopPolling]);

  const browseRepo = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, defaultPath: repoPath || undefined });
      if (selected && typeof selected === 'string') setRepoPath(selected);
    } catch (err) {
      reportInvokeFailure('dialog_open_directory', err);
    }
  };

  const browseFile = async () => {
    try {
      const selected = await open({ multiple: false, filters: [{ name: 'Markdown', extensions: ['md'] }], defaultPath: repoPath || undefined });
      if (selected && typeof selected === 'string') {
        const rel = selected.replace(/\\/g, '/').startsWith(repoPath.replace(/\\/g, '/').replace(/\/$/, '') + '/')
          ? selected.slice(repoPath.length).replace(/^[\\/]/, '') : selected;
        setCandidates((list) => (list.some((c) => c.path === selected) ? list : [...list, { path: selected, relPath: rel, hasDefinition: false }]));
        setSourcePath(selected);
      }
    } catch (err) {
      reportInvokeFailure('dialog_open_file', err);
    }
  };

  const toReview = (r: DefinitionReview, agent: boolean) => {
    stopPolling();
    setReview(r);
    setFromAgent(agent);
    setStep(3);
  };

  const nextFromRepo = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const list = await listFactoryCandidates(repoPath.trim());
      if (!mounted.current) return;
      setCandidates(list);
      setSourcePath(list[0]?.path ?? '');
      setStep(2);
    } catch (err) {
      if (!mounted.current) return;
      setError(String(err));
      reportInvokeFailure('list_factory_candidates', err);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const startPolling = (importId: string) => {
    const gen = pollGen.current;
    pollTimer.current = setInterval(() => {
      pollFactoryImport(importId)
        .then((r) => { if (r && gen === pollGen.current) toReview(r, true); })
        .catch(() => { /* poller: the next tick retries */ });
    }, POLL_MS);
    giveUpTimer.current = setTimeout(() => {
      stopPolling();
      setError('No definition was written. Open the "Factory import" session to see what happened, then try again.');
    }, IMPORT_TIMEOUT_MS);
  };

  const nextFromFile = async () => {
    if (working.current || !sourcePath) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      let existing: DefinitionReview | null;
      try {
        existing = await readFactoryDefinitionFile(repoPath.trim(), sourcePath);
      } catch (err) {
        if (!mounted.current) return;
        setError(String(err));
        reportInvokeFailure('read_factory_definition_file', err);
        return;
      }
      if (!mounted.current) return;
      if (existing) { toReview(existing, false); return; }
      let ticket;
      try {
        ticket = await beginFactoryImport(repoPath.trim(), sourcePath);
      } catch (err) {
        if (!mounted.current) return;
        setError(String(err));
        reportInvokeFailure('begin_factory_import', err);
        return;
      }
      if (!mounted.current) return;
      try {
        await launchImportSession(repoPath.trim(), ticket.prompt, 'claude');
      } catch (err) {
        if (!mounted.current) return;
        setError(String(err));
        reportInvokeFailure('create_terminal', err);
        return;
      }
      if (!mounted.current) return;
      setImporting(true);
      startPolling(ticket.importId);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (working.current || !review?.definition || review.lint.errors.length > 0) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const factory = await saveFactory(repoPath.trim(), sourcePath, review.definition, fromAgent);
      useFactoryStore.getState().upsertFactory(factory);
      close();
      useAppStore.getState().openFactoryTab(factory.id, factory.name);
      toast.success('Factory added', factory.name);
    } catch (err) {
      setError(String(err));
      reportInvokeFailure('save_factory', err);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const back = () => {
    setError('');
    if (step === 3) { setReview(null); setStep(2); } else if (step === 2) setStep(1);
  };

  const def = review?.definition ?? null;
  const hasCheck = def?.steps.some((s) => s.kind === 'station' && s.check) ?? false;
  const lintErrors = review?.lint.errors ?? [];

  return (
    <Modal title="Add a factory" showHeader onClose={() => { if (!busy) { stopPolling(); close(); } }}
      closeOn="none" closeOnEscape={false}
      panelClassName="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
      <div className="p-4 flex flex-col gap-3.5">
        <ol className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
          {STEPS.map((label, i) => (
            <li key={label} aria-current={i + 1 === Math.min(step, 3) ? 'step' : undefined}
              className={i + 1 === Math.min(step, 3) ? 'text-text-primary font-medium' : 'text-text-tertiary'}>
              {i + 1}. {label}
            </li>
          ))}
        </ol>

        {step === 1 && (
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
            Repository
            <div className="flex gap-2">
              <input autoFocus aria-label="Repository" list="add-factory-repos" value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)} placeholder="Path to a git repository"
                className={`${INPUT} font-mono text-[12px]`} disabled={busy} />
              <datalist id="add-factory-repos">{repoOptions.map((r) => <option key={r} value={r} />)}</datalist>
              <button type="button" onClick={browseRepo} disabled={busy}
                className="flex items-center gap-1.5 px-2.5 rounded-md ring-1 ring-border-light text-[12px] text-text-secondary hover:bg-fill-hover">
                <FolderOpen size={14} /> Browse
              </button>
            </div>
          </label>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-2 text-[12px]">
            {candidates.length === 0 ? (
              <p className="text-text-secondary">No factory files found. Put a Markdown file under .agentrium/ or .claude/skills/&lt;name&gt;/SKILL.md.</p>
            ) : (
              <fieldset disabled={busy || importing} className="flex flex-col gap-1">
                <legend className="text-text-secondary mb-1">Factory file</legend>
                {candidates.map((c) => (
                  <label key={c.path} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-fill-hover cursor-pointer">
                    <input type="radio" name="factory-file" checked={sourcePath === c.path} onChange={() => setSourcePath(c.path)} />
                    <span className="font-mono text-text-primary">{c.relPath}</span>
                    {c.hasDefinition && <span className={TAG}>already set up</span>}
                  </label>
                ))}
              </fieldset>
            )}
            <button type="button" onClick={browseFile} disabled={busy || importing} className={`${BTN} self-start`}>
              Browse for a file
            </button>
            {importing && (
              <p className="text-text-secondary">
                Your agent is reading the file. This usually takes under a minute. You can watch it in the session &quot;Factory import&quot;.
              </p>
            )}
          </div>
        )}

        {step === 3 && review && (
          <div className="flex flex-col gap-3 text-[12px]">
            {review.parseError || !def ? (
              <p className="text-error whitespace-pre-wrap">{review.parseError ?? 'The file could not be read.'}</p>
            ) : (
              <>
                <h3 className="text-[13px] text-text-primary font-medium">{def.name}</h3>
                <LintList items={review.lint.errors} tone="error" />
                <LintList items={review.lint.warnings} tone="warning" />
                {hasCheck && (
                  <p className="rounded-lg ring-1 ring-warning/40 bg-warning/5 p-2.5 text-text-secondary">
                    These commands will run on your machine when a station finishes. Read them before you confirm.
                  </p>
                )}
                <ol className="flex flex-col gap-2">
                  {def.steps.map((s) => (
                    <li key={s.id} className="rounded-md ring-1 ring-border-light p-2 flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-text-tertiary">{s.id}</span>
                        <span className="text-text-primary">{s.name}</span>
                        <span className={TAG}>{s.kind}</span>
                      </div>
                      {s.kind === 'station' && s.artifact && (
                        <div className="text-text-secondary">Artifact: <span className="font-mono">{s.artifact}</span></div>
                      )}
                      {s.kind === 'station' && s.check && (
                        <pre className="font-mono text-[11.5px] bg-elevation-0 rounded p-1.5 whitespace-pre-wrap">{s.check.command}</pre>
                      )}
                    </li>
                  ))}
                </ol>
                <div className="text-text-secondary">Input: {def.input.label}</div>
                <div className="text-text-secondary">
                  {def.workspace === 'worktree' ? 'One worktree per run' : 'Works in the repo folder, one run at a time'}
                </div>
                {def.rules.length > 0 && (
                  <div>
                    <div className="text-text-secondary mb-1">Rules given to the agent (not enforced)</div>
                    <ul className="list-disc pl-5 text-text-primary">
                      {def.rules.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {error && <p role="alert" className="text-[12px] text-error whitespace-pre-wrap">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          {importing ? (
            <button type="button" onClick={stopPolling} className={BTN}>Cancel</button>
          ) : (
            <>
              <button type="button" onClick={() => { stopPolling(); close(); }} disabled={busy} className={BTN}>Cancel</button>
              {step > 1 && <button type="button" onClick={back} disabled={busy} className={BTN}>Back</button>}
              {step === 1 && (
                <button type="button" onClick={() => void nextFromRepo()} disabled={busy || repoPath.trim() === ''} className={BTN_PRIMARY}>Next</button>
              )}
              {step === 2 && (
                <button type="button" onClick={() => void nextFromFile()} disabled={busy || !sourcePath} className={BTN_PRIMARY}>Next</button>
              )}
              {step === 3 && def && (
                <button type="button" onClick={() => void confirm()} disabled={busy || lintErrors.length > 0} className={BTN_PRIMARY}>Confirm</button>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
