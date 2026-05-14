import { describe, expect, it } from 'vitest';
import { CATEGORY_GROUPS, registerSetting, searchSettings } from './index';

describe('settings index', () => {
  it('CATEGORY_GROUPS covers the seven IntelliJ-style buckets', () => {
    const ids = CATEGORY_GROUPS.map((g) => g.id);
    expect(ids).toEqual([
      'appearance-behavior',
      'editor',
      'terminal',
      'vcs',
      'claude',
      'tools',
      'privacy-about',
    ]);
  });

  it('every page in every group has a unique (group,page) pair', () => {
    const pairs = CATEGORY_GROUPS.flatMap((g) => g.pages.map((p) => `${g.id}.${p.id}`));
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('searchSettings returns no results for empty query', () => {
    registerSetting({
      category: { group: 'appearance-behavior', page: 'appearance' },
      id: 'test-key', label: 'Test Key', keywords: ['searchable'],
    });
    expect(searchSettings('')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
  });

  it('searchSettings matches by label substring (case-insensitive)', () => {
    registerSetting({
      category: { group: 'editor', page: 'general' },
      id: 'tab-size-unique-marker', label: 'Tab Size Unique Marker', keywords: [],
    });
    const found = searchSettings('UNIQUE MARKER');
    expect(found.some((s) => s.id === 'tab-size-unique-marker')).toBe(true);
  });

  it('searchSettings matches by keyword', () => {
    registerSetting({
      category: { group: 'privacy-about', page: 'privacy' },
      id: 'telemetry-test-marker', label: 'Analytics opt-out', keywords: ['telemetry-test-key'],
    });
    const found = searchSettings('telemetry-test-key');
    expect(found.some((s) => s.id === 'telemetry-test-marker')).toBe(true);
  });
});
