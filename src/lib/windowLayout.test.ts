import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentGeometry, getDetachedEntries, keyOf, removeEntry, upsertEntry } from './windowLayout';

const win = vi.hoisted(() => ({ outerPosition: vi.fn(), outerSize: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }));
const key = 'ct-window-layout';

describe('window layout persistence', () => {
  beforeEach(() => localStorage.clear());

  it('uses session identity with a working-directory fallback', () => {
    expect(keyOf({ claude_session_id: 's1', working_directory: '/repo' })).toBe('sid:s1');
    expect(keyOf({ claude_session_id: null, working_directory: '/repo' })).toBe('cwd:/repo');
  });

  it('updates and removes one window without losing others; excludes main', () => {
    upsertEntry('main', { sessionKeys: ['main'] });
    upsertEntry('one', { sessionKeys: ['old'] });
    upsertEntry('two', { sessionKeys: ['two'] });
    upsertEntry('one', { sessionKeys: ['new'] });
    expect(getDetachedEntries()).toEqual([
      { label: 'one', entry: { sessionKeys: ['new'] } },
      { label: 'two', entry: { sessionKeys: ['two'] } },
    ]);
    removeEntry('one');
    removeEntry('missing');
    expect(getDetachedEntries()).toEqual([{ label: 'two', entry: { sessionKeys: ['two'] } }]);
  });

  it.each(['{broken', 'null', '42', '"text"', '[]'])('recovers from invalid stored layout %s', (value) => {
    localStorage.setItem(key, value);
    expect(getDetachedEntries()).toEqual([]);
    expect(() => removeEntry('missing')).not.toThrow();
    upsertEntry('one', { sessionKeys: ['s1'] });
    expect(getDetachedEntries()).toEqual([{ label: 'one', entry: { sessionKeys: ['s1'] } }]);
  });

  it('drops malformed entries while preserving valid sessions and ignoring invalid geometry', () => {
    localStorage.setItem(key, JSON.stringify({
      good: { sessionKeys: ['s1'], geometry: { x: -100, y: 0, w: 800, h: 600 } },
      bad: null, wrongKeys: { sessionKeys: [1] },
      badGeometry: { sessionKeys: ['s2'], geometry: { x: 0, y: 0, w: -1, h: 600 } },
    }));
    expect(getDetachedEntries()).toEqual([
      { label: 'good', entry: { sessionKeys: ['s1'], geometry: { x: -100, y: 0, w: 800, h: 600 } } },
      { label: 'badGeometry', entry: { sessionKeys: ['s2'] } },
    ]);
  });

  it('tolerates unavailable storage and quota failures', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(getDetachedEntries()).toEqual([]);
    expect(() => upsertEntry('one', { sessionKeys: [] })).not.toThrow();
  });

  it('reads physical geometry including negative monitor coordinates', async () => {
    win.outerPosition.mockResolvedValue({ x: -1920, y: 20 });
    win.outerSize.mockResolvedValue({ width: 1000, height: 680 });
    expect(await currentGeometry()).toEqual({ x: -1920, y: 20, w: 1000, h: 680 });
  });

  it('tolerates a window closing during geometry lookup', async () => {
    win.outerPosition.mockRejectedValue(new Error('closed'));
    expect(await currentGeometry()).toBeUndefined();
  });
});
