import { describe, expect, it } from 'vitest';
import { KEYMAP, keymapByGroup } from './keymap';

describe('keymap', () => {
  it('every entry has the required fields', () => {
    for (const e of KEYMAP) {
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.shortcut.length).toBeGreaterThan(0);
      expect(['Terminals', 'Navigation', 'Editing', 'View', 'Git']).toContain(e.group);
    }
  });

  it('ids are unique', () => {
    const ids = KEYMAP.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keymapByGroup buckets every entry exactly once', () => {
    const groups = keymapByGroup();
    const flattened = Object.values(groups).flat();
    expect(flattened).toHaveLength(KEYMAP.length);

    // Every entry appears in exactly one group, matching its own .group field.
    for (const e of KEYMAP) {
      const bucket = groups[e.group];
      expect(bucket).toContain(e);
    }
  });

  it('Toggle Explorer (Ctrl+B) is in View, not Navigation', () => {
    const entry = KEYMAP.find((e) => e.id === 'toggle-explorer');
    expect(entry?.label).toBe('Toggle Explorer');
    expect(entry?.group).toBe('View');
    expect(entry?.shortcut).toMatch(/B$/);
  });

  it('zoom shortcuts use a literal MOD prefix', () => {
    const zoomIn = KEYMAP.find((e) => e.id === 'terminal-zoom-in');
    expect(zoomIn?.shortcut).toMatch(/^(Ctrl|Cmd)\+=$/);
  });
});
