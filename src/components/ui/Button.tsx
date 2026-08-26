import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
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
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent-primary hover:bg-accent-secondary text-white',
  secondary:
    'bg-elevation-2 ring-1 ring-border-light text-text-secondary hover:text-text-primary hover:bg-white/[0.04]',
  ghost: 'text-text-secondary hover:text-text-primary hover:bg-white/[0.06]',
  danger: 'text-error hover:bg-error/10',
  success: 'bg-success hover:bg-success/90 text-white',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-[12px] gap-1.5',
  md: 'h-9 px-4 text-[13px] gap-2',
};

/**
 * Shared button primitive. Replaces the ad-hoc
 * `bg-accent-primary hover:bg-accent-secondary …` strings duplicated across
 * ~15 components, and inherits the global focus-visible ring.
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
      className={`inline-flex items-center justify-center rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-default ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {loading ? <Loader2 size={iconSize} className="animate-spin" /> : icon}
      {children}
    </button>
  );
});
