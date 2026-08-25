import { AGENT_SPECS, type AgentKind } from '../lib/agents';

interface AgentPickerProps {
  value: AgentKind;
  onChange: (kind: AgentKind) => void;
  className?: string;
}

/**
 * Two-button strip that lets the user pick which agent CLI a terminal (or
 * profile) targets. Shared between `NewTerminalModal` and `ProfileModal` so
 * the button styling and semantics stay in sync when more agents are added.
 */
export function AgentPicker({ value, onChange, className = '' }: AgentPickerProps) {
  return (
    <div className={`grid grid-cols-2 gap-2 ${className}`}>
      {AGENT_SPECS.map((spec) => {
        const selected = spec.kind === value;
        return (
          <button
            key={spec.kind}
            onClick={() => onChange(spec.kind)}
            className={`p-2.5 rounded-md text-left transition-colors ${
              selected
                ? 'bg-accent-primary/10 ring-1 ring-accent-primary/30'
                : 'bg-bg-primary ring-1 ring-border hover:ring-border-light'
            }`}
          >
            <p className="text-text-primary text-[12px] font-medium">{spec.displayName}</p>
            <p className="text-text-tertiary text-[11px] font-mono">{spec.binary}</p>
          </button>
        );
      })}
    </div>
  );
}
