import { AGENT_SPECS, type AgentKind } from '../lib/agents';

interface AgentPickerProps {
  value: AgentKind;
  onChange: (kind: AgentKind) => void;
  className?: string;
}

// Brand-approximate inline SVGs. Colors chosen for readability on both dark
// and light backgrounds (mid-saturation, not pure black or white). Sized to
// 22px to match the ~24px baseline of lucide icons used elsewhere.
function ClaudeMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 2 L13.4 10.6 L22 12 L13.4 13.4 L12 22 L10.6 13.4 L2 12 L10.6 10.6 Z"
        fill="#DA7756"
      />
    </svg>
  );
}

function CodexMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="#10A37F" strokeWidth="2" />
      <circle cx="12" cy="12" r="3" fill="#10A37F" />
    </svg>
  );
}

function CursorMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 3 L20 12 L13 13.2 L11 21 Z" fill="#7C6CE8" />
    </svg>
  );
}

function iconFor(kind: AgentKind) {
  switch (kind) {
    case 'claude':
      return <ClaudeMark />;
    case 'codex':
      return <CodexMark />;
    case 'cursor':
      return <CursorMark />;
  }
}

/**
 * Agent picker: a row of buttons (one per registered agent) that select which
 * CLI a terminal (or profile) targets. Rendered above the Profile grid in
 * NewTerminalModal and at the top of ProfileModal. The layout auto-grows with
 * `AGENT_SPECS` — adding a 4th agent just requires a new entry in the catalog
 * and an icon case here.
 */
export function AgentPicker({ value, onChange, className = '' }: AgentPickerProps) {
  const cols = AGENT_SPECS.length === 2 ? 'grid-cols-2' : 'grid-cols-3';
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
            {iconFor(spec.kind)}
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
