interface ToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** 'sm' (36×20) for dense rows, 'md' (44×26) default. */
  size?: 'sm' | 'md';
  ariaLabel?: string;
  className?: string;
}

/**
 * iOS-style switch. Accent fill + white knob that springs across on toggle.
 * Replaces the ad-hoc `w-9 h-5 rounded-full` toggles scattered across modals
 * and settings so every switch reads and behaves identically.
 */
export function Toggle({ checked, onChange, disabled = false, size = 'md', ariaLabel, className = '' }: ToggleProps) {
  const track = size === 'sm' ? 'w-9 h-5' : 'w-11 h-[26px]';
  const knob = size === 'sm' ? 'w-4 h-4' : 'w-[22px] h-[22px]';
  const shift = size === 'sm' ? 'translate-x-4' : 'translate-x-[18px]';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative ${track} rounded-full flex-shrink-0 ring-1 ring-inset transition-colors duration-200 active:scale-[0.96] ${
        checked ? 'bg-accent-primary ring-transparent' : 'bg-fill-active ring-seam'
      } ${disabled ? 'opacity-50 cursor-default' : ''} ${className}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 ${knob} rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.6)] transition-transform duration-200 ${
          checked ? shift : 'translate-x-0'
        }`}
      />
    </button>
  );
}
