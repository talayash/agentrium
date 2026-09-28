import { useEffect } from 'react';
import { useTerminalStore } from '../store/terminalStore';
import { useAttentionStore } from '../store/attentionStore';
import { sessionDisplayName } from '../lib/sessionContext';

export function subscribeAttentionInbox(): () => void {
  const update: Parameters<typeof useTerminalStore.subscribe>[0] = (state, previous) => {
    if (state.terminals === previous.terminals && state.terminalStates === previous.terminalStates) return;
    const inbox = useAttentionStore.getState();
    inbox.retain(new Set(state.terminals.keys()));
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
        if (inferred === 'waiting') inbox.put({ ...base, kind: 'input', detail: 'A prompt appears to be waiting for your response.' });
        else if (inferred === 'idle' && oldInferred === 'busy') inbox.put({ ...base, kind: 'review', detail: 'Output has settled. Review the response and changed files.' });
        else if (inferred === 'busy' || inferred === 'idle') inbox.dismiss(id);
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
