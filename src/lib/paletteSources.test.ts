import { describe, it, expect } from 'vitest';
import { PALETTE_SOURCES } from './paletteSources';

describe('PALETTE_SOURCES', () => {
  it('is an array (may be empty until Task B populates it)', () => {
    expect(Array.isArray(PALETTE_SOURCES)).toBe(true);
  });

  it('each source has required fields when populated', () => {
    for (const src of PALETTE_SOURCES) {
      expect(typeof src.id).toBe('string');
      expect(typeof src.label).toBe('string');
      expect(typeof src.category).toBe('string');
      expect(typeof src.icon).toBe('function'); // LucideIcon is a Component function
    }
  });
});
