import { beforeEach, describe, expect, it } from 'vitest';
import { usePreviewStore } from './previewStore';

describe('previewStore', () => {
  beforeEach(() => {
    usePreviewStore.setState({
      perTerminal: new Map(),
      globalOpen: false,
      allowList: [],
      keepAliveAcrossTabs: false,
      panelWidthPx: 640,
    });
  });

  it('seeds a terminal with defaults', () => {
    usePreviewStore.getState().seedTerminal('t1', {});
    const s = usePreviewStore.getState().perTerminal.get('t1');
    expect(s).toBeDefined();
    expect(s?.userOverride).toBeNull();
    expect(s?.frameworkHint).toBe('unknown');
    expect(s?.isOpen).toBe(false);
  });

  it('resolveUrl returns the URL the user typed', () => {
    usePreviewStore.getState().seedTerminal('t1', {});
    usePreviewStore.getState().setUserOverride('t1', 'http://localhost:3000');
    expect(usePreviewStore.getState().resolveUrl('t1')).toBe('http://localhost:3000');
  });

  it('resolveUrl returns null for an unknown terminal', () => {
    expect(usePreviewStore.getState().resolveUrl('nope')).toBeNull();
  });

  it('resolveUrl returns null when nothing is set', () => {
    usePreviewStore.getState().seedTerminal('t1', {});
    expect(usePreviewStore.getState().resolveUrl('t1')).toBeNull();
  });

  it('removeTerminal drops per-terminal state', () => {
    usePreviewStore.getState().seedTerminal('t1', {});
    usePreviewStore.getState().removeTerminal('t1');
    expect(usePreviewStore.getState().perTerminal.has('t1')).toBe(false);
  });

  it('toggleGlobal flips globalOpen', () => {
    expect(usePreviewStore.getState().globalOpen).toBe(false);
    usePreviewStore.getState().toggleGlobal();
    expect(usePreviewStore.getState().globalOpen).toBe(true);
    usePreviewStore.getState().toggleGlobal();
    expect(usePreviewStore.getState().globalOpen).toBe(false);
  });

  it('reload bumps reloadCounter', () => {
    usePreviewStore.getState().seedTerminal('t1', {});
    const before = usePreviewStore.getState().perTerminal.get('t1')?.reloadCounter ?? 0;
    usePreviewStore.getState().reload('t1');
    const after = usePreviewStore.getState().perTerminal.get('t1')?.reloadCounter ?? 0;
    expect(after).toBe(before + 1);
  });

  it('addToAllowList deduplicates', () => {
    usePreviewStore.getState().addToAllowList('*.ngrok.io');
    usePreviewStore.getState().addToAllowList('*.ngrok.io');
    expect(usePreviewStore.getState().allowList.filter((p) => p === '*.ngrok.io')).toHaveLength(1);
  });
});
