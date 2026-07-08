import { describe, it, expect } from 'vitest';
import { computeTooltipPosition } from './tooltipPosition';

const viewport = { width: 1000, height: 800 };
const tip = { width: 100, height: 24 };

describe('computeTooltipPosition', () => {
  it('centers below the anchor for side=bottom', () => {
    const anchor = { left: 450, top: 10, width: 100, height: 28 };
    const pos = computeTooltipPosition(anchor, tip, 'bottom', viewport);
    expect(pos).toEqual({ left: 450, top: 10 + 28 + 6 });
  });

  it('centers above the anchor for side=top', () => {
    const anchor = { left: 450, top: 100, width: 100, height: 28 };
    const pos = computeTooltipPosition(anchor, tip, 'top', viewport);
    expect(pos).toEqual({ left: 450, top: 100 - 6 - 24 });
  });

  it('places beside the anchor for side=right', () => {
    const anchor = { left: 0, top: 100, width: 40, height: 36 };
    const pos = computeTooltipPosition(anchor, tip, 'right', viewport);
    expect(pos).toEqual({ left: 40 + 6, top: 100 + 18 - 12 });
  });

  it('flips top -> bottom when the anchor hugs the top edge', () => {
    const anchor = { left: 450, top: 2, width: 100, height: 28 };
    const pos = computeTooltipPosition(anchor, tip, 'top', viewport);
    expect(pos.top).toBe(2 + 28 + 6); // below instead
  });

  it('flips right -> left when the anchor hugs the right edge', () => {
    const anchor = { left: 970, top: 100, width: 30, height: 36 };
    const pos = computeTooltipPosition(anchor, tip, 'right', viewport);
    expect(pos.left).toBe(970 - 6 - 100); // left of anchor instead
  });

  it('clamps horizontally so the tooltip never leaves the viewport', () => {
    const anchor = { left: 0, top: 100, width: 20, height: 28 };
    const pos = computeTooltipPosition(anchor, tip, 'bottom', viewport);
    expect(pos.left).toBe(4); // PAD, not negative from centering
  });

  it('clamps at the far edge too', () => {
    const anchor = { left: 990, top: 100, width: 10, height: 28 };
    const pos = computeTooltipPosition(anchor, tip, 'bottom', viewport);
    expect(pos.left).toBe(1000 - 100 - 4);
  });
});
