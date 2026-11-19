import { useEffect, useRef, useState } from 'react';
import { Factory as FactoryIcon } from 'lucide-react';
import { reportInvokeFailure } from '../lib/errorReporter';
import { FACTORY_TAB_PREFIX } from '../lib/factory';
import { useAppStore } from '../store/appStore';
import { useFactoryStore } from '../store/factoryStore';
import { toast } from '../store/toastStore';
import { Modal } from './ui/Modal';

const FIELD = 'bg-elevation-0 text-text-primary text-[13px] px-2.5 py-1.5 rounded-md ring-1 ring-border-light focus:ring-accent-primary outline-none';
const INPUT = `w-full ${FIELD}`;
const BTN = 'px-3 h-8 rounded-md text-[12px] ring-1 ring-border-light text-text-secondary hover:bg-fill-hover disabled:opacity-40';
const BTN_PRIMARY = 'px-3 h-8 rounded-md text-[12px] bg-accent-primary text-white disabled:opacity-40 flex items-center gap-1.5';

/** New run: one input, handed to a factory that starts it on its own line. */
export function NewFactoryRunModal() {
  const close = useAppStore((s) => s.closeNewFactoryRun);
  const presetId = useAppStore((s) => s.newFactoryRunFactoryId);
  const factories = useFactoryStore((s) => s.factories);
  const list = Object.values(factories);
  const [factoryId, setFactoryId] = useState(() => {
    if (typeof presetId === 'string') return presetId;
    const file = useAppStore.getState().activeFilePath;
    const tabId = file?.startsWith(FACTORY_TAB_PREFIX) ? file.slice(FACTORY_TAB_PREFIX.length) : null;
    if (tabId && useFactoryStore.getState().factories[tabId]) return tabId;
    return Object.keys(useFactoryStore.getState().factories)[0] ?? '';
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const launching = useRef(false);
  // False after unmount: a start that resolves late must not touch state.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const factory = factories[factoryId] ?? null;
  const def = factory?.definition ?? null;
  const hasCheck = def?.steps.some((s) => s.kind === 'station' && s.check) ?? false;

  const submit = async () => {
    if (launching.current || !factory) return;
    launching.current = true;
    setBusy(true);
    setError('');
    try {
      await useFactoryStore.getState().startRun(factory.id, input);
      useAppStore.getState().closeNewFactoryRun();
      useAppStore.getState().openFactoryTab(factory.id, factory.name);
      toast.success('Run started', input);
    } catch (err) {
      // The backend refuses with a user-facing sentence; show it and keep the form.
      if (mounted.current) setError(String(err));
      reportInvokeFailure('start_factory_run', err);
    } finally {
      launching.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <Modal title="New run" showHeader onClose={() => { if (!busy) close(); }}
      closeOn="none" closeOnEscape={false}
      panelClassName="w-full max-w-lg max-h-[90vh] overflow-y-auto">
      {!factory ? (
        <div className="p-4 flex flex-col gap-3 text-[12px]">
          <p className="text-text-secondary">Add a factory first.</p>
          <div className="flex justify-end">
            <button type="button" className={BTN_PRIMARY}
              onClick={() => { close(); useAppStore.getState().openAddFactoryModal(); }}>
              Add a factory
            </button>
          </div>
        </div>
      ) : (
        <form className="p-4 flex flex-col gap-3.5"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {presetId === null && (
            <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
              Factory
              <select value={factoryId} onChange={(e) => setFactoryId(e.target.value)} disabled={busy} className={INPUT}>
                {list.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
            {def!.input.label}
            <input autoFocus value={input} onChange={(e) => setInput(e.target.value)}
              placeholder={def!.input.placeholder} disabled={busy} spellCheck={false} className={INPUT} />
          </label>
          <p className="text-[11.5px] text-text-tertiary -mt-2">
            {def!.workspace === 'in_place'
              ? `Runs in ${factory.repoPath}. If another run is building, this one waits in the queue.`
              : 'Gets its own worktree and branch.'}
          </p>
          {hasCheck && (
            <p className="text-[11.5px] text-text-tertiary -mt-2">
              Only letters, digits and . _ : / # @ - are allowed, because this factory runs a check command.
            </p>
          )}
          {error && <p role="alert" className="text-[12px] text-error whitespace-pre-wrap">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" disabled={busy} onClick={close} className={BTN}>Cancel</button>
            <button type="submit" disabled={busy} className={BTN_PRIMARY}>
              <FactoryIcon size={13} />
              Start
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
