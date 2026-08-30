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
 * Canonical selectable list item. Selected state is a macOS-sidebar-style
 * inset rounded fill in the accent tint; hover is a fainter inset fill,
 * consistent across every migrated surface. The fill is a positioned
 * backdrop layer, so row geometry (full-width, px-3) is unchanged for
 * consumers - only the paint is inset.
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
  // `min-h` (not `h`) lets multi-line content (e.g. session widget) grow.
  const height = variant === 'compact' ? 'min-h-[22px]' : 'min-h-[26px]';
  const base = `group relative flex items-center gap-2 w-full px-3 py-0.5 text-left text-text-primary ${height}`;
  const disabledCls = disabled ? 'opacity-50 cursor-default pointer-events-none' : '';

  const content = (
    <>
      {/* Inset rounded selection/hover backdrop (paints under the relative
          content spans below). Instant on hover - feedback is response. */}
      <span
        aria-hidden
        className={`absolute inset-y-[1px] left-1 right-1 rounded-md transition-colors duration-100 ${
          selected ? 'bg-accent-primary/15' : 'bg-transparent group-hover:bg-fill-hover'
        }`}
      />
      {leading && <span className="relative flex-shrink-0 flex items-center">{leading}</span>}
      <span className="relative flex-1 min-w-0 flex items-center gap-2 overflow-hidden">{children}</span>
      {trailing && <span className="relative flex-shrink-0 flex items-center">{trailing}</span>}
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
        className={`${base} ${disabledCls} ${className}`}
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
      className={`${base} ${disabledCls} ${className}`}
    >
      {content}
    </button>
  );
});
