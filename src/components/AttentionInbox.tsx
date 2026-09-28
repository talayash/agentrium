import { X } from 'lucide-react';
import { useAttentionStore, type AttentionKind } from '../store/attentionStore';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { EmptyState } from './ui/EmptyState';

const LABELS: Record<AttentionKind, string> = {
  input: 'Needs input', review: 'Ready to review', error: 'Process failed', stopped: 'Process finished',
};
const PRIORITY: Record<AttentionKind, number> = { error: 0, input: 1, review: 2, stopped: 3 };

export function AttentionInbox() {
  const items = useAttentionStore(s => s.items);
  const dismiss = useAttentionStore(s => s.dismiss);
  const terminals = useTerminalStore(s => s.terminals);
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-2">
      <h2 className="px-2 py-2 text-sm font-semibold text-text-primary">Attention inbox ({items.length})</h2>
      {items.length === 0 && <EmptyState title="Nothing needs attention" description="Input prompts, settled responses, and process exits appear here." compact />}
      {[...items].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || b.createdAt - a.createdAt).map(item => (
        <div key={item.terminalId} className="flex items-start mb-2 rounded-lg border border-seam bg-elevation-1">
          <button aria-label={`Open ${item.title}: ${LABELS[item.kind]}`} className="flex-1 min-w-0 p-3 text-left hover:bg-fill-hover rounded-lg" onClick={() => {
            if (!useTerminalStore.getState().terminals.has(item.targetId)) { dismiss(item.terminalId); return; }
            const app = useAppStore.getState();
            app.setSplitMode(false);
            if (app.gridMode) app.toggleGridMode();
            useTerminalStore.getState().setActiveTerminal(item.targetId);
            dismiss(item.terminalId);
          }}>
            <span className={`block text-xs font-semibold ${item.kind === 'error' ? 'text-error' : 'text-accent-primary'}`}>{LABELS[item.kind]}</span>
            <span className="block truncate text-sm text-text-primary mt-1">{terminals.get(item.terminalId)?.config.nickname || item.title}</span>
            <span className="block text-xs text-text-secondary mt-1">{item.detail}</span>
          </button>
          <button aria-label={`Dismiss ${item.title}`} className="p-2 text-text-tertiary hover:text-text-primary" onClick={() => dismiss(item.terminalId)}><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}
