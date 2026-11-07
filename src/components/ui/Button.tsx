import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'destructive' | 'success';
export type ButtonSize = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** Leading icon (omitted while loading). */
  icon?: ReactNode;
}

// All variants follow the user's accent token - no hardcoded brand colors.
// Filled variants are tactile keycaps (solid fill, darker bottom lip, press
// pushes down 1px); their colours live in index.css (`button.bg-accent-primary
// .text-white` for primary, `.key-*` for the rest), not Tailwind /opacity
// classes, which compile to nothing on var() colours here.
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent-primary text-white',
  secondary: 'key-neutral text-text-primary',
  ghost: 'text-text-secondary hover:text-text-primary hover:bg-fill-hover',
  danger: 'text-error hover:bg-error/10',
  // Solid red for an irreversible confirm (Quit). Not bg-accent-primary, so
  // the primary keycap rule in index.css doesn't paint it blue.
  destructive: 'key-danger text-white',
  success: 'key-success text-white',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-[12px] gap-1.5',
  md: 'h-9 px-4 text-[13px] gap-2',
};

/**
 * Shared button primitive. Replaces the ad-hoc
 * `bg-accent-primary hover:bg-accent-secondary …` strings duplicated across
 * ~15 components, and inherits the global focus-visible ring.
 *
 * Feedback lives on the press, and it's instant: the whole button dips on
 * :active (pointer-down), not on release - Apple's response principle.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, icon, disabled, className = '', children, type, ...rest },
  ref,
) {
  const iconSize = size === 'sm' ? 12 : 14;
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center rounded-md font-medium transition-[background-color,color,transform,opacity,filter] duration-100 ease-out active:translate-y-px disabled:opacity-50 disabled:cursor-default disabled:active:translate-y-0 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {loading ? <Loader2 size={iconSize} className="animate-spin" /> : icon}
      {children}
    </button>
  );
});
