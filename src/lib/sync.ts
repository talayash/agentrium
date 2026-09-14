import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useSyncStore, type SyncStatus } from '../store/syncStore';
import { reportInvokeFailure } from './errorReporter';
import { toast } from '../store/toastStore';

interface SyncStatusPayload {
  status: SyncStatus;
  queue_depth: number;
  last_pulled_at: string | null;
  last_error: string | null;
}

interface GuestMigrationPayload {
  profiles: number;
  custom_agents: number;
  workspaces: number;
}

export async function getSyncEnabled(): Promise<boolean> {
  return invoke<boolean>('get_sync_enabled');
}

/**
 * Optimistically flips the local `enabled` state, then invokes the Rust
 * command. On failure, reverts and re-throws so callers can surface an error.
 */
export async function setSyncEnabled(enabled: boolean): Promise<void> {
  const previous = useSyncStore.getState().enabled;
  useSyncStore.getState().setEnabled(enabled);
  try {
    await invoke('set_sync_enabled', { enabled });
  } catch (err) {
    useSyncStore.getState().setEnabled(previous);
    reportInvokeFailure('set_sync_enabled', err);
    throw err;
  }
}

export async function syncNow(): Promise<void> {
  try {
    await invoke('sync_now');
  } catch (err) {
    reportInvokeFailure('sync_now', err);
  }
}

/**
 * Subscribe to sync engine status events. Call once on app boot.
 * Returns an unlisten fn.
 *
 * Also subscribes to `guest-migration-completed` — a one-shot event fired
 * by the Rust auth deep-link handler when a guest's local rows got seeded
 * into the account. Shows a toast summarising counts.
 */
export async function subscribeToSyncEvents(): Promise<UnlistenFn> {
  const unlistenStatus = await listen<SyncStatusPayload>('sync-status-changed', (event) => {
    const { status, queue_depth, last_pulled_at, last_error } = event.payload;
    useSyncStore.getState().setStatus({
      status,
      queueDepth: queue_depth,
      lastPulledAt: last_pulled_at,
      lastError: last_error,
    });
  });

  const unlistenMigration = await listen<GuestMigrationPayload>(
    'guest-migration-completed',
    (event) => {
      const { profiles, custom_agents, workspaces } = event.payload;
      const parts: string[] = [];
      if (profiles > 0) parts.push(`${profiles} profile${profiles === 1 ? '' : 's'}`);
      if (custom_agents > 0) parts.push(`${custom_agents} custom agent${custom_agents === 1 ? '' : 's'}`);
      if (workspaces > 0) parts.push(`${workspaces} workspace${workspaces === 1 ? '' : 's'}`);
      if (parts.length > 0) {
        toast.success('Signed in', `Imported ${parts.join(', ')} into your account.`);
      }
    },
  );

  return () => {
    unlistenStatus();
    unlistenMigration();
  };
}
