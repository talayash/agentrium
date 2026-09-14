import { describe, it, expect, beforeEach } from 'vitest';
import { useSyncStore } from './syncStore';

beforeEach(() => {
  useSyncStore.setState({
    status: 'idle',
    enabled: true,
    queueDepth: 0,
    lastPulledAt: null,
    lastError: null,
  });
});

describe('syncStore', () => {
  it('patches status without wiping other fields', () => {
    useSyncStore.getState().setStatus({ queueDepth: 3 });
    useSyncStore.getState().setStatus({ status: 'syncing' });
    expect(useSyncStore.getState().queueDepth).toBe(3);
    expect(useSyncStore.getState().status).toBe('syncing');
  });

  it('setEnabled toggles independently of status', () => {
    useSyncStore.getState().setEnabled(false);
    expect(useSyncStore.getState().enabled).toBe(false);
    expect(useSyncStore.getState().status).toBe('idle');
  });

  it('setStatus can update multiple fields at once', () => {
    useSyncStore.getState().setStatus({
      status: 'error',
      lastError: 'boom',
      queueDepth: 5,
    });
    const s = useSyncStore.getState();
    expect(s.status).toBe('error');
    expect(s.lastError).toBe('boom');
    expect(s.queueDepth).toBe(5);
  });
});
