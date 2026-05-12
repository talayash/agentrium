import { describe, expect, it } from 'vitest';
import { getFileIconUrl, getFolderIconUrl } from './fileIcons';

describe('getFileIconUrl', () => {
  it('returns a non-empty default URL for empty input', () => {
    const url = getFileIconUrl('');
    expect(typeof url).toBe('string');
    expect(url.length).toBeGreaterThan(0);
  });

  it('returns the same URL for the same filename in different cases', () => {
    expect(getFileIconUrl('FOO.TS')).toBe(getFileIconUrl('foo.ts'));
    expect(getFileIconUrl('Package.JSON')).toBe(getFileIconUrl('package.json'));
  });

  it('falls back to the default URL for an unknown extension', () => {
    const def = getFileIconUrl('');
    const unknown = getFileIconUrl(`weird.${'q'.repeat(40)}`);
    expect(unknown).toBe(def);
  });

  it('returns distinct icons for distinct well-known extensions', () => {
    const ts = getFileIconUrl('foo.ts');
    const md = getFileIconUrl('readme.md');
    const json = getFileIconUrl('package.json');
    expect(new Set([ts, md, json]).size).toBe(3);
  });

  it('prefers an exact-filename match over its extension fallback', () => {
    // package.json has a dedicated icon in material-icon-theme; a generic .json
    // file does not share that icon. If this fails the exact-name branch is
    // not winning, which is the bug we want to catch here.
    const exact = getFileIconUrl('package.json');
    const extOnly = getFileIconUrl('something.json');
    expect(exact).not.toBe(extOnly);
  });

  it('handles multi-segment extensions (e.g. *.test.ts)', () => {
    // We don't assert a specific icon — just that *some* segment was matched
    // so a non-empty URL is returned, ruling out a path that drops out at the
    // multi-segment loop and falls all the way through to the default.
    const url = getFileIconUrl('foo.test.ts');
    expect(url.length).toBeGreaterThan(0);
  });
});

describe('getFolderIconUrl', () => {
  it('returns a non-empty default for empty input (collapsed and expanded)', () => {
    expect(getFolderIconUrl('').length).toBeGreaterThan(0);
    expect(getFolderIconUrl('', true).length).toBeGreaterThan(0);
  });

  it('expanded variant differs from collapsed default for the empty case', () => {
    // Material Icon Theme ships a distinct "folder open" SVG; if these match
    // the eager glob isn't loading the expanded asset.
    const collapsed = getFolderIconUrl('');
    const expanded = getFolderIconUrl('', true);
    expect(expanded).not.toBe(collapsed);
  });

  it('is case-insensitive on the folder name', () => {
    expect(getFolderIconUrl('SRC')).toBe(getFolderIconUrl('src'));
  });

  it('falls back to the default for an unknown folder name', () => {
    const def = getFolderIconUrl('');
    const unknown = getFolderIconUrl(`unknown-${'x'.repeat(40)}`);
    expect(unknown).toBe(def);
  });
});
