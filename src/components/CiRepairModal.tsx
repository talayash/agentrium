import { useEffect, useRef, useState } from 'react';
import { allAgentSpecs, type AgentKind } from '../lib/agents';
import { launchCiRepair, loadCiRepairContext, type LoadedCiRepair } from '../lib/ciRepair';
import { buildCiRepairBrief } from '../lib/pullRequests';
import { promptDeliveryFor } from '../lib/tasks';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { AgentPicker } from './AgentPicker';
import { Modal } from './ui/Modal';

/** Review dialog for "Fix with agent": pick an agent, review and edit the
 *  repair brief, then start a task worktree off the PR branch. */
export function CiRepairModal({ sourceId, onClose }: { sourceId: string; onClose: () => void }) {
  const sourceAgent = useTerminalStore.getState().terminals.get(sourceId)?.config.agent;
  const [agent, setAgent] = useState<AgentKind>(() =>
    allAgentSpecs().find(s => s.kind === sourceAgent)?.kind ?? allAgentSpecs()[0]?.kind ?? 'claude');
  const [loaded, setLoaded] = useState<LoadedCiRepair | null>(null);
  const [brief, setBrief] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const launching = useRef(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadCiRepairContext(sourceId).then(l => {
      if (cancelled) return;
      setLoaded(l);
      setBrief(buildCiRepairBrief(l.context));
    }).catch(err => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sourceId]);

  const start = async () => {
    if (launching.current || !loaded) return;
    launching.current = true;
    setBusy(true);
    setError('');
    try {
      const { staged } = await launchCiRepair(loaded, agent, brief);
      onClose();
      toast.info('CI repair started', staged
        ? 'Send the brief from the prompt editor when the agent is ready. Nothing is pushed automatically.'
        : 'The agent received the brief. Nothing is pushed automatically.');
    } catch (err) {
      // Shown inline so the user can retry; the backend already reported
      // internal failures and launchTask rolled the worktree back.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      launching.current = false;
      setBusy(false);
    }
  };

  const ctx = loaded?.context;
  const branch = ctx?.branch ?? '';
  const delivery = promptDeliveryFor(agent);

  return (
    <Modal title="Fix failing CI with an agent" showHeader onClose={() => { if (!busy) onClose(); }} panelClassName="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
      <div className="p-4 flex flex-col gap-4">
        <p className="text-sm text-text-secondary">
          Review the repair brief, then start the agent in a new task worktree branched from the pull request branch.
        </p>
        {ctx && (
          <ul aria-label="Repair context" className="text-xs text-text-secondary flex flex-col gap-1">
            <li>Pull request #{ctx.status.number}{ctx.details?.title ? `: ${ctx.details.title}` : ''}</li>
            <li>{ctx.status.ci.failing.length} failing check{ctx.status.ci.failing.length === 1 ? '' : 's'}{ctx.logs ? ', with failed job logs' : ''}</li>
            {ctx.changes && (
              <li>{ctx.changes.files.length} changed file{ctx.changes.files.length === 1 ? '' : 's'}
                {ctx.changes.commits[0] ? `, latest commit ${ctx.changes.commits[0].short_sha} ${ctx.changes.commits[0].subject}` : ''}</li>
            )}
            {loaded.unavailable.length > 0 && (
              <li className="text-warning">Not available: {loaded.unavailable.join(', ')}. The brief says so; add details by hand if needed.</li>
            )}
          </ul>
        )}
        {ctx && (
          <p className="text-xs text-text-secondary">
            The task starts from the last commit on <code className="font-mono">{branch}</code>. Uncommitted changes in this session are not included.
          </p>
        )}
        <fieldset disabled={busy || loading}>
          <legend className="text-sm text-text-secondary mb-2">Agent</legend>
          <AgentPicker value={agent} onChange={setAgent} />
          <p className="mt-2 text-xs text-text-secondary">
            {delivery === 'argv'
              ? 'The brief is sent as the agent\'s first prompt.'
              : 'This agent cannot take a first prompt. The brief is staged in its prompt editor for you to send.'}
          </p>
        </fieldset>
        <label className="text-sm text-text-primary">Repair brief
          <textarea aria-label="Repair brief" value={brief} disabled={loading || busy || !loaded} onChange={e => setBrief(e.target.value)} rows={14}
            className="mt-2 w-full p-3 rounded-lg bg-elevation-1 border border-seam text-text-primary font-mono text-xs resize-y" />
        </label>
        {ctx && (
          <p className="text-xs text-text-secondary">
            Nothing is pushed. When the fix looks right, review the task's changes, run your checks, then finish the task to merge it into <code className="font-mono">{branch}</code> and push from that session.
          </p>
        )}
        {loading && <p role="status" className="text-sm text-text-secondary">Loading failing checks and pull request details...</p>}
        {error && <p role="alert" className="text-sm text-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <button disabled={busy} onClick={onClose} className="px-3 py-2 text-text-secondary">Cancel</button>
          <button disabled={loading || busy || !loaded || !brief.trim()} onClick={start} className="px-4 py-2 rounded-lg bg-accent-primary text-white disabled:opacity-50">
            {busy ? 'Starting...' : 'Start repair'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
