import { describe, it, expect } from 'vitest';
import { isWithinDnd } from './notificationGate';

function at(hh: number, mm: number): Date {
  const d = new Date(2026, 5, 1, hh, mm, 0, 0);
  return d;
}

describe('isWithinDnd', () => {
  it('returns false when start equals end (window disabled)', () => {
    expect(isWithinDnd('00:00', '00:00', at(3, 0))).toBe(false);
  });

  it('handles a same-day window (09:00–17:00)', () => {
    expect(isWithinDnd('09:00', '17:00', at(12, 0))).toBe(true);
    expect(isWithinDnd('09:00', '17:00', at(8, 59))).toBe(false);
    expect(isWithinDnd('09:00', '17:00', at(17, 0))).toBe(false); // end exclusive
  });

  it('handles an overnight window (22:00–08:00)', () => {
    expect(isWithinDnd('22:00', '08:00', at(23, 30))).toBe(true);
    expect(isWithinDnd('22:00', '08:00', at(2, 0))).toBe(true);
    expect(isWithinDnd('22:00', '08:00', at(8, 0))).toBe(false); // end exclusive
    expect(isWithinDnd('22:00', '08:00', at(12, 0))).toBe(false);
  });

  it('treats malformed times as disabled (returns false)', () => {
    expect(isWithinDnd('bad', '08:00', at(2, 0))).toBe(false);
  });
});
