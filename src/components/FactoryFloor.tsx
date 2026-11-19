import { useEffect, useState } from 'react';
import { CheckCircle2, Factory as FactoryIcon, History, Plus, ScanSearch, XCircle } from 'lucide-react';
import { EmptyState } from './ui/EmptyState';
import { Tooltip } from './ui/Tooltip';
import { useFactoryStore, hasLiveSession, runsForFactory } from '../store/factoryStore';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { confirmAction } from '../lib/confirmDialog';
import { focusTerminal } from '../lib/raceActions';
import { formatElapsed } from '../lib/races';
import { useNowTick } from '../hooks/useNowTick';
import {
  currentStep, getFactoryRunEvents, isOpenRun, needsYou, runStatusText, stepCounts, trackFor,
  type Definition, type Factory, type FactoryRun, type RunControl, type RunEventRow, type RunStatus, type TrackCell,
} from '../lib/factory';

const ATTENTION = 'var(--attention-input)';

const STATUS_DOT: Record<RunStatus, string> = {
  queued: 'bg-text-tertiary',
  running: 'bg-accent-primary animate-pulse',
  checking: 'bg-accent-primary animate-pulse',
  waiting_gate: '',
  blocked: 'bg-error',
  done: 'bg-success',
  cancelled: 'bg-text-tertiary',
};

const CELL_CLASS: Record<TrackCell, string> = {
  done: 'bg-success/75',
  current: 'bg-accent-primary',
  'needs-you': '',
  blocked: 'bg-error',
  todo: 'bg-elevation-3',
};

const BTN = 'flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11.5px] font-medium flex-shrink-0 disabled:opacity-50';
const PRIMARY_BTN = `${BTN} bg-accent-primary text-white hover:bg-accent-secondary`;
const ICON_BTN = 'flex items-center justify-center h-6 w-6 rounded text-text-tertiary hover:text-text-primary hover:bg-fill-hover disabled:opacity-40 disabled:hover:bg-transparent';

/** A user-initiated control: the store rethrows and shows nothing, so the toast is ours. */
function runControl(runId: string, op: RunControl, title: string) {
  useFactoryStore.getState().control(runId, op).catch((err) => {
    toast.error(title, String(err));
    reportInvokeFailure('control_factory_run', err);
  });
}

function relativePath(repoPath: string, sourcePath: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const repo = norm(repoPath).replace(/\/+$/, '');
  const src = norm(sourcePath);
  return src.toLowerCase().startsWith(`${repo.toLowerCase()}/`) ? src.slice(repo.length + 1) : src;
}

function lastLines(text: string, n: number): string {
  return text.trimEnd().split('\n').slice(-n).join('\n');
}

function Diamond({ color, className = '' }: { color?: string; className?: string }) {
  return <span aria-hidden className={`inline-block rotate-45 ${className}`} style={color ? { background: color } : undefined} />;
}

function LineStrip({ def, runs }: { def: Definition; runs: FactoryRun[] }) {
  const counts = stepCounts(def, runs);
  return (
    <div className="px-4 py-3 border-b border-seam bg-elevation-0 flex items-center gap-2 overflow-x-auto scrollbar-none" data-factory-line>
      {def.steps.map((step, i) => {
        const count = counts[step.id] ?? 0;
        return (
          <div key={step.id} className="flex items-center gap-2 flex-shrink-0">
            {i > 0 && <span aria-hidden className="w-5 h-px bg-seam" />}
            {step.kind === 'station' ? (
              <div data-testid={`line-${step.id}`}
                className="relative flex flex-col px-3 py-1.5 rounded-lg ring-1 ring-inset ring-seam bg-elevation-2 min-w-[96px]">
                <span className="text-[12px] font-medium text-text-primary">{step.name}</span>
                <span className="text-[10.5px] text-text-tertiary font-mono">{step.id}</span>
                {count > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-[16px] px-1 rounded-full bg-accent-primary text-white text-[10px] flex items-center justify-center tabular-nums">{count}</span>
                )}
              </div>
            ) : (
              <div data-testid={`line-${step.id}`} className="relative flex items-center gap-2 px-1" title={step.name}>
                <Diamond className="w-3 h-3 ring-1 ring-inset ring-seam bg-elevation-2" color={count > 0 ? ATTENTION : undefined} />
                <span className="flex flex-col">
                  <span className="text-[10.5px] text-text-tertiary font-mono">{step.id}</span>
                  <span className="text-[11px] text-text-secondary">{step.name}</span>
                </span>
                {count > 0 && (
                  <span className="min-w-[16px] h-[16px] px-1 rounded-full text-white text-[10px] flex items-center justify-center tabular-nums" style={{ background: ATTENTION }}>{count}</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RunTrack({ run }: { run: FactoryRun }) {
  return (
    <div className="flex items-center gap-1" aria-hidden>
      {trackFor(run).map(({ step, cell }) => {
        const style = cell === 'needs-you' ? { background: ATTENTION } : undefined;
        return step.kind === 'station'
          ? <span key={step.id} className={`h-[3px] w-5 rounded-full ${CELL_CLASS[cell]}`} style={style} />
          : <Diamond key={step.id} className={`w-[7px] h-[7px] ${CELL_CLASS[cell]}`} color={cell === 'needs-you' ? ATTENTION : undefined} />;
      })}
    </div>
  );
}

/** Local wall-clock time of an event, `HH:MM`. */
function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

type History = { state: 'loading' } | { state: 'error' } | { state: 'ok'; events: RunEventRow[] };

/** The run's logged transitions, re-loaded whenever the run changes. */
function RunHistory({ run }: { run: FactoryRun }) {
  const [history, setHistory] = useState<History>({ state: 'loading' });
  useEffect(() => {
    let cancelled = false;
    getFactoryRunEvents(run.id)
      .then((events) => { if (!cancelled) setHistory({ state: 'ok', events }); })
      .catch((err) => {
        if (!cancelled) setHistory({ state: 'error' });
        reportInvokeFailure('get_factory_run_events', err);
      });
    return () => { cancelled = true; };
  }, [run.id, run.updatedAt]);

  if (history.state === 'error') {
    return <p className="px-3 pb-2 pl-8 text-[11.5px] text-error">Could not load the history.</p>;
  }
  if (history.state === 'loading') {
    return <p role="status" className="px-3 pb-2 pl-8 text-[11.5px] text-text-tertiary">Loading...</p>;
  }
  return (
    <ul aria-label="Run history" className="px-3 pb-2 pl-8 flex flex-col gap-0.5">
      {history.events.map((e, i) => (
        <li key={i} className="flex items-center gap-2 text-[11px] text-text-secondary min-w-0">
          <span className="tabular-nums text-text-tertiary flex-shrink-0">{clockTime(e.at)}</span>
          <span className="font-mono flex-shrink-0">{e.stepId}</span>
          <span className="flex-shrink-0 text-text-primary">{e.kind.replace(/_/g, ' ')}</span>
          {e.detail && <span className="truncate min-w-0" title={e.detail}>{e.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

function RunRow({ run, now }: { run: FactoryRun; now: number }) {
  const [showHistory, setShowHistory] = useState(false);
  const evaluating = useFactoryStore((s) => !!s.evaluating[run.id]);
  const live = hasLiveSession(run);
  const step = currentStep(run);
  const open = isOpenRun(run);
  const noCheckNoArtifact = step?.kind === 'station' && !step.check && !step.artifact;
  const checkLabel = noCheckNoArtifact ? 'Mark done' : 'Check now';

  const cancel = async () => {
    const ok = await confirmAction('Cancel this run? Its session closes. Files it changed stay where they are.', { okLabel: 'Cancel run' });
    if (ok) runControl(run.id, 'cancel', 'Could not cancel the run');
  };

  let action: React.ReactNode = null;
  if (run.status === 'waiting_gate') {
    action = <button type="button" className={PRIMARY_BTN} onClick={() => useAppStore.getState().openFactoryGate(run.id)}>Review</button>;
  } else if (run.status === 'running' && live) {
    action = <button type="button" className={PRIMARY_BTN} onClick={() => run.terminalId && focusTerminal(run.terminalId)}>Open</button>;
  } else if ((run.status === 'running' || run.status === 'checking') && evaluating) {
    action = <button type="button" disabled className={`${BTN} ring-1 ring-inset ring-seam text-text-secondary`}>Checking...</button>;
  } else if (run.status === 'running' || run.status === 'checking') {
    action = <button type="button" className={PRIMARY_BTN} onClick={() => runControl(run.id, 'resume', 'Could not continue the run')}>Continue</button>;
  } else if (run.status === 'blocked') {
    action = <button type="button" className={`${BTN} text-text-primary ring-1 ring-inset ring-seam hover:bg-fill-hover`} onClick={() => runControl(run.id, 'allow_retry', 'Could not allow another round')}>Allow 1 more round</button>;
  }

  return (
    <div data-testid={`run-${run.id}`} className="border-b border-seam">
      <div className="group flex items-center gap-3 px-3 py-2">
        <span aria-hidden className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[run.status]}`}
          style={run.status === 'waiting_gate' ? { background: ATTENTION } : undefined} />
        <span className="font-mono text-[12px] text-text-primary w-[120px] truncate flex-shrink-0" title={run.input}>{run.input}</span>
        <RunTrack run={run} />
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-[12px] text-text-primary truncate">{runStatusText(run)}</span>
          <span className="text-[10.5px] text-text-tertiary tabular-nums">{formatElapsed(now - Date.parse(run.updatedAt))}</span>
        </div>
        {open && (
          <span className="flex items-center opacity-60 group-hover:opacity-100 focus-within:opacity-100">
            {run.status === 'running' && (
              <Tooltip label={checkLabel}>
                <button type="button" aria-label={checkLabel} disabled={evaluating} className={ICON_BTN}
                  onClick={() => void useFactoryStore.getState().evaluate(run.id, true)}>
                  {noCheckNoArtifact ? <CheckCircle2 size={13} /> : <ScanSearch size={13} />}
                </button>
              </Tooltip>
            )}
            <Tooltip label="Cancel run">
              <button type="button" aria-label="Cancel run" className={`${ICON_BTN} hover:!text-error`} onClick={() => void cancel()}>
                <XCircle size={13} />
              </button>
            </Tooltip>
          </span>
        )}
        <Tooltip label={showHistory ? 'Hide history' : 'Show history'}>
          <button type="button" aria-label={showHistory ? 'Hide history' : 'Show history'} aria-expanded={showHistory}
            className={`${ICON_BTN} flex-shrink-0`} onClick={() => setShowHistory((v) => !v)}>
            <History size={13} />
          </button>
        </Tooltip>
        <span className="flex-shrink-0 min-w-[110px] flex justify-end">{action}</span>
      </div>
      {showHistory && <RunHistory run={run} />}
    </div>
  );
}

function NeedsYouCard({ run, now }: { run: FactoryRun; now: number }) {
  const step = currentStep(run);
  const gate = run.status === 'waiting_gate';
  return (
    <div className={`rounded-lg ring-1 ring-inset ring-seam bg-elevation-2 p-2.5 flex flex-col gap-1.5 border-l-[3px] ${gate ? '' : 'border-l-error'}`}
      style={gate ? { borderLeftColor: ATTENTION } : undefined}>
      <div className="flex items-center gap-2 text-[10.5px] text-text-tertiary">
        <span className="font-mono text-text-primary text-[11.5px] truncate">{run.input}</span>
        <span className="ml-auto tabular-nums">{formatElapsed(now - Date.parse(run.updatedAt))}</span>
      </div>
      {gate ? (
        <>
          <p className="text-[12px] text-text-primary leading-[1.4]">{step?.kind === 'gate' ? step.question : runStatusText(run)}</p>
          <div>
            <button type="button" className={PRIMARY_BTN} onClick={() => useAppStore.getState().openFactoryGate(run.id)}>Review</button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[12px] text-text-primary">{`Blocked at ${step?.name ?? run.currentStep}`}</p>
          {run.checkOutput.trim() && (
            <pre className="text-[10.5px] font-mono text-text-secondary whitespace-pre-wrap break-words max-h-[64px] overflow-hidden">{lastLines(run.checkOutput, 3)}</pre>
          )}
        </>
      )}
    </div>
  );
}

function DiskStrip({ factory }: { factory: Factory }) {
  if (factory.diskState === 'same') return null;
  const text = factory.diskState === 'missing'
    ? 'The definition file is gone from the repo. Runs keep using the saved copy.'
    : 'Definition changed on disk. Review it before new runs use it.';
  return (
    <div className="px-3 py-1.5 border-b border-seam bg-warning/10 flex items-center gap-3 text-[12px] text-text-primary">
      <span className="flex-1 min-w-0">{text}</span>
      <button type="button" className={`${BTN} ring-1 ring-inset ring-seam hover:bg-fill-hover`}
        onClick={() => useAppStore.getState().openAddFactoryModal()}>Review</button>
    </div>
  );
}

/** Main-area view of one factory: its line, its runs and what is waiting for the user. */
export function FactoryFloor({ factoryId }: { factoryId: string }) {
  const factory = useFactoryStore((s) => s.factories[factoryId]);
  const allRuns = useFactoryStore((s) => s.runs);
  // Re-render when sessions open or close so Open / Continue stay accurate.
  useTerminalStore((s) => s.terminals);
  const now = useNowTick();

  if (!factory) {
    return <EmptyState icon={<FactoryIcon size={20} />} title="This factory was removed" />;
  }
  const runs = runsForFactory(allRuns, factoryId);
  const waiting = runs.filter(needsYou);
  const newRun = () => useAppStore.getState().openNewFactoryRun(factoryId);
  const newRunButton = (
    <button type="button" className={PRIMARY_BTN} onClick={newRun}><Plus size={12} /> New run</button>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-elevation-0" data-factory-floor>
      <div className="px-3 py-1.5 border-b border-seam bg-elevation-1 flex items-center gap-3 min-w-0">
        <FactoryIcon size={13} className="flex-shrink-0" strokeWidth={1.9} style={{ color: 'var(--nav-factory)' }} />
        <span className="text-[12.5px] font-medium text-text-primary max-w-[240px] truncate" title={factory.name}>{factory.name}</span>
        <span className="text-[10.5px] px-1.5 h-[16px] flex items-center rounded-md bg-fill-active text-text-secondary font-mono truncate max-w-[320px]">
          {relativePath(factory.repoPath, factory.sourcePath)}
        </span>
        <div className="ml-auto flex items-center gap-1 flex-shrink-0">{newRunButton}</div>
      </div>
      <DiskStrip factory={factory} />
      <LineStrip def={factory.definition} runs={runs} />
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 overflow-y-auto">
          {runs.length === 0 ? (
            <EmptyState
              icon={<FactoryIcon size={20} />}
              title="No runs yet"
              description={`Start a run to send one ${factory.definition.input.label.toLowerCase()} down the line.`}
              action={newRunButton}
            />
          ) : (
            runs.map((run) => <RunRow key={run.id} run={run} now={now} />)
          )}
        </div>
        <div data-testid="needs-you" className="w-[292px] flex-shrink-0 border-l border-seam bg-elevation-1 overflow-y-auto p-3 flex flex-col gap-2">
          <h3 className="text-[11.5px] font-medium text-text-secondary">{`Needs you (${waiting.length})`}</h3>
          {waiting.length === 0
            ? <EmptyState compact title="Nothing is waiting for you" />
            : waiting.map((run) => <NeedsYouCard key={run.id} run={run} now={now} />)}
        </div>
      </div>
    </div>
  );
}
