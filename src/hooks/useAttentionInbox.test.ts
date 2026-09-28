import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
import { subscribeAttentionInbox } from './useAttentionInbox';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';
import { useAttentionStore } from '../store/attentionStore';

const config: TerminalConfig = { id: 'one', label: 'Session one', nickname: null, profile_id: null,
  working_directory: '/project', claude_args: [], env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'claude' };
let unsubscribe: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  useTerminalStore.setState({ terminals: new Map([['one', { config, xterm: null, isWorktree: false }]]), terminalStates: new Map() });
  useAttentionStore.setState({ items: [] });
  unsubscribe = subscribeAttentionInbox();
});
afterEach(() => { unsubscribe(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('attention inbox lifecycle', () => {
  it('does not flag initial idle sessions as completed work', () => {
    useTerminalStore.getState().setTerminalState('one', 'idle');
    expect(useAttentionStore.getState().items).toEqual([]);
  });
  it('dismisses only the current waiting episode and rearms after activity', () => {
    const store = useTerminalStore.getState();
    store.setTerminalState('one', 'waiting');
    expect(useAttentionStore.getState().items[0].kind).toBe('input');
    useAttentionStore.getState().dismiss('one');
    store.setTerminalState('one', 'waiting');
    store.updateTerminalStatus('one', 'Running');
    expect(useAttentionStore.getState().items).toEqual([]);
    store.setTerminalState('one', 'busy');
    store.setTerminalState('one', 'waiting');
    expect(useAttentionStore.getState().items).toHaveLength(1);
  });
  it('replaces review items with input requests and clears stale items on activity or removal', () => {
    const store = useTerminalStore.getState();
    store.setTerminalState('one', 'busy');
    store.setTerminalState('one', 'idle');
    expect(useAttentionStore.getState().items[0].kind).toBe('review');
    store.setTerminalState('one', 'waiting');
    expect(useAttentionStore.getState().items).toHaveLength(1);
    expect(useAttentionStore.getState().items[0].kind).toBe('input');
    store.setTerminalState('one', 'busy');
    expect(useAttentionStore.getState().items).toEqual([]);
    store.setTerminalState('one', 'waiting');
    useTerminalStore.setState({ terminals: new Map() });
    expect(useAttentionStore.getState().items).toEqual([]);
  });
  it('routes failed scripts to their parent and never overwrites errors with inferred state', () => {
    const terminals = new Map(useTerminalStore.getState().terminals);
    terminals.set('script', { config: { ...config, id: 'script' }, xterm: null, isWorktree: false,
      scriptName: 'test', scriptParentId: 'one' });
    useTerminalStore.setState({ terminals });
    useTerminalStore.getState().updateTerminalStatus('script', 'Error');
    useTerminalStore.getState().setTerminalState('script', 'stopped');
    expect(useAttentionStore.getState().items[0]).toMatchObject({ kind: 'error', terminalId: 'script', targetId: 'one', title: 'test' });
    useTerminalStore.setState({ terminals: new Map() });
    expect(useAttentionStore.getState().items).toEqual([]);
  });
  it('ignores plain shells and reports process exits without claiming success', () => {
    const terminals = new Map(useTerminalStore.getState().terminals);
    terminals.set('shell', { config: { ...config, id: 'shell', status: 'Error' }, xterm: null, isWorktree: false, isShellTerminal: true });
    useTerminalStore.setState({ terminals });
    expect(useAttentionStore.getState().items).toEqual([]);
    useTerminalStore.getState().updateTerminalStatus('one', 'Stopped');
    expect(useAttentionStore.getState().items[0].kind).toBe('stopped');
  });
});
