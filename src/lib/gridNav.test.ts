import { describe, expect, it } from 'vitest';
import { computeGridNavTarget, type GridNavKey } from './gridNav';

// Build a key-event shape. Defaults to a bare Alt press; override per case.
const k = (over: Partial<GridNavKey>): GridNavKey => ({
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  key: '',
  code: '',
  ...over,
});

describe('computeGridNavTarget - pass-through (returns null)', () => {
  it('ignores bare arrow keys so they reach the terminal', () => {
    expect(computeGridNavTarget(k({ altKey: false, key: 'ArrowRight' }), 0, 2, 4)).toBeNull();
    expect(computeGridNavTarget(k({ altKey: false, key: 'ArrowUp' }), 2, 2, 4)).toBeNull();
  });

  it('ignores Alt combined with Ctrl or Meta', () => {
    expect(computeGridNavTarget(k({ ctrlKey: true, key: 'ArrowRight' }), 0, 2, 4)).toBeNull();
    expect(computeGridNavTarget(k({ metaKey: true, key: 'ArrowRight' }), 0, 2, 4)).toBeNull();
  });

  it('ignores when the grid is empty', () => {
    expect(computeGridNavTarget(k({ key: 'ArrowRight' }), 0, 2, 0)).toBeNull();
  });

  it('ignores non-navigation keys', () => {
    expect(computeGridNavTarget(k({ key: 'a', code: 'KeyA' }), 0, 2, 4)).toBeNull();
    expect(computeGridNavTarget(k({ key: 'Enter', code: 'Enter' }), 0, 2, 4)).toBeNull();
  });
});

describe('computeGridNavTarget - Alt+Arrow spatial moves (cols=2, count=4)', () => {
  it('moves right and clamps at the last pane', () => {
    expect(computeGridNavTarget(k({ key: 'ArrowRight' }), 0, 2, 4)).toBe(1);
    expect(computeGridNavTarget(k({ key: 'ArrowRight' }), 3, 2, 4)).toBe(3);
  });

  it('moves left and clamps at the first pane', () => {
    expect(computeGridNavTarget(k({ key: 'ArrowLeft' }), 2, 2, 4)).toBe(1);
    expect(computeGridNavTarget(k({ key: 'ArrowLeft' }), 0, 2, 4)).toBe(0);
  });

  it('moves down/up by one row (cols)', () => {
    expect(computeGridNavTarget(k({ key: 'ArrowDown' }), 0, 2, 4)).toBe(2);
    expect(computeGridNavTarget(k({ key: 'ArrowDown' }), 3, 2, 4)).toBe(3); // clamp
    expect(computeGridNavTarget(k({ key: 'ArrowUp' }), 2, 2, 4)).toBe(0);
    expect(computeGridNavTarget(k({ key: 'ArrowUp' }), 0, 2, 4)).toBe(0); // clamp
  });

  it('selects the first pane on the first Alt+Arrow when nothing is focused', () => {
    expect(computeGridNavTarget(k({ key: 'ArrowRight' }), null, 2, 4)).toBe(0);
    expect(computeGridNavTarget(k({ key: 'ArrowDown' }), null, 2, 4)).toBe(0);
  });
});

describe('computeGridNavTarget - Alt+Digit jump (count=4)', () => {
  it('jumps to the pane at that number, regardless of current focus', () => {
    expect(computeGridNavTarget(k({ key: '1', code: 'Digit1' }), null, 2, 4)).toBe(0);
    expect(computeGridNavTarget(k({ key: '2', code: 'Digit2' }), 3, 2, 4)).toBe(1);
    expect(computeGridNavTarget(k({ key: '4', code: 'Digit4' }), 0, 2, 4)).toBe(3);
  });

  it('ignores digits out of range', () => {
    expect(computeGridNavTarget(k({ key: '0', code: 'Digit0' }), 0, 2, 4)).toBeNull();
    expect(computeGridNavTarget(k({ key: '5', code: 'Digit5' }), 0, 2, 4)).toBeNull();
  });
});
