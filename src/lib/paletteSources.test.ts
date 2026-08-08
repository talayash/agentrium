import { describe, it, expect } from 'vitest';
import { PALETTE_SOURCES } from './paletteSources';

describe('PALETTE_SOURCES', () => {
  it('contains the four expected sources in order', () => {
    expect(PALETTE_SOURCES.map((s) => s.id)).toEqual([
      'terminals',
      'commands',
      'hints',
      'snippets',
    ]);
  });

  it('each source has required fields', () => {
    expect(PALETTE_SOURCES.length).toBe(4);
    for (const src of PALETTE_SOURCES) {
      expect(typeof src.id).toBe('string');
      expect(typeof src.label).toBe('string');
      expect(typeof src.category).toBe('string');
      // LucideIcon is a React.forwardRef component — object in current lucide-react,
      // function in older builds. Both are renderable.
      expect(['function', 'object']).toContain(typeof src.icon);
      expect(src.icon).toBeTruthy();
    }
  });

  it('prefix chars are unique across sources that declare one', () => {
    const prefixes = PALETTE_SOURCES.map((s) => s.prefix).filter(
      (p): p is string => typeof p === 'string',
    );
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
