import { describe, expect, it } from 'vitest';
import { KEYMAP, keymapByGroup, matchesKeyCode } from './keymap';

// Build a synthetic KeyboardEvent-like object with just the fields
// `matchesKeyCode` reads. Using a plain object keeps the tests running under
// jsdom (real KeyboardEvent needs a Window) and mirrors the shape of what the
// browser dispatches. Adding `type: 'keydown'` isn't required by the helper
// but documents intent.
function evt(code: string, key = ''): KeyboardEvent {
  return { code, key, type: 'keydown' } as unknown as KeyboardEvent;
}

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

// #57 - Ctrl+letter shortcuts silently broke under non-Latin layouts because
// the handlers compared `e.key` (the LOCALIZED character) against a Latin
// letter. `matchesKeyCode` compares `e.code` (the PHYSICAL key) instead, so
// Ctrl+V works whether the user is on English, Hebrew, Cyrillic, Arabic, etc.
describe('matchesKeyCode', () => {
  it('matches the physical letter key regardless of what character the layout produces', () => {
    // The physical V key. `e.key` differs per layout:
    //   English  → 'v'
    //   Hebrew   → 'ה' (Heh)
    //   Cyrillic → 'м' (Cyrillic em)
    //   Arabic   → 'ر' (Reh)
    //   Greek    → 'ω' (Omega)
    // Only the physical position ('KeyV') is layout-invariant.
    expect(matchesKeyCode(evt('KeyV', 'v'), 'V')).toBe(true);
    expect(matchesKeyCode(evt('KeyV', 'ה'), 'V')).toBe(true);
    expect(matchesKeyCode(evt('KeyV', 'м'), 'V')).toBe(true);
    expect(matchesKeyCode(evt('KeyV', 'ر'), 'V')).toBe(true);
    expect(matchesKeyCode(evt('KeyV', 'ω'), 'V')).toBe(true);
  });

  it('accepts both lowercase and uppercase letter arguments', () => {
    // Ergonomic - callers can write matchesKeyCode(e, 'v') or 'V' equivalently.
    expect(matchesKeyCode(evt('KeyC'), 'c')).toBe(true);
    expect(matchesKeyCode(evt('KeyC'), 'C')).toBe(true);
  });

  it('is case-invariant on the code side - CapsLock does not break it', () => {
    // Under a real CapsLock the browser still emits code 'KeyV'; the change
    // is in `e.key` only, which the helper does not read. This is why the old
    // `key.toLowerCase()` hack in TerminalView is no longer necessary.
    expect(matchesKeyCode(evt('KeyV', 'V'), 'V')).toBe(true);
    expect(matchesKeyCode(evt('KeyV', 'v'), 'V')).toBe(true);
  });

  it('matches digits via DigitN codes', () => {
    // Ctrl+0 zoom-reset. Physical digit row still reports DigitN codes even
    // when a layout remaps the shifted characters.
    expect(matchesKeyCode(evt('Digit0'), '0')).toBe(true);
    expect(matchesKeyCode(evt('Digit9'), '9')).toBe(true);
  });

  it('does not match other physical keys with the same character', () => {
    // If a layout happens to place 'V' on a different physical key (or the
    // user hits a different key producing 'v'), the helper must NOT match -
    // that would defeat the whole point of using `code`.
    expect(matchesKeyCode(evt('KeyB', 'v'), 'V')).toBe(false);
    expect(matchesKeyCode(evt('KeyC', 'v'), 'V')).toBe(false);
    expect(matchesKeyCode(evt('Numpad0'), '0')).toBe(false);
  });

  it('rejects non-letter/non-digit arguments defensively', () => {
    // Callers should use e.key for symbols/function keys; the helper only
    // handles letters + digits. Returning false (not throwing) keeps the
    // dispatcher safe if someone passes an unexpected string.
    expect(matchesKeyCode(evt('KeyV'), 'VV')).toBe(false);
    expect(matchesKeyCode(evt('KeyV'), '')).toBe(false);
    expect(matchesKeyCode(evt('Comma', ','), ',')).toBe(false);
    expect(matchesKeyCode(evt('F1'), 'F1')).toBe(false);
  });
});
