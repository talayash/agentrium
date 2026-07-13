import type { ReactNode } from 'react';

interface EmptyStateProps {
  /** Lucide icon (or any 24 px node). Rendered at ~24 px, muted color. */
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Optional primary action - pass a Button. */
  action?: ReactNode;
  /** Top-align instead of vertical-center. Use in short containers. */
  compact?: boolean;
  className?: string;
}

/**
 * Centered vertical stack used inside panels/modals when a list is empty.
 * Sober by design: muted icon, one-line title, optional short description,
 * optional primary Button. Matches IntelliJ "No X yet" tool-window placeholders.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
  className = '',
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center ${
        compact ? 'justify-start pt-6' : 'justify-center'
      } px-6 py-8 gap-2 text-center ${className}`}
    >
      {icon && (
        <div className="w-8 h-8 flex items-center justify-center text-text-tertiary">
          {icon}
        </div>
      )}
      <div className="text-[13px] font-medium text-text-primary">{title}</div>
      {description && (
        <div className="text-[12px] text-text-tertiary max-w-[220px] leading-[1.5]">
          {description}
        </div>
      )}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}
