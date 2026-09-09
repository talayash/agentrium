import { Plus } from 'lucide-react';
import { allAgentSpecs, isCustomAgent, type AgentKind } from '../lib/agents';
import { BrandIcon } from './BrandIcon';

interface AgentPickerProps {
  value: AgentKind;
  onChange: (kind: AgentKind) => void;
  onAddAgent?: () => void;
  className?: string;
}

export function AgentPicker({ value, onChange, onAddAgent, className = '' }: AgentPickerProps) {
  const specs = allAgentSpecs();
  const tileCount = specs.length + (onAddAgent ? 1 : 0);
  const cols =
    tileCount <= 2 ? 'grid-cols-2'
    : tileCount === 3 ? 'grid-cols-3'
    : tileCount === 4 ? 'grid-cols-4'
    : 'grid-cols-3';
  return (
    <div className={`grid ${cols} gap-2 ${className}`}>
      {specs.map((spec) => {
        const selected = spec.kind === value;
        return (
          <button
            key={spec.kind}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(spec.kind)}
            className={`relative flex flex-col items-center gap-1.5 p-3 rounded-xl transition-[background-color,box-shadow,transform] duration-100 active:scale-[0.97] ${
              selected
                ? 'bg-accent-primary/12 ring-1 ring-accent-primary/45 shadow-[0_2px_10px_var(--accent-glow-md)]'
                : 'bg-fill-hover ring-1 ring-seam hover:bg-fill-active hover:ring-seam-strong'
            }`}
          >
            <BrandIcon kind={spec.kind} />
            <p className="text-text-primary text-[12px] font-medium text-center leading-tight">{spec.displayName}</p>
            {isCustomAgent(spec.kind) && (
              <span className="absolute top-1.5 right-2 text-[9px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">Local</span>
            )}
          </button>
        );
      })}
      {onAddAgent && (
        <button
          type="button"
          onClick={onAddAgent}
          className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border border-dashed border-[rgba(255,255,255,0.14)] text-text-tertiary hover:text-text-secondary hover:bg-fill-hover transition-colors"
        >
          <Plus size={18} strokeWidth={2.25} />
          <p className="text-[12px] font-medium leading-tight">Add agent</p>
        </button>
      )}
    </div>
  );
}
