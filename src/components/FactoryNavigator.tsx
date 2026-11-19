import { Factory as FactoryIcon, Play, Plus, Trash2 } from 'lucide-react';
import { EmptyState } from './ui/EmptyState';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { useFactoryStore, runsForFactory } from '../store/factoryStore';
import { useAppStore } from '../store/appStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { confirmAction } from '../lib/confirmDialog';
import { formatElapsed } from '../lib/races';
import { useNowTick } from '../hooks/useNowTick';
import { deleteFactory, holdsLine, isOpenRun, needsYou, type Factory, type FactoryRun } from '../lib/factory';

const ATTENTION = 'var(--attention-input)';

const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 px-4 pt-2 pb-1 text-text-tertiary text-[11px] font-semibold uppercase tracking-[0.06em]">
      {label}
      <span className="text-text-tertiary/70 text-[10.5px] tabular-nums normal-case tracking-normal font-normal">{count}</span>
    </div>
  );
}

function NeedsYouRow({ run, factory, now }: { run: FactoryRun; factory: Factory; now: number }) {
  const gate = run.status === 'waiting_gate';
  const open = () => {
    const app = useAppStore.getState();
    if (gate) app.openFactoryGate(run.id);
    else app.openFactoryTab(factory.id, factory.name);
  };
  return (
    <li>
      <button
        type="button"
        onClick={open}
        title={gate ? 'Open the gate' : 'Open the factory floor'}
        className="w-full flex items-center gap-2 px-4 h-7 text-left hover:bg-fill-hover"
      >
        <span
          className={`px-1.5 rounded text-[10px] font-mono flex-shrink-0 ${gate ? '' : 'bg-error/20 text-error'}`}
          style={gate ? { color: ATTENTION, background: 'color-mix(in srgb, var(--attention-input) 18%, transparent)' } : undefined}
        >
          {run.currentStep}
        </span>
        <span className="font-mono text-[11.5px] text-text-primary truncate">{run.input}</span>
        <span className="ml-auto text-[10.5px] text-text-tertiary tabular-nums flex-shrink-0">
          {formatElapsed(now - Date.parse(run.updatedAt))}
        </span>
      </button>
    </li>
  );
}

function FactoryCard({ factory, runs }: { factory: Factory; runs: FactoryRun[] }) {
  const open = runs.filter(isOpenRun);
  const waiting = open.filter((r) => r.status === 'waiting_gate').length;
  const blocked = open.filter((r) => r.status === 'blocked').length;
  const live = open.some(holdsLine);
  const dot = waiting + blocked > 0 ? '' : live ? 'bg-accent-primary animate-pulse' : 'bg-text-tertiary';

  const remove = async () => {
    const ok = await confirmAction('Remove this factory from Agentrium? Its files in the repo are not touched.', { okLabel: 'Remove' });
    if (!ok) return;
    try {
      await deleteFactory(factory.id);
      useFactoryStore.getState().removeFactory(factory.id);
    } catch (err) {
      toast.error('Could not remove the factory', String(err));
      reportInvokeFailure('delete_factory', err);
    }
  };

  const iconBtn = 'p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-fill-active';
  return (
    <div data-testid={`factory-${factory.id}`} className="group/fac mx-2 mb-1.5 rounded-xl ring-1 ring-inset ring-seam bg-elevation-1 hover:bg-fill-hover">
      <div className="flex items-start">
        <button
          type="button"
          aria-label={`Open factory ${factory.name}`}
          onClick={() => useAppStore.getState().openFactoryTab(factory.id, factory.name)}
          className="flex-1 min-w-0 flex items-start gap-2 pl-2.5 pr-1 py-2 text-left"
        >
          <span
            aria-hidden
            className={`mt-1.5 inline-block w-2 h-2 rounded-full flex-shrink-0 ${dot}`}
            style={waiting + blocked > 0 ? { background: waiting > 0 ? ATTENTION : 'rgb(var(--error))' } : undefined}
          />
          <span className="min-w-0 flex flex-col">
            <span className="text-[12.5px] font-medium text-text-primary truncate">{factory.name}</span>
            <span className="text-[10.5px] font-mono text-text-tertiary truncate">
              {`${baseName(factory.repoPath)} / ${baseName(factory.sourcePath)}`}
            </span>
            <span className="flex items-center gap-1.5 text-[10.5px] text-text-tertiary">
              {open.length === 0 ? (
                <span>No runs</span>
              ) : (
                <>
                  <span>{`${open.length} runs`}</span>
                  {waiting > 0 && <span style={{ color: ATTENTION }}>{`${waiting} need you`}</span>}
                  {blocked > 0 && <span className="text-error">{`${blocked} blocked`}</span>}
                </>
              )}
            </span>
          </span>
        </button>
        <span className="flex items-center pr-1.5 pt-1.5 opacity-0 group-hover/fac:opacity-100 focus-within:opacity-100">
          <Tooltip label="New run">
            <button type="button" aria-label={`New run in ${factory.name}`} className={iconBtn}
              onClick={() => useAppStore.getState().openNewFactoryRun(factory.id)}>
              <Play size={12} />
            </button>
          </Tooltip>
          <Tooltip label="Remove">
            <button type="button" aria-label={`Remove factory ${factory.name}`} className={`${iconBtn} hover:!text-error`}
              onClick={() => void remove()}>
              <Trash2 size={12} />
            </button>
          </Tooltip>
        </span>
      </div>
    </div>
  );
}

/** The Factory navigator: what needs the user, then every factory. */
export function FactoryNavigator() {
  const factories = useFactoryStore((s) => s.factories);
  const runs = useFactoryStore((s) => s.runs);
  const now = useNowTick();
  const list = Object.values(factories).sort((a, b) => a.name.localeCompare(b.name));

  if (list.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <EmptyState
          icon={<FactoryIcon size={20} />}
          title="No factories yet"
          description="A factory runs your own process station by station and stops at each human gate."
          action={<Button variant="primary" size="sm" onClick={() => useAppStore.getState().openAddFactoryModal()}>Add a factory</Button>}
        />
      </div>
    );
  }

  const waiting = Object.values(runs)
    .filter((r) => needsYou(r) && factories[r.factoryId])
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  return (
    <div className="flex-1 min-h-0 overflow-y-auto pb-2">
      {waiting.length > 0 && (
        <section aria-label="Needs you">
          <SectionHeader label="Needs you" count={waiting.length} />
          <ul className="pb-1">
            {waiting.map((r) => <NeedsYouRow key={r.id} run={r} factory={factories[r.factoryId]} now={now} />)}
          </ul>
        </section>
      )}
      <section aria-label="Factories">
        <SectionHeader label="Factories" count={list.length} />
        {list.map((f) => <FactoryCard key={f.id} factory={f} runs={runsForFactory(runs, f.id)} />)}
      </section>
      <button
        type="button"
        onClick={() => useAppStore.getState().openAddFactoryModal()}
        className="mx-2 mt-1 w-[calc(100%-1rem)] h-8 rounded-xl border border-dashed border-seam-strong flex items-center justify-center gap-1.5 text-[11.5px] text-text-tertiary hover:text-text-primary hover:bg-fill-hover"
      >
        <Plus size={12} />
        Add a factory from a repo file
      </button>
    </div>
  );
}
