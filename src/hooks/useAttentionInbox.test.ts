import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
import { subscribeAttentionInbox } from './useAttentionInbox';
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';
import { useAttentionStore } from '../store/attentionStore';
import { clearTerminalActivity, markTerminalSubmission } from '../lib/terminalActivity';

// The user pressing Enter in the terminal. Distinct timestamps per call.
const submit = () => { vi.advanceTimersByTime(10); markTerminalSubmission('one'); };

const config: TerminalConfig = { id: 'one', label: 'Session one', nickname: null, profile_id: null,
  working_directory: '/project', claude_args: [], env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'claude' };
let unsubscribe: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  clearTerminalActivity('one');
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
  it('dismisses only the current waiting episode and rearms after new input', () => {
    const store = useTerminalStore.getState();
    store.setTerminalState('one', 'waiting');
    expect(useAttentionStore.getState().items[0].kind).toBe('input');
    useAttentionStore.getState().dismiss('one');
    store.setTerminalState('one', 'waiting');
    store.updateTerminalStatus('one', 'Running');
    expect(useAttentionStore.getState().items).toEqual([]);
    // A repaint (busy flicker) is not new input: the dismissal holds.
    store.setTerminalState('one', 'busy');
    store.setTerminalState('one', 'waiting');
    expect(useAttentionStore.getState().items).toEqual([]);
    submit();
    store.setTerminalState('one', 'busy');
    store.setTerminalState('one', 'waiting');
    expect(useAttentionStore.getState().items).toHaveLength(1);
  });
  it('raises review only for a submitted turn, and a repaint never undoes Mark reviewed', () => {
    const store = useTerminalStore.getState();
    // Startup output settling: no prompt was sent, nothing to review.
    store.setTerminalState('one', 'busy');
    store.setTerminalState('one', 'idle');
    expect(useAttentionStore.getState().items).toEqual([]);
    submit();
    store.setTerminalState('one', 'busy');
    store.setTerminalState('one', 'idle');
    expect(useAttentionStore.getState().items[0].kind).toBe('review');
    useAttentionStore.getState().markReviewed('one', 'session');
    // Opening the session repaints it.
    store.setTerminalState('one', 'busy');
    store.setTerminalState('one', 'idle');
    expect(useAttentionStore.getState().items).toHaveLength(1);
    expect(useAttentionStore.getState().items[0].reviewedAt).toEqual(expect.any(Number));
    // The next prompt resolves it; its turn raises a fresh item.
    submit();
    store.setTerminalState('one', 'busy');
    expect(useAttentionStore.getState().items).toEqual([]);
    store.setTerminalState('one', 'idle');
    expect(useAttentionStore.getState().items[0]).toMatchObject({ kind: 'review' });
    expect(useAttentionStore.getState().items[0].reviewedAt).toBeUndefined();
  });
  it('does not treat answering the startup trust prompt as a turn to review', () => {
    const store = useTerminalStore.getState();
    store.setTerminalState('one', 'waiting');
    submit();
    store.setTerminalState('one', 'busy');
    expect(useAttentionStore.getState().items).toEqual([]);
    store.setTerminalState('one', 'idle');
    expect(useAttentionStore.getState().items).toEqual([]);
    // Later repaints are not prompts either.
    store.setTerminalState('one', 'busy');
    store.setTerminalState('one', 'idle');
    expect(useAttentionStore.getState().items).toEqual([]);
    // A real prompt afterwards does produce a review item.
    submit();
    store.setTerminalState('one', 'busy');
    store.setTerminalState('one', 'idle');
    expect(useAttentionStore.getState().items[0].kind).toBe('review');
  });
  it('treats only the first settle after a prompt as the end of the turn', () => {
    const store = useTerminalStore.getState();
    submit();
    store.setTerminalState('one', 'busy');
    store.setTerminalState('one', 'idle');
    useAttentionStore.getState().dismiss('one');
    // Minutes later the session repaints (resize, theme, focus).
    store.setTerminalState('one', 'busy');
    store.setTerminalState('one', 'idle');
    expect(useAttentionStore.getState().items).toEqual([]);
  });
  it('clears an input request once the prompt goes away without Enter', () => {
    const store = useTerminalStore.getState();
    store.setTerminalState('one', 'waiting');
    store.setTerminalState('one', 'idle');
    expect(useAttentionStore.getState().items).toEqual([]);
  });
  it('replaces review items with input requests and clears stale items on activity or removal', () => {
    const store = useTerminalStore.getState();
    submit();
    store.setTerminalState('one', 'busy');
    store.setTerminalState('one', 'idle');
    expect(useAttentionStore.getState().items[0].kind).toBe('review');
    store.setTerminalState('one', 'waiting');
    expect(useAttentionStore.getState().items).toHaveLength(1);
    expect(useAttentionStore.getState().items[0].kind).toBe('input');
    submit();
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
