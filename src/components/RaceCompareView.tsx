import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import {
  CheckCircle2, ChevronDown, ChevronRight, CircleSlash, Gavel, GitCommitHorizontal, Loader2, Play, RefreshCw, Square,
  TimerOff, X, XCircle,
} from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useRaceStore } from '../store/raceStore';
import { useTerminalStore } from '../store/terminalStore';
import { useAgentRegistryStore } from '../store/agentRegistryStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { allAgentSpecs, type AgentKind } from '../lib/agents';
import { commitTaskChanges, resolveLaunchConfig } from '../lib/tasks';
import {
  CONTENDER_STATE_LABEL, buildFileMatrix, buildJudgePrompt, checkSummary, checkVerdict, formatCost, formatElapsed,
  formatTokens, getRaceFile, samePath, setRaceCheckCommand, type CheckVerdict, type Race, type RaceContender,
} from '../lib/races';
import { useRaceRows, type RaceRow } from '../hooks/useRaceRows';
import { languageFromPath } from './monacoSetup';
import { ContenderStateDot, RaceHeader } from './RaceHeader';
import { BrandIcon } from './BrandIcon';
import { Tooltip } from './ui/Tooltip';

const SECTION = 'rounded-xl ring-1 ring-inset ring-seam bg-elevation-1';
const TH = 'px-2.5 py-1.5 text-left text-[10.5px] font-medium uppercase tracking-wide text-text-tertiary';
const TD = 'px-2.5 py-1.5 text-[12px] text-text-primary tabular-nums';
const BTN = 'flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11.5px] font-medium ring-1 ring-inset ring-seam text-text-secondary hover:text-text-primary hover:bg-fill-hover disabled:opacity-50';
const letter = (i: number) => String.fromCharCode(65 + i);

/** A diff between two versions of one file: `base` or a contender worktree. */
interface DiffTarget {
  path: string;
  left: string;
  right: string;
}

const VERDICT_STYLE: Record<CheckVerdict, { cls: string; icon: React.ReactNode; text: string }> = {
  pass: { cls: 'text-success', icon: <CheckCircle2 size={12} />, text: 'Pass' },
  fail: { cls: 'text-error', icon: <XCircle size={12} />, text: 'Fail' },
  timeout: { cls: 'text-warning', icon: <TimerOff size={12} />, text: 'Timeout' },
  cancelled: { cls: 'text-text-tertiary', icon: <CircleSlash size={12} />, text: 'Cancelled' },
};

function sourceLabel(race: Race, source: string): string {
  if (source === 'base') return `${race.baseBranch} (base)`;
  const i = race.contenders.findIndex((c) => samePath(c.worktreePath, source));
  return i >= 0 ? `${letter(i)} · ${race.contenders[i].label}` : source;
}

/** Read-only Monaco diff. Owns model disposal the way FileEditorView does:
 *  detach the models from the widget before disposing them. */
function RaceDiffEditor({ race, target, onClose }: { race: Race; target: DiffTarget; onClose: () => void }) {
  const [sides, setSides] = useState<{ left: string | null; right: string | null } | null>(null);
  const [error, setError] = useState('');
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<editor.IDiffEditorModel | null>(null);
  const key = `${target.left}|${target.right}|${target.path}`;

  useEffect(() => {
    let cancelled = false;
    setSides(null);
    setError('');
    Promise.all([getRaceFile(race.id, target.left, target.path), getRaceFile(race.id, target.right, target.path)])
      .then(([left, right]) => { if (!cancelled) setSides({ left, right }); })
      // Binary / too large / gone: shown in place of the diff.
      .catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [race.id, target.left, target.right, target.path]);

  useEffect(() => () => {
    const models = modelsRef.current;
    modelsRef.current = null;
    try {
      editorRef.current?.setModel(null);
    } catch {
      // Widget already disposed: the models are detached either way.
    }
    editorRef.current = null;
    models?.original?.dispose();
    models?.modified?.dispose();
  }, [key]);

  const onMount: DiffOnMount = (ed) => {
    editorRef.current = ed;
    modelsRef.current = ed.getModel();
  };

  return (
    <section className={`${SECTION} overflow-hidden`} aria-label="File diff">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-seam">
        <span className="font-mono text-[12px] text-text-primary truncate">{target.path}</span>
        <span className="text-[11px] text-text-tertiary truncate">
          {sourceLabel(race, target.left)} → {sourceLabel(race, target.right)}
        </span>
        <button type="button" aria-label="Close diff" onClick={onClose} className="ml-auto p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-fill-hover">
          <X size={13} />
        </button>
      </div>
      <div className="h-[420px]">
        {error ? (
          <p role="alert" className="p-3 text-[12px] text-error">{error}</p>
        ) : !sides ? (
          <div className="p-3 flex items-center gap-2 text-[12px] text-text-secondary"><Loader2 size={13} className="animate-spin" /> Loading both versions...</div>
        ) : (
          <>
            {(sides.left === null || sides.right === null) && (
              <p className="px-3 py-1 text-[11px] text-text-tertiary border-b border-seam">
                {sides.left === null ? 'Not present on the left (added).' : 'Not present on the right (deleted).'}
              </p>
            )}
            <DiffEditor
              key={key}
              height="100%"
              language={languageFromPath(target.path)}
              original={sides.left ?? ''}
              modified={sides.right ?? ''}
              keepCurrentOriginalModel
              keepCurrentModifiedModel
              onMount={onMount}
              theme="vs-dark"
              options={{ readOnly: true, originalEditable: false, renderSideBySide: true, automaticLayout: true, scrollBeyondLastLine: false, minimap: { enabled: false } }}
            />
          </>
        )}
      </div>
    </section>
  );
}

function CheckCell({ row, expanded, onToggle }: { row: RaceRow; expanded: boolean; onToggle: () => void }) {
  if (row.check?.running) return <span className="flex items-center gap-1 text-text-secondary"><Loader2 size={12} className="animate-spin" /> Running</span>;
  if (row.check?.error) return <span className="text-error text-[11px]" title={row.check.error}>Error</span>;
  const verdict = checkVerdict(row.check?.result) ?? row.contender.stats?.check ?? null;
  if (!verdict) return <span className="text-text-tertiary">–</span>;
  const v = VERDICT_STYLE[verdict];
  return (
    <button type="button" onClick={onToggle} disabled={!row.check?.result} aria-expanded={expanded}
      className={`flex items-center gap-1 ${v.cls} disabled:cursor-default`}
      title={row.check?.result ? checkSummary(row.check.result) : undefined}>
      {v.icon} {v.text}
      {row.check?.result && (expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />)}
    </button>
  );
}

function CommitForm({ race, c, onDone }: { race: Race; c: RaceContender; onDone: () => void }) {
  const [message, setMessage] = useState(`${race.title} (${c.label})`);
  const [busy, setBusy] = useState(false);
  const commit = async () => {
    setBusy(true);
    try {
      await commitTaskChanges(c.worktreePath, message);
      toast.success('Committed', `${c.label}: changes committed on ${c.branch}.`);
      onDone();
    } catch (err) {
      toast.error('Commit failed', String(err));
      reportInvokeFailure('commit_task_changes', err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex gap-2 px-2.5 pb-2">
      <input aria-label={`Commit message for ${c.label}`} value={message} onChange={(e) => setMessage(e.target.value)} disabled={busy}
        className="flex-1 bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light" />
      <button type="button" onClick={commit} disabled={busy || !message.trim()}
        className="px-3 py-1 rounded bg-accent-primary text-white text-[12px] disabled:opacity-50">
        {busy ? 'Committing...' : 'Commit all'}
      </button>
    </div>
  );
}

/** Compare tab for one race: summary, per-file matrix, diffs, checks, judge. */
export function RaceCompareView({ raceId }: { raceId: string }) {
  const race = useRaceStore((s) => s.races[raceId]);
  const refresh = useRaceStore((s) => s.refresh);
  const loadDiffs = useRaceStore((s) => s.loadDiffs);
  const runChecks = useRaceStore((s) => s.runChecks);
  const cancelChecks = useRaceStore((s) => s.cancelChecks);
  const timeoutMin = useAppStore((s) => s.raceCheckTimeoutMin);
  const setTimeoutMin = useAppStore((s) => s.setRaceCheckTimeoutMin);
  const rows = useRaceRows(race);
  const [loadingDiffs, setLoadingDiffs] = useState(false);
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  const [expandedCheck, setExpandedCheck] = useState<number | null>(null);
  const [committing, setCommitting] = useState<number | null>(null);
  const [checkCommand, setCheckCommand] = useState('');
  const [pairA, setPairA] = useState(0);
  const [pairB, setPairB] = useState(1);
  const [pairFile, setPairFile] = useState('');
  const [judgeAgent, setJudgeAgent] = useState<AgentKind>('claude');
  const [showPrompt, setShowPrompt] = useState(false);

  const reload = useCallback(async () => {
    setLoadingDiffs(true);
    try {
      await loadDiffs(raceId);
    } finally {
      setLoadingDiffs(false);
    }
  }, [loadDiffs, raceId]);

  useEffect(() => { void refresh(raceId).then(() => reload()); }, [raceId, refresh, reload]);
  useEffect(() => { setCheckCommand(race?.checkCommand ?? ''); }, [race?.checkCommand]);

  const diffs = rows.map((r) => r.diff);
  const matrix = buildFileMatrix(diffs);
  const anyChecking = rows.some((r) => r.check?.running);
  const open = race?.status === 'running' || race?.status === 'judging';

  if (!race) {
    return <div className="h-full flex items-center justify-center text-[12px] text-text-secondary"><Loader2 size={14} className="animate-spin mr-2" /> Loading race...</div>;
  }

  const saveCheckCommand = async (): Promise<boolean> => {
    const cmd = checkCommand.trim();
    try {
      await setRaceCheckCommand(race.id, cmd || null);
      useAppStore.getState().setRaceCheckCommand(race.repoPath, cmd);
      useRaceStore.getState().upsert({ ...race, checkCommand: cmd || null });
      return true;
    } catch (err) {
      toast.error('Could not save the check command', String(err));
      reportInvokeFailure('set_race_check_command', err);
      return false;
    }
  };

  const startChecks = async () => {
    // Never fall back to the previously stored command when the edit failed.
    if (checkCommand.trim() !== (race.checkCommand ?? '') && !(await saveCheckCommand())) return;
    const latest = useRaceStore.getState().races[race.id] ?? race;
    if (!latest.checkCommand) {
      toast.error('No check command', 'Enter a command such as npm test first.');
      return;
    }
    await runChecks(latest, timeoutMin);
  };

  const askJudge = async () => {
    const prompt = buildJudgePrompt(race, diffs, rows.map((r) => r.check?.result));
    try {
      const launch = resolveLaunchConfig(judgeAgent, null, useAppStore.getState().defaultAgentArgs,
        useAgentRegistryStore.getState().defaultBindingsFor(judgeAgent));
      const name = `Judge: ${race.title}`;
      const id = await useTerminalStore.getState().createTerminal(
        name, race.repoPath, launch.args, launch.envVars, undefined, name, undefined, undefined, false, undefined,
        judgeAgent, launch.bindings,
      );
      // Staged, never typed: the user reviews it and sends when the CLI is ready.
      const app = useAppStore.getState();
      app.setPromptDraft(id, prompt);
      app.setActiveFilePath(null);
      app.openPromptEditor(id, prompt);
      toast.info('Judge ready', 'The comparison brief is in the prompt editor. Send it once the agent is ready.');
    } catch (err) {
      toast.error('Could not start the judge', String(err));
      // createTerminal already reported the IPC failure.
    }
  };

  const pairFiles = matrix.filter((m) => m.cells[pairA]?.touched || m.cells[pairB]?.touched).map((m) => m.path);
  const outcomeText = (c: RaceContender) => (c.outcome === 'pending' ? null : c.outcome === 'left' ? 'left as task' : c.outcome);

  return (
    <div className="h-full flex flex-col bg-elevation-0">
      <RaceHeader race={race} inCompare />
      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
        <section className={`${SECTION} px-3 py-2`}>
          <button type="button" onClick={() => setShowPrompt((v) => !v)} aria-expanded={showPrompt}
            className="flex items-center gap-1.5 text-[12px] text-text-secondary hover:text-text-primary w-full">
            {showPrompt ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Task · from <span className="font-mono text-text-primary">{race.baseBranch}</span>
            <span className="font-mono text-text-tertiary">@{race.baseSha.slice(0, 10)}</span>
            <span className="ml-auto flex items-center gap-1">
              <Tooltip label="Refresh diff stats">
                <span role="button" tabIndex={0} aria-label="Refresh diff stats"
                  onClick={(e) => { e.stopPropagation(); void reload(); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void reload(); } }}
                  className="p-1 rounded hover:bg-fill-hover">
                  <RefreshCw size={12} className={loadingDiffs ? 'animate-spin' : ''} />
                </span>
              </Tooltip>
            </span>
          </button>
          {showPrompt && <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono text-[12px] text-text-primary">{race.prompt}</pre>}
        </section>

        <section className={`${SECTION} overflow-x-auto`} aria-label="Summary">
          <table className="w-full">
            <thead>
              <tr className="border-b border-seam">
                <th className={TH}>Contender</th><th className={TH}>Status</th><th className={TH}>Time</th><th className={TH}>Cost</th>
                <th className={TH}>Tokens</th><th className={TH}>Files</th><th className={TH}>+/-</th><th className={TH}>Check</th>
                <th className={TH}>Commits</th><th className={TH} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const c = r.contender;
                const outcome = outcomeText(c);
                const winner = race.winnerTask && samePath(race.winnerTask, c.worktreePath);
                return (
                  <Fragment key={c.idx}>
                    <tr className="border-b border-seam last:border-0">
                      <td className={TD}>
                        <span className="flex items-center gap-1.5 min-w-0 max-w-[220px]">
                          <span className="text-text-tertiary w-3">{letter(i)}</span>
                          <BrandIcon kind={c.agent} size={13} />
                          <span className={`truncate ${winner ? 'font-semibold' : ''}`} title={c.branch}>{c.label}</span>
                        </span>
                      </td>
                      <td className={TD}>
                        <span className="flex items-center gap-1.5 whitespace-nowrap">
                          {outcome ? <span className="capitalize text-text-secondary">{outcome}</span> : (
                            <><ContenderStateDot state={r.state} /> {CONTENDER_STATE_LABEL[r.state]}</>
                          )}
                        </span>
                      </td>
                      <td className={TD}>{formatElapsed(r.elapsedMs ?? c.stats?.elapsedMs)}</td>
                      <td className={TD}>{formatCost(r.costUsd)}</td>
                      <td className={TD}>{formatTokens(r.tokens)}</td>
                      {/* Live numbers while the worktree exists, else the snapshot
                          recorded when the race was decided. */}
                      <td className={TD}>{r.diff?.exists ? r.diff.files.length : (c.stats?.filesChanged ?? '–')}</td>
                      <td className={`${TD} whitespace-nowrap`}>
                        <span className="text-success">+{r.diff?.exists ? r.diff.added : (c.stats?.added ?? 0)}</span>{' '}
                        <span className="text-error">-{r.diff?.exists ? r.diff.removed : (c.stats?.removed ?? 0)}</span>
                      </td>
                      <td className={TD}><CheckCell row={r} expanded={expandedCheck === i} onToggle={() => setExpandedCheck(expandedCheck === i ? null : i)} /></td>
                      <td className={`${TD} text-text-secondary whitespace-nowrap`}>
                        {r.diff?.exists ? `${r.diff.commits_ahead} ahead` : r.diff ? (open ? 'worktree gone' : 'removed') : '–'}
                        {r.diff && r.diff.uncommitted > 0 && (
                          <span className="block text-warning text-[11px]">{r.diff.uncommitted} uncommitted</span>
                        )}
                      </td>
                      <td className={TD}>
                        <span className="flex items-center justify-end gap-1">
                          {open && r.diff && r.diff.uncommitted > 0 && (
                            <Tooltip label="Commit the uncommitted changes first">
                              <button type="button" aria-label={`Commit ${c.label}`} onClick={() => setCommitting(committing === i ? null : i)}
                                className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-fill-hover">
                                <GitCommitHorizontal size={13} />
                              </button>
                            </Tooltip>
                          )}
                          {r.terminal && (
                            <button type="button" className="text-[11px] text-accent-primary hover:underline"
                              onClick={() => { useAppStore.getState().setActiveFilePath(null); useTerminalStore.getState().setActiveTerminal(r.terminal!.config.id); }}>
                              Session
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                    {committing === i && (
                      <tr><td colSpan={10}><CommitForm race={race} c={c} onDone={() => { setCommitting(null); void reload(); }} /></td></tr>
                    )}
                    {expandedCheck === i && r.check?.result && (
                      <tr><td colSpan={10} className="px-2.5 pb-2">
                        <pre className="max-h-56 overflow-auto rounded-md bg-elevation-0 ring-1 ring-seam p-2 font-mono text-[11px] text-text-secondary whitespace-pre-wrap">
                          {r.check.result.truncated ? '…\n' : ''}{r.check.result.output_tail || '(no output)'}
                        </pre>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </section>

        {open && (
          <section className={`${SECTION} px-3 py-2 flex flex-wrap items-center gap-2`} aria-label="Checks">
            <span className="text-[12px] text-text-secondary">Check</span>
            <input aria-label="Check command" value={checkCommand} onChange={(e) => setCheckCommand(e.target.value)}
              onBlur={() => { if (checkCommand.trim() !== (race.checkCommand ?? '')) void saveCheckCommand(); }}
              placeholder="e.g. npm test" spellCheck={false} disabled={anyChecking}
              className="flex-1 min-w-[200px] bg-elevation-0 text-text-primary font-mono text-[12px] px-2 py-1 rounded ring-1 ring-border-light" />
            <label className="flex items-center gap-1 text-[11.5px] text-text-secondary">
              Timeout
              <input aria-label="Check timeout in minutes" type="number" min={1} max={180} value={timeoutMin}
                onChange={(e) => setTimeoutMin(Number(e.target.value))} disabled={anyChecking}
                className="w-14 bg-elevation-0 text-text-primary text-[12px] px-1.5 py-1 rounded ring-1 ring-border-light tabular-nums" />
              min
            </label>
            {anyChecking ? (
              <button type="button" className={BTN} onClick={() => void cancelChecks(race)}><Square size={11} /> Cancel checks</button>
            ) : (
              <button type="button" className={BTN} onClick={() => void startChecks()} disabled={!checkCommand.trim()}>
                <Play size={11} /> Run checks
              </button>
            )}
            <span className="w-full text-[11px] text-text-tertiary">Runs in every contender's worktree in parallel. Only this command runs, nothing from the repository or the agents.</span>
          </section>
        )}

        <section className={`${SECTION} overflow-x-auto`} aria-label="Files changed">
          <div className="px-3 h-9 flex items-center text-[12px] text-text-secondary border-b border-seam">
            Files changed <span className="ml-1.5 text-text-tertiary">({matrix.length}) · click a cell for that contender's diff against the base</span>
          </div>
          {matrix.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-text-tertiary">{loadingDiffs ? 'Loading...' : 'No contender has changed any file yet.'}</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-seam">
                  <th className={TH}>File</th>
                  {race.contenders.map((c, i) => <th key={c.idx} className={`${TH} text-center`} title={c.label}>{letter(i)}</th>)}
                </tr>
              </thead>
              <tbody>
                {matrix.map((m) => (
                  <tr key={m.path} className="border-b border-seam last:border-0">
                    <td className={`${TD} font-mono text-[11.5px] max-w-[420px] truncate`} title={m.path}>{m.path}</td>
                    {m.cells.map((cell, i) => (
                      <td key={i} className="px-1 py-0.5 text-center">
                        {cell.touched ? (
                          <button type="button" aria-label={`Diff ${m.path} for ${race.contenders[i].label}`}
                            onClick={() => setDiffTarget({ path: m.path, left: 'base', right: race.contenders[i].worktreePath })}
                            className="w-full h-6 rounded-md hover:bg-fill-hover text-[11px] tabular-nums">
                            {cell.added == null ? 'bin' : (
                              <><span className="text-success">+{cell.added}</span> <span className="text-error">-{cell.removed}</span></>
                            )}
                            {cell.status === '??' && <span className="ml-1 text-text-tertiary">new</span>}
                          </button>
                        ) : <span className="text-text-tertiary">·</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {race.contenders.length >= 2 && matrix.length > 0 && (
          <section className={`${SECTION} px-3 py-2 flex flex-wrap items-center gap-2 text-[12px] text-text-secondary`} aria-label="Compare two contenders">
            Compare
            <select aria-label="Left contender" value={pairA} onChange={(e) => setPairA(Number(e.target.value))}
              className="bg-elevation-0 text-text-primary px-2 py-1 rounded ring-1 ring-border-light">
              {race.contenders.map((c, i) => <option key={c.idx} value={i}>{letter(i)} · {c.label}</option>)}
            </select>
            with
            <select aria-label="Right contender" value={pairB} onChange={(e) => setPairB(Number(e.target.value))}
              className="bg-elevation-0 text-text-primary px-2 py-1 rounded ring-1 ring-border-light">
              {race.contenders.map((c, i) => <option key={c.idx} value={i}>{letter(i)} · {c.label}</option>)}
            </select>
            <select aria-label="File to compare" value={pairFile} onChange={(e) => setPairFile(e.target.value)}
              className="flex-1 min-w-[200px] bg-elevation-0 text-text-primary font-mono text-[11.5px] px-2 py-1 rounded ring-1 ring-border-light">
              <option value="">Choose a file...</option>
              {pairFiles.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <button type="button" className={BTN} disabled={!pairFile || pairA === pairB}
              onClick={() => setDiffTarget({ path: pairFile, left: race.contenders[pairA].worktreePath, right: race.contenders[pairB].worktreePath })}>
              Side by side
            </button>
          </section>
        )}

        {diffTarget && <RaceDiffEditor race={race} target={diffTarget} onClose={() => setDiffTarget(null)} />}

        <section className={`${SECTION} px-3 py-2 flex flex-wrap items-center gap-2 text-[12px] text-text-secondary`} aria-label="Ask a judge">
          <Gavel size={13} className="text-text-tertiary" />
          Ask a judge
          <select aria-label="Judge agent" value={judgeAgent} onChange={(e) => setJudgeAgent(e.target.value as AgentKind)}
            className="bg-elevation-0 text-text-primary px-2 py-1 rounded ring-1 ring-border-light">
            {allAgentSpecs().map((s) => <option key={s.kind} value={s.kind}>{s.displayName}</option>)}
          </select>
          <button type="button" className={BTN} onClick={() => void askJudge()}>Open judge session</button>
          <span className="w-full text-[11px] text-text-tertiary">
            Opens a new session in {race.repoPath} with a comparison brief (task, each contender's numstat, check results, worktree paths) staged in its prompt editor. Advisory only: it never merges anything.
          </span>
        </section>
      </div>
    </div>
  );
}

