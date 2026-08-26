import { AGENT_SPECS, type AgentKind } from '../lib/agents';

// Official brand marks used under nominative fair use to identify which CLI
// the button launches. SVG paths sourced from simple-icons (CC0) for
// Anthropic and Cursor; OpenAI's well-known hexagram path is inlined
// directly (simple-icons no longer ships it). All paths use viewBox 0 0 24
// 24 and `fill="currentColor"` so the button's text color drives them - see
// the per-agent color prop below.

function AnthropicMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
    </svg>
  );
}

function OpenAIMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1258a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

function CursorMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
    </svg>
  );
}

// Per-agent icon wrapper. Anthropic + OpenAI use their fixed brand hues
// (readable on both light and dark app themes). Cursor's mark is
// monochromatic in their branding, so it inherits the theme text color
// via the Tailwind `text-text-primary` class - matches how their brand
// swaps between black-on-light and white-on-dark contexts.
function BrandIcon({ kind }: { kind: AgentKind }) {
  switch (kind) {
    case 'claude':
      return <span style={{ color: '#DA7756' }}><AnthropicMark /></span>;
    case 'codex':
      return <span style={{ color: '#10A37F' }}><OpenAIMark /></span>;
    case 'cursor':
      return <span className="text-text-primary"><CursorMark /></span>;
  }
}

interface AgentPickerProps {
  value: AgentKind;
  onChange: (kind: AgentKind) => void;
  className?: string;
}

/**
 * Agent picker: a row of buttons (one per registered agent) with each
 * brand's official logo. Rendered above the Profile grid in
 * NewTerminalModal and at the top of ProfileModal. The layout auto-grows
 * with `AGENT_SPECS` - a 4th agent needs a new entry in the catalog and a
 * new `iconFor` case here.
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
