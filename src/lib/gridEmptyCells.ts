/** Hard cap on how many terminals can be placed in grid mode. */
export const MAX_GRID_TERMINALS = 8;

/**
 * Compute how many empty "add terminal" cells to render in the grid.
 *
 * The grid layout defines a fixed `cols * rows` slot capacity, but the app
 * also caps the maximum terminals a user can drop into the grid (default 8).
 * This helper returns whichever bound is smaller, clamped to a non-negative
 * integer so an over-filled or invalid state renders zero empty slots
 * rather than a negative array length.
 */
export function computeEmptyCellCount(params: {
  layoutCols: number;
  layoutRows: number;
  filledCount: number;
  maxTotal?: number;
}): number {
  const total = params.layoutCols * params.layoutRows;
  const cap = params.maxTotal ?? MAX_GRID_TERMINALS;
  return Math.max(0, Math.min(total - params.filledCount, cap - params.filledCount));
}
