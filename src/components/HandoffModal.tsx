import { useEffect, useRef, useState } from 'react';
import { allAgentSpecs, type AgentKind } from '../lib/agents';
import { buildHandoffBrief, launchHandoff, loadHandoffBrief } from '../lib/handoff';
import { reportInvokeFailure } from '../lib/errorReporter';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { AgentPicker } from './AgentPicker';
import { Modal } from './ui/Modal';

export function HandoffModal({ sourceId, onClose }: { sourceId: string; onClose: () => void }) {
  const sourceAgent = useTerminalStore.getState().terminals.get(sourceId)?.config.agent;
  const [agent, setAgent] = useState<AgentKind>(() => allAgentSpecs().find(s => s.kind !== sourceAgent)?.kind ?? 'claude');
  const [brief, setBrief] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const launching = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    loadHandoffBrief(sourceId).then(text => {
      if (!cancelled) setBrief(text);
    }).catch(err => {
      if (cancelled) return;
      reportInvokeFailure('get_terminal_changes', err);
      setError('Could not load changed files. You can complete the brief manually.');
      try { setBrief(buildHandoffBrief(sourceId, null)); }
      catch { setError('The source session is no longer open.'); }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sourceId]);

  const launch = async () => {
    if (launching.current) return;
    launching.current = true;
    setBusy(true);
    setError('');
    try {
      await launchHandoff(sourceId, agent, brief);
      onClose();
      toast.info('Handoff prepared', 'Send the brief from the prompt editor when the new agent is ready.');
    } catch (err) {
      setError(String(err));
    } finally {
      launching.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal title="Continue with another agent" showHeader onClose={() => { if (!busy) onClose(); }} panelClassName="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
      <div className="p-4 flex flex-col gap-4">
        <p className="text-sm text-text-secondary">Review the brief, add decisions and next steps, then open the receiving agent. The brief will be ready in its prompt editor.</p>
        <p className="text-xs text-text-secondary">Both sessions use the same working directory. Let the source agent finish before sending the brief.</p>
        <fieldset disabled={busy}><legend className="text-sm text-text-secondary mb-2">Receiving agent</legend><AgentPicker value={agent} onChange={setAgent} /></fieldset>
        <label className="text-sm text-text-primary">Handoff brief
          <textarea aria-label="Handoff brief" value={brief} disabled={loading || busy} onChange={e => setBrief(e.target.value)} rows={14}
            className="mt-2 w-full p-3 rounded-lg bg-elevation-1 border border-seam text-text-primary font-mono text-xs resize-y" />
        </label>
        {loading && <p role="status" className="text-sm text-text-secondary">Preparing brief...</p>}
        {error && <p role="alert" className="text-sm text-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <button disabled={busy} onClick={onClose} className="px-3 py-2 text-text-secondary">Cancel</button>
          <button disabled={loading || busy || !brief.trim()} onClick={launch} className="px-4 py-2 rounded-lg bg-accent-primary text-white disabled:opacity-50">{busy ? 'Opening...' : 'Open agent with brief'}</button>
        </div>
      </div>
    </Modal>
  );
}
