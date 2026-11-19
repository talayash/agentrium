import { Factory as FactoryIcon } from 'lucide-react';
import { useFactoryStore, hasLiveSession } from '../store/factoryStore';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { focusTerminal } from '../lib/raceActions';
import { currentStep, isOpenRun, needsYou, type Factory, type FactoryRun } from '../lib/factory';

const ATTENTION = 'var(--attention-input)';
const MAX_ROWS = 5;

/** Short right-aligned status for a sidebar row. */
function shortStatus(run: FactoryRun): { text: string; tone: 'attention' | 'error' | 'plain' } {
  const name = currentStep(run)?.name ?? run.currentStep;
  switch (run.status) {
    case 'waiting_gate': return { text: `${run.currentStep} needs you`, tone: 'attention' };
    case 'blocked': return { text: `${name} blocked`, tone: 'error' };
    case 'queued': return { text: 'Queued', tone: 'plain' };
    default: return { text: name, tone: 'plain' };
  }
}

function RunRow({ run, factory }: { run: FactoryRun; factory: Factory }) {
  const status = shortStatus(run);
  const onClick = () => {
    const app = useAppStore.getState();
    if (run.status === 'waiting_gate') app.openFactoryGate(run.id);
    else if (hasLiveSession(run) && run.terminalId) focusTerminal(run.terminalId);
    else app.openFactoryTab(factory.id, factory.name);
  };
  const dot =
    run.status === 'waiting_gate' ? '' :
    run.status === 'blocked' ? 'bg-error' :
    run.status === 'queued' ? 'bg-text-tertiary' : 'bg-accent-primary animate-pulse';
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="w-full flex items-center gap-1.5 px-2.5 h-6 text-left text-[11.5px] text-text-secondary hover:bg-fill-hover hover:text-text-primary"
      >
        <span aria-hidden className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`}
          style={run.status === 'waiting_gate' ? { background: ATTENTION } : undefined} />
        <span className="font-mono truncate">{run.input}</span>
        <span
          className={`ml-auto pl-2 flex-shrink-0 max-w-[50%] truncate text-[10.5px] ${
            status.tone === 'attention' ? 'font-semibold' : status.tone === 'error' ? 'text-error' : 'text-text-tertiary'
          }`}
          style={status.tone === 'attention' ? { color: ATTENTION } : undefined}
        >
          {status.text}
        </span>
      </button>
    </li>
  );
}

function FactoryGroup({ factory, runs }: { factory: Factory; runs: FactoryRun[] }) {
  // Needs-you runs first, then oldest activity first (stable, like the floor).
  const sorted = [...runs].sort(
    (a, b) => Number(needsYou(b)) - Number(needsYou(a)) || a.createdAt.localeCompare(b.createdAt),
  );
  const shown = sorted.slice(0, MAX_ROWS);
  const more = sorted.length - shown.length;
  return (
    <div className="mx-2 mb-2 rounded-xl ring-1 ring-inset ring-seam bg-elevation-1" data-factory-group={factory.id}>
      <button
        type="button"
        onClick={() => useAppStore.getState().openFactoryTab(factory.id, factory.name)}
        aria-label={`Open factory ${factory.name}`}
        title="Open the factory floor"
        className="group w-full flex items-center gap-1.5 pl-2.5 pr-2 pt-2 pb-1 text-left rounded-t-xl hover:bg-fill-hover"
      >
        <FactoryIcon size={12} className="flex-shrink-0" style={{ color: 'var(--nav-factory)' }} />
        <span className="text-[12px] font-medium text-text-primary truncate group-hover:underline">{factory.name}</span>
        <span className="ml-auto text-[10.5px] text-text-tertiary tabular-nums flex-shrink-0">{`${runs.length} runs`}</span>
      </button>
      <ul className="pb-1.5">
        {shown.map((r) => <RunRow key={r.id} run={r} factory={factory} />)}
        {more > 0 && <li className="px-2.5 h-5 text-[10.5px] text-text-tertiary">{`${more} more`}</li>}
      </ul>
    </div>
  );
}

/** One group per factory with open runs at the top of the Sessions navigator. */
export function FactorySidebarGroups() {
  const factories = useFactoryStore((s) => s.factories);
  const runs = useFactoryStore((s) => s.runs);
  // Re-render when a session opens or closes: a row's click target depends on it.
  useTerminalStore((s) => s.terminals);

  const groups = Object.values(factories)
    .map((factory) => ({ factory, open: Object.values(runs).filter((r) => r.factoryId === factory.id && isOpenRun(r)) }))
    .filter((g) => g.open.length > 0)
    .map((g) => ({ ...g, activity: g.open.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), g.factory.updatedAt) }))
    .sort((a, b) => b.activity.localeCompare(a.activity));
  if (groups.length === 0) return null;
  return (
    <div className="pt-1" aria-label="Factories">
      {groups.map((g) => <FactoryGroup key={g.factory.id} factory={g.factory} runs={g.open} />)}
    </div>
  );
}
