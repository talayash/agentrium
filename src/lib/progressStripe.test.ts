import { describe, it, expect } from 'vitest';
import { computeStripeStyle } from './progressStripe';

describe('computeStripeStyle', () => {
  it('returns indeterminate mode when value is undefined', () => {
    const s = computeStripeStyle(undefined);
    expect(s.mode).toBe('indeterminate');
    expect(s.width).toBeUndefined();
  });

  it('returns determinate mode with clamped width when value is provided', () => {
    expect(computeStripeStyle(0.5)).toEqual({ mode: 'determinate', width: '50%' });
    expect(computeStripeStyle(0)).toEqual({ mode: 'determinate', width: '0%' });
    expect(computeStripeStyle(1)).toEqual({ mode: 'determinate', width: '100%' });
  });

  it('clamps out-of-range values', () => {
    expect(computeStripeStyle(-0.2)).toEqual({ mode: 'determinate', width: '0%' });
    expect(computeStripeStyle(1.5)).toEqual({ mode: 'determinate', width: '100%' });
  });

  it('treats NaN as indeterminate (defensive)', () => {
    expect(computeStripeStyle(Number.NaN)).toEqual({ mode: 'indeterminate' });
  });
});
