import { describe, expect, it } from 'vitest';
import { computeEmptyCellCount } from './gridEmptyCells';

describe('computeEmptyCellCount', () => {
  it('returns 4 empty cells for a 2x2 layout with 0 filled', () => {
    expect(
      computeEmptyCellCount({ layoutCols: 2, layoutRows: 2, filledCount: 0 })
    ).toBe(4);
  });

  it('returns 0 empty cells for a 2x2 layout when full', () => {
    expect(
      computeEmptyCellCount({ layoutCols: 2, layoutRows: 2, filledCount: 4 })
    ).toBe(0);
  });

  it('returns 1 empty cell for a 2x2 layout with 3 filled', () => {
    expect(
      computeEmptyCellCount({ layoutCols: 2, layoutRows: 2, filledCount: 3 })
    ).toBe(1);
  });

  it('returns 3 empty cells for a 2x4 layout with 5 filled', () => {
    expect(
      computeEmptyCellCount({ layoutCols: 2, layoutRows: 4, filledCount: 5 })
    ).toBe(3);
  });

  it('returns 0 empty cells for a 2x4 layout when full', () => {
    expect(
      computeEmptyCellCount({ layoutCols: 2, layoutRows: 4, filledCount: 8 })
    ).toBe(0);
  });

  it('returns 8 empty cells for a 2x4 layout with 0 filled', () => {
    expect(
      computeEmptyCellCount({ layoutCols: 2, layoutRows: 4, filledCount: 0 })
    ).toBe(8);
  });

  it('clamps to the default maxTotal cap of 8 for a 3x3 layout with 0 filled', () => {
    // 3x3 = 9 slots, but the 8-cap wins.
    expect(
      computeEmptyCellCount({ layoutCols: 3, layoutRows: 3, filledCount: 0 })
    ).toBe(8);
  });

  it('clamps to 0 when filledCount exceeds the layout capacity', () => {
    // Invalid state (5 filled in a 4-slot layout) should not go negative.
    expect(
      computeEmptyCellCount({ layoutCols: 2, layoutRows: 2, filledCount: 5 })
    ).toBe(0);
  });

  it('honors a custom maxTotal smaller than the layout capacity', () => {
    expect(
      computeEmptyCellCount({
        layoutCols: 2,
        layoutRows: 2,
        filledCount: 0,
        maxTotal: 2,
      })
    ).toBe(2);
  });
});
