import { describe, expect, it } from 'vitest';
import { CATEGORY_GROUPS, NAV_SECTIONS, pageKey, registerSetting, searchSettings, sectionForPage } from './index';

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

  it('the claude group is labelled Agents and leads with the Agents & Keys page', () => {
    const g = CATEGORY_GROUPS.find((x) => x.id === 'claude')!;
    expect(g.label).toBe('Agents');
    expect(g.pages[0]).toEqual({ id: 'agents-keys', label: 'Agents & Keys' });
    expect(g.pages.map((p) => p.id)).toEqual(['agents-keys', 'defaults', 'learn', 'updates']);
  });
});

describe('settings sidebar sections', () => {
  it('flattens the groups into nine sidebar sections in display order', () => {
    expect(NAV_SECTIONS.map((s) => s.id)).toEqual([
      'general', 'terminal', 'editor', 'agents', 'git', 'tools', 'notifications', 'keymap', 'privacy-about',
    ]);
  });

  it('shows every registered page exactly once', () => {
    const all = CATEGORY_GROUPS.flatMap((g) => g.pages.map((p) => pageKey({ group: g.id, page: p.id }))).sort();
    const shown = NAV_SECTIONS.flatMap((s) => s.pages).sort();
    expect(shown).toEqual(all);
  });

  it('finds the context meter settings under General', async () => {
    await import('./categories/AppearancePage');
    const ids = (q: string) => searchSettings(q).map((d) => d.id);
    expect(ids('context window')).toEqual(expect.arrayContaining(['context-meter', 'claude-context-window']));
    expect(ids('1m')).toContain('claude-context-window');
    const hit = searchSettings('claude context window').find((d) => d.id === 'claude-context-window')!;
    expect(sectionForPage(pageKey(hit.category))).toBe('general');
  });

  it('sectionForPage maps a search hit back to its sidebar section', () => {
    expect(sectionForPage('terminal.pastes')).toBe('terminal');
    expect(sectionForPage('appearance-behavior.startup-session')).toBe('general');
    expect(sectionForPage('vcs.changelists')).toBe('git');
    expect(sectionForPage('nope.nope')).toBeUndefined();
  });
});
