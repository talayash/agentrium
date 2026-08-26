import { AGENT_SPECS, type AgentKind } from '../lib/agents';
import { BrandIcon } from './BrandIcon';

interface AgentPickerProps {
  value: AgentKind;
  onChange: (kind: AgentKind) => void;
  className?: string;
}

/**
 * Agent picker: a row of buttons (one per registered agent) with each
 * brand's official logo. Rendered above the Profile grid in
 * NewTerminalModal and at the top of ProfileModal. The layout auto-grows
 * with `AGENT_SPECS` - a 5th agent needs a new entry in the catalog and
 * a new `BrandIcon` case in `./BrandIcon.tsx`.
 */
export function AgentPicker({ value, onChange, className = '' }: AgentPickerProps) {
  // Tailwind JIT needs literal class names, so map count -> class explicitly.
  // Falls back to grid-cols-4 for 5+ agents (would wrap into two rows).
  const cols =
    AGENT_SPECS.length <= 2 ? 'grid-cols-2'
    : AGENT_SPECS.length === 3 ? 'grid-cols-3'
    : 'grid-cols-4';
  return (
    <div className={`grid ${cols} gap-2 ${className}`}>
      {AGENT_SPECS.map((spec) => {
        const selected = spec.kind === value;
        return (
          <button
            key={spec.kind}
            onClick={() => onChange(spec.kind)}
            className={`flex flex-col items-center gap-1.5 p-3 rounded-md transition-colors ${
              selected
                ? 'bg-accent-primary/10 ring-1 ring-accent-primary/40'
                : 'bg-bg-primary ring-1 ring-border hover:ring-border-light'
            }`}
          >
            <BrandIcon kind={spec.kind} />
            <div className="text-center leading-tight">
              <p className="text-text-primary text-[12px] font-medium">{spec.displayName}</p>
              <p className="text-text-tertiary text-[10px] font-mono">{spec.binary}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
