import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';

vi.mock('../lib/sync', () => ({ syncNow: vi.fn() }));
vi.mock('./ui/Tooltip', () => ({ Tooltip: ({ children }: any) => children }));

import { SyncStatusChip } from './SyncStatusChip';
import { useAuthStore } from '../store/authStore';
import { useSyncStore } from '../store/syncStore';
import { syncNow } from '../lib/sync';

beforeEach(() => {
  useAuthStore.setState({
    mode: 'authed',
    user: { id: 'u', email: 'e', name: 'n', image: null },
  } as any);
  useSyncStore.setState({
    status: 'idle',
    enabled: true,
    queueDepth: 0,
    lastPulledAt: null,
    lastError: null,
  } as any);
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('SyncStatusChip', () => {
  it('renders nothing for guest users', () => {
    useAuthStore.setState({ mode: 'guest', user: null } as any);
    const { container } = render(<SyncStatusChip />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when auth mode is unknown', () => {
    useAuthStore.setState({ mode: 'unknown', user: null } as any);
    const { container } = render(<SyncStatusChip />);
    expect(container.firstChild).toBeNull();
  });

  it('renders "Synced" label when idle + queue empty', () => {
    render(<SyncStatusChip />);
    expect(screen.getByLabelText('Sync: Synced')).toBeTruthy();
  });

  it('shows queue depth badge when > 0', () => {
    useSyncStore.setState({ status: 'idle', enabled: true, queueDepth: 3 } as any);
    render(<SyncStatusChip />);
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('does not show badge when paused (queueDepth invisible while off)', () => {
    useSyncStore.setState({ status: 'syncing', enabled: false, queueDepth: 5 } as any);
    render(<SyncStatusChip />);
    // Badge is hidden because enabled=false
    expect(screen.queryByText('5')).toBeNull();
  });

  it('shows "Paused" when enabled=false regardless of status', () => {
    useSyncStore.setState({ status: 'syncing', enabled: false, queueDepth: 0 } as any);
    render(<SyncStatusChip />);
    expect(screen.getByLabelText('Sync: Paused')).toBeTruthy();
  });

  it('triggers sync_now on click when enabled', async () => {
    const user = userEvent.setup();
    render(<SyncStatusChip />);
    await user.click(screen.getByRole('button'));
    expect(syncNow).toHaveBeenCalled();
  });

  it('is disabled and does not fire when paused', async () => {
    useSyncStore.setState({ status: 'idle', enabled: false, queueDepth: 0 } as any);
    const user = userEvent.setup();
    render(<SyncStatusChip />);
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await user.click(btn);
    expect(syncNow).not.toHaveBeenCalled();
  });
});
