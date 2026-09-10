import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { usePasteStore, type PasteEntry } from './pasteStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const entry = (name: string): PasteEntry => ({
  file_name: name, relative_path: `.pastes/${name}`, absolute_path: `/repo/.pastes/${name}`,
  size_bytes: 300, created_at: '2026-09-10T00:00:00Z', detected_kind: 'text',
});
const store = () => usePasteStore.getState();

describe('paste history', () => {
  beforeEach(() => usePasteStore.setState({ byTerminal: new Map() }));

  it('keeps newest first, bounds previews and isolates terminal histories', () => {
    store().add('one', entry('old'), 'old');
    store().add('two', entry('other'), 'other');
    store().add('one', entry('new'), 'x'.repeat(300));
    expect(store().list('one').map((e) => e.file_name)).toEqual(['new', 'old']);
    expect(store().list('one')[0].preview).toBe('x'.repeat(200));
    expect(store().list('two')[0].preview).toBe('other');
    expect(store().list('unknown')).toEqual([]);
  });

  it('evicts the oldest paste after fifty entries without mutating previous state', () => {
    store().add('one', entry('0'), 'first');
    const previous = store().byTerminal;
    for (let i = 1; i <= 50; i++) store().add('one', entry(String(i)), 'content');
    expect(store().list('one')).toHaveLength(50);
    expect(store().list('one')[0].file_name).toBe('50');
    expect(store().list('one')[49].file_name).toBe('1');
    expect(previous.get('one')).toHaveLength(1);
  });

  it('removes and clears only the requested terminal history', () => {
    store().add('one', entry('same'), 'one');
    store().add('two', entry('same'), 'two');
    store().remove('one', 'same');
    expect(store().list('one')).toEqual([]);
    expect(store().list('two')).toHaveLength(1);
    store().clearForTerminal('one');
    expect(store().byTerminal.has('one')).toBe(false);
    expect(store().list('two')).toHaveLength(1);
  });

  it('restores disk metadata without inventing content previews', async () => {
    vi.mocked(invoke).mockResolvedValue([entry('saved')]);
    store().add('other', entry('keep'), 'keep');
    await store().hydrateFromDisk('one');
    expect(invoke).toHaveBeenCalledWith('list_pastes', { terminalId: 'one' });
    expect(store().list('one')).toEqual([{ ...entry('saved'), preview: '' }]);
    expect(store().list('other')[0].preview).toBe('keep');
  });

  it('retains existing history if the disk lookup fails', async () => {
    store().add('one', entry('keep'), 'keep');
    vi.mocked(invoke).mockRejectedValue(new Error('directory missing'));
    await expect(store().hydrateFromDisk('one')).resolves.toBeUndefined();
    expect(store().list('one')[0].preview).toBe('keep');
  });
});
