import { useEffect } from 'react';
import { useTerminalStore } from '../store/terminalStore';
import { useAttentionStore } from '../store/attentionStore';
import { sessionDisplayName } from '../lib/sessionContext';
import { getLastSubmissionAt } from '../lib/terminalActivity';

// Session items are tied to the user's last submission (Enter in the
// terminal), not to raw busy/idle flips: opening, resizing or focusing a
// session repaints it, which reads as "busy" and would otherwise wipe a
// reviewed or dismissed item and raise it again. An item is resolved only by
// new user input, and a "review" item needs a submitted prompt behind it.
// Answering a prompt (the startup trust question, a permission request) is
// input too, but it does not by itself start a turn worth reviewing.
export function subscribeAttentionInbox(): () => void {
  // Last session item raised per terminal, and the submission it belongs to.
  const raised = new Map<string, { kind: 'input' | 'review'; submission: number | null }>();
  // Terminals where the user has sent a prompt (Enter outside a waiting prompt).
  const prompted = new Set<string>();
  const seenSubmission = new Map<string, number | null>();
  // The submission whose turn already settled: later busy/idle flips for the
  // same submission are repaints, not a finished turn.
  const settledFor = new Map<string, number | null>();
  const update: Parameters<typeof useTerminalStore.subscribe>[0] = (state, previous) => {
    if (state.terminals === previous.terminals && state.terminalStates === previous.terminalStates) return;
    const inbox = useAttentionStore.getState();
    inbox.retain(new Set(state.terminals.keys()));
    for (const id of [...raised.keys()]) if (!state.terminals.has(id)) raised.delete(id);
    for (const id of [...prompted]) if (!state.terminals.has(id)) prompted.delete(id);
    for (const id of [...seenSubmission.keys()]) if (!state.terminals.has(id)) seenSubmission.delete(id);
    for (const id of [...settledFor.keys()]) if (!state.terminals.has(id)) settledFor.delete(id);
    for (const [id, terminal] of state.terminals) {
      if (terminal.isShellTerminal) continue;
      const status = terminal.config.status;
      const oldStatus = previous.terminals.get(id)?.config.status;
      const inferred = state.terminalStates.get(id);
      const oldInferred = previous.terminalStates.get(id);
      const base = { terminalId: id, targetId: terminal.scriptParentId ?? id, title: terminal.scriptName ?? sessionDisplayName(terminal) };
      if (status === 'Error' && oldStatus !== 'Error') {
        inbox.put({ ...base, kind: 'error', detail: 'The process reported a failure. Open the terminal to inspect its output.' });
      } else if (status === 'Stopped' && oldStatus !== 'Stopped') {
        inbox.put({ ...base, kind: 'stopped', detail: 'The process exited. Inspect its output before continuing.' });
      } else if (status !== 'Error' && status !== 'Stopped' && !terminal.scriptParentId && !terminal.scriptName && inferred !== oldInferred) {
        const submission = getLastSubmissionAt(id) ?? null;
        const last = raised.get(id);
        if (submission !== (seenSubmission.get(id) ?? null)) {
          seenSubmission.set(id, submission);
          // Enter while a prompt was waiting answers it; anywhere else it sends a prompt.
          if (oldInferred !== 'waiting') prompted.add(id);
        }
        const current = inbox.items.find(i => i.terminalId === id && (i.kind === 'input' || i.kind === 'review'));
        if (inferred === 'waiting') {
          // Same prompt episode (no input since): keep the item as it is,
          // including a dismissal or a "reviewed" mark.
          if (last?.kind === 'input' && last.submission === submission) continue;
          raised.set(id, { kind: 'input', submission });
          inbox.put({ ...base, kind: 'input', detail: 'A prompt appears to be waiting for your response.' });
        } else if (inferred === 'busy') {
          // New user input resolves the previous item; a repaint does not.
          if (last && last.submission !== submission) {
            raised.delete(id);
            inbox.dismiss(id);
          }
        } else if (inferred === 'idle') {
          const turnEnd = oldInferred === 'busy' && submission !== null && settledFor.get(id) !== submission;
          if (turnEnd) settledFor.set(id, submission);
          if (turnEnd && prompted.has(id)) {
            raised.set(id, { kind: 'review', submission });
            inbox.put({ ...base, kind: 'review', detail: 'Output has settled. Review the response and changed files.' });
          } else if (current?.kind === 'input') {
            // The prompt went away (answered or cancelled).
            raised.delete(id);
            inbox.dismiss(id);
          }
        }
      }
    }
  };
  const state = useTerminalStore.getState();
  update(state, { ...state, terminals: new Map(), terminalStates: new Map() });
  return useTerminalStore.subscribe(update);
}

export function useAttentionInbox(): void {
  useEffect(subscribeAttentionInbox, []);
}
