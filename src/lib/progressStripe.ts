export interface StripeStyle {
  mode: 'indeterminate' | 'determinate';
  /** Only set when mode === 'determinate'. e.g. '62%'. */
  width?: string;
}

/**
 * Resolve the visual state for ProgressStripe. Undefined or NaN => indeterminate
 * (animated slide). Numeric input is clamped to [0, 1] and rendered as a
 * percentage. Extracted for unit-testing per the codebase's existing style.
 */
export function computeStripeStyle(value: number | undefined): StripeStyle {
  if (value === undefined || Number.isNaN(value)) return { mode: 'indeterminate' };
  const clamped = Math.max(0, Math.min(1, value));
  return { mode: 'determinate', width: `${Math.round(clamped * 100)}%` };
}
