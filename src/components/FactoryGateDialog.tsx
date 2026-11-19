import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useFactoryStore } from '../store/factoryStore';
import { getFactoryArtifact, currentStep, type FactoryRun, type GateStep } from '../lib/factory';
import { reportInvokeFailure } from '../lib/errorReporter';
import { Modal } from './ui/Modal';

type Artifact = { state: 'loading' } | { state: 'missing' } | { state: 'error'; message: string } | { state: 'ok'; text: string };

/** The only place a gate can be answered. Reads its run id from the store. */
export function FactoryGateDialog() {
  const runId = useAppStore((s) => s.factoryGateRunId);
  const close = useAppStore((s) => s.closeFactoryGate);
  const storedRun = useFactoryStore((s) => (runId ? s.runs[runId] : undefined));
  const factoryName = useFactoryStore((s) => (storedRun ? s.factories[storedRun.factoryId]?.name : undefined));
  const [artifacts, setArtifacts] = useState<Record<string, Artifact>>({});
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * The gate this dialog is answering, kept from the click until the dialog
   * closes: the store moves the run on before the dialog closes, and the form
   * must not turn into the already-answered state in between.
   */
  const [answering, setAnswering] = useState<{ run: FactoryRun; gate: GateStep } | null>(null);

  useEffect(() => {
    setAnswering(null);
    setBusy(false);
  }, [runId]);

  const step = storedRun ? currentStep(storedRun) : undefined;
  const waiting = storedRun && step?.kind === 'gate' && storedRun.status === 'waiting_gate'
    ? { run: storedRun, gate: step } : null;
  const shown = answering ?? waiting;
  const open = !!shown;
  const gate = shown?.gate;
  const showKey = gate ? gate.show.join('\n') : '';

  useEffect(() => {
    setArtifacts({});
    if (!open || !runId || !gate) return;
    let cancelled = false;
    const patch = (name: string, a: Artifact) => {
      if (!cancelled) setArtifacts((prev) => ({ ...prev, [name]: a }));
    };
    for (const name of gate.show) {
      getFactoryArtifact(runId, name)
        .then((text) => patch(name, text === null ? { state: 'missing' } : { state: 'ok', text }))
        .catch((err) => {
          patch(name, { state: 'error', message: String(err) });
          reportInvokeFailure('get_factory_artifact', err);
        });
    }
    return () => { cancelled = true; };
    // gate.show is covered by showKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runId, showKey]);

  if (!runId) return null;

  if (!shown || !gate) {
    return (
      <Modal title="Gate" showHeader onClose={close} closeOn="none" panelClassName="w-full max-w-sm">
        <div className="p-4 flex flex-col gap-4 text-[13px]">
          <p className="text-text-secondary">This gate was already answered.</p>
          <div className="flex justify-end">
            <button type="button" onClick={close} className="h-8 px-3 rounded-lg ring-1 ring-inset ring-seam text-text-primary hover:bg-fill-hover">Close</button>
          </div>
        </div>
      </Modal>
    );
  }

  const answer = (approve: boolean) => {
    if (busy || !waiting) return;
    if (!approve && !reason.trim()) {
      setReasonMissing(true);
      return;
    }
    setReasonMissing(false);
    setBusy(true);
    setAnswering(waiting);
    // The store shows the error toast and reports the failure, then rethrows: stay open.
    useFactoryStore.getState().answerGate(waiting.run.id, waiting.gate.id, approve, reason)
      .then(() => close())
      .catch(() => { setBusy(false); setAnswering(null); });
  };

  const run = shown.run;
  const reasonId = `gate-reason-${run.id}`;

  return (
    <Modal
      title={(
        <span className="flex flex-col">
          <span>{gate.name}</span>
          <span className="text-[12px] font-normal text-text-secondary">{factoryName ?? run.factoryId} · {run.input}</span>
        </span>
      )}
      showHeader onClose={() => { if (!busy) close(); }} closeOn="none"
      panelClassName="w-full max-w-4xl max-h-[88vh] flex flex-col"
    >
      <div className="flex flex-1 min-h-0 text-[13px]">
        <div className="flex-1 min-w-0 overflow-y-auto p-4 flex flex-col gap-4">
          {gate.show.length === 0 && <p className="text-text-secondary">This gate shows no files.</p>}
          {gate.show.map((name) => {
            const a = artifacts[name] ?? { state: 'loading' as const };
            return (
              <section key={name} className="flex flex-col gap-1.5">
                <h3 className="text-[12px] font-medium text-text-secondary">{name}</h3>
                {a.state === 'loading' && <p role="status" className="text-text-tertiary text-[12px]">Loading...</p>}
                {a.state === 'missing' && <p className="text-text-secondary">{name} is not in the run folder.</p>}
                {a.state === 'error' && <p className="text-error text-[12px]">{a.message}</p>}
                {a.state === 'ok' && (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-text-primary bg-elevation-2 ring-1 ring-seam rounded-lg p-3">{a.text}</pre>
                )}
              </section>
            );
          })}
        </div>
        <div className="w-80 shrink-0 border-l border-seam overflow-y-auto p-4 flex flex-col gap-3">
          <p className="text-[14px] font-medium text-text-primary">{gate.question}</p>
          {gate.notes.length > 0 && (
            <div className="flex flex-col gap-1">
              <h4 className="text-[12px] text-text-secondary">Passing also does</h4>
              <ul className="list-disc pl-4 text-text-secondary text-[12px] flex flex-col gap-0.5">
                {gate.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          )}
          <label htmlFor={reasonId} className="text-[12px] text-text-secondary">
            Reason (required to {gate.reject_label.toLowerCase()})
          </label>
          <textarea
            id={reasonId} value={reason} disabled={busy}
            onChange={(e) => { setReason(e.target.value); if (e.target.value.trim()) setReasonMissing(false); }}
            aria-invalid={reasonMissing || undefined}
            className="w-full h-24 resize-none bg-elevation-2 ring-1 ring-seam rounded-lg p-2 text-text-primary text-[13px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 aria-[invalid=true]:ring-error/60"
          />
          {reasonMissing && <p role="alert" className="text-error text-[12px]">Give a reason so the agent knows what to change.</p>}
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => answer(true)}
              className="flex-1 h-8 rounded-lg bg-accent-primary text-white disabled:opacity-50">{gate.pass_label}</button>
            <button type="button" disabled={busy} onClick={() => answer(false)}
              className="flex-1 h-8 rounded-lg text-error ring-1 ring-inset ring-error/40 hover:bg-fill-hover disabled:opacity-50">{gate.reject_label}</button>
          </div>
          <p className="text-[11px] text-text-tertiary">Agentrium records this answer. The agent cannot answer a gate.</p>
        </div>
      </div>
    </Modal>
  );
}
