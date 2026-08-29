import { X, FileDiff, Users, Lightbulb } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { FileChangesPanel } from './FileChangesPanel';
import { OrchestrationPanel } from './OrchestrationPanel';
import { HintsPanel } from './HintsPanel';

type InspectorTab = 'changes' | 'agents' | 'commands';

const TABS: { id: InspectorTab; label: string; Icon: LucideIcon }[] = [
  { id: 'changes', label: 'Changes', Icon: FileDiff },
  { id: 'agents', label: 'Agents', Icon: Users },
  { id: 'commands', label: 'Commands', Icon: Lightbulb },
];

/**
 * One contextual inspector on the right, replacing the four separately-toggled
 * panels. A segmented switcher moves between Changes (Git), Agents
 * (orchestration), and Commands (hints); the underlying panels keep all their
 * own logic. Visibility is driven by the (now mutually-exclusive) store
 * booleans, so ToolStripe / keyboard shortcuts / command palette work unchanged.
 */
export function Inspector() {
  const changesOpen = useAppStore((s) => s.changesOpen);
  const orchestrationOpen = useAppStore((s) => s.orchestrationOpen);
  const hintsOpen = useAppStore((s) => s.hintsOpen);
  const toggleChanges = useAppStore((s) => s.toggleChanges);
  const toggleOrchestration = useAppStore((s) => s.toggleOrchestration);
  const toggleHints = useAppStore((s) => s.toggleHints);

  const active: InspectorTab = changesOpen ? 'changes' : orchestrationOpen ? 'agents' : 'commands';

  const openTab = (id: InspectorTab) => {
    if (id === active) return;
    if (id === 'changes') toggleChanges();
    else if (id === 'agents') toggleOrchestration();
    else toggleHints();
  };
  const close = () => {
    if (changesOpen) toggleChanges();
    else if (orchestrationOpen) toggleOrchestration();
    else if (hintsOpen) toggleHints();
  };

  return (
    <div className="h-full material-chrome flex flex-col">
      <div className="flex items-center gap-1 p-2 border-b border-[var(--seam)]">
        {TABS.map(({ id, label, Icon }) => {
          const on = active === id;
          return (
            <button
              key={id}
              onClick={() => openTab(id)}
              aria-pressed={on}
              className={`flex-1 h-8 rounded-lg flex items-center justify-center gap-1.5 text-[12px] font-medium transition-[background-color,color] duration-100 ${
                on
                  ? 'bg-fill-active text-text-primary'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-fill-hover'
              }`}
            >
              <Icon size={13} strokeWidth={1.9} />
              {label}
            </button>
          );
        })}
        <button
          onClick={close}
          aria-label="Close inspector"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-secondary hover:bg-fill-hover active:scale-95 transition-[background-color,color,transform] duration-100"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {active === 'changes' && <FileChangesPanel />}
        {active === 'agents' && <OrchestrationPanel />}
        {active === 'commands' && <HintsPanel />}
      </div>
    </div>
  );
}
