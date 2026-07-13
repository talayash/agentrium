import { forwardRef } from 'react';
import type { ReactNode, MouseEvent, KeyboardEvent, CSSProperties } from 'react';

export type ListRowVariant = 'default' | 'compact';

interface ListRowProps {
  selected?: boolean;
  disabled?: boolean;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  onContextMenu?: (e: MouseEvent<HTMLElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  /** Optional leading icon/dot. Rendered before children. */
  leading?: ReactNode;
  /** Optional right-aligned meta slot (kbd chip, count, date). */
  trailing?: ReactNode;
  /** Render as a <button> (default - keyboard-clickable) or a <div> (for
   *  wrapping already-interactive children). */
  as?: 'button' | 'div';
  /** 'default' = 26px; 'compact' = 22px. */
  variant?: ListRowVariant;
  title?: string;
  ariaLabel?: string;
  className?: string;
  /** Inline style overrides - used e.g. for tree indent (`paddingLeft`). */
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * Canonical selectable list item. Selected state gets an accent-blue tint
 * plus a 2 px stripe on the left (IntelliJ tool-window selection). Hover
 * state is `bg-white/[0.045]`, consistent across every migrated surface.
 *
 * When `as="button"` (default), the row is keyboard-focusable and inherits
 * the global `:focus-visible` outline from index.css.
 */
export const ListRow = forwardRef<HTMLElement, ListRowProps>(function ListRow(
  {
    selected = false,
    disabled = false,
    onClick,
    onContextMenu,
    onKeyDown,
    leading,
    trailing,
    as = 'button',
    variant = 'default',
    title,
    ariaLabel,
    className = '',
    style,
    children,
  },
  ref,
) {
  const height = variant === 'compact' ? 'h-[22px]' : 'h-[26px]';
  const base = `relative flex items-center gap-2 w-full px-3 text-left transition-colors ${height}`;
  const state = selected
    ? 'bg-accent-primary/12 text-text-primary'
    : 'text-text-primary hover:bg-white/[0.045]';
  const disabledCls = disabled ? 'opacity-50 cursor-default pointer-events-none' : '';

  const content = (
    <>
      {selected && (
        <span
          aria-hidden
          className="absolute left-0 top-[3px] bottom-[3px] w-[2px] rounded-r-[2px] bg-accent-primary"
        />
      )}
      {leading && <span className="flex-shrink-0 flex items-center">{leading}</span>}
      <span className="flex-1 min-w-0 flex items-center gap-2 overflow-hidden">{children}</span>
      {trailing && <span className="flex-shrink-0 flex items-center">{trailing}</span>}
    </>
  );

  if (as === 'div') {
    return (
      <div
        ref={ref as React.Ref<HTMLDivElement>}
        role="option"
        aria-selected={selected}
        aria-disabled={disabled || undefined}
        aria-label={ariaLabel}
        title={title}
        onClick={disabled ? undefined : onClick}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        style={style}
        className={`${base} ${state} ${disabledCls} ${className}`}
      >
        {content}
      </div>
    );
  }

  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      type="button"
      aria-selected={selected}
      aria-label={ariaLabel}
      disabled={disabled}
      title={title}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      style={style}
      className={`${base} ${state} ${disabledCls} ${className}`}
    >
      {content}
    </button>
  );
});
