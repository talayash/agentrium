export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

const GAP = 6;
const PAD = 4;

function place(anchor: Rect, tip: Size, side: TooltipSide): { left: number; top: number } {
  const cx = anchor.left + anchor.width / 2;
  const cy = anchor.top + anchor.height / 2;
  switch (side) {
    case 'top':
      return { left: cx - tip.width / 2, top: anchor.top - GAP - tip.height };
    case 'bottom':
      return { left: cx - tip.width / 2, top: anchor.top + anchor.height + GAP };
    case 'left':
      return { left: anchor.left - GAP - tip.width, top: cy - tip.height / 2 };
    case 'right':
      return { left: anchor.left + anchor.width + GAP, top: cy - tip.height / 2 };
  }
}

/**
 * Position a tooltip next to its anchor: preferred side first, flipped to the
 * opposite side if it would leave the viewport on that axis, then clamped so
 * the tooltip always stays fully on screen.
 */
export function computeTooltipPosition(
  anchor: Rect,
  tip: Size,
  side: TooltipSide,
  viewport: Size,
): { left: number; top: number } {
  let pos = place(anchor, tip, side);

  const overflows =
    side === 'top' ? pos.top < PAD :
    side === 'bottom' ? pos.top + tip.height > viewport.height - PAD :
    side === 'left' ? pos.left < PAD :
    pos.left + tip.width > viewport.width - PAD;

  if (overflows) {
    const flipped: Record<TooltipSide, TooltipSide> = {
      top: 'bottom', bottom: 'top', left: 'right', right: 'left',
    };
    pos = place(anchor, tip, flipped[side]);
  }

  return {
    left: Math.min(Math.max(pos.left, PAD), viewport.width - tip.width - PAD),
    top: Math.min(Math.max(pos.top, PAD), viewport.height - tip.height - PAD),
  };
}
