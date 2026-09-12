import { RefreshCw, CheckCircle2, CloudOff, AlertCircle, Pause } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useSyncStore } from '../store/syncStore';
import { syncNow } from '../lib/sync';
import { Tooltip } from './ui/Tooltip';

/**
 * Titlebar chip showing current sync state. Hidden for guests and while auth
 * mode is 'unknown'. Clickable — triggers a `sync_now` IPC on click.
 *
 * Colors use the app's semantic tokens:
 *   Idle    = neutral (text-tertiary)
 *   Syncing = accent (text-accent-primary) + animate-spin
 *   Paused  = neutral (text-text-secondary)
 *   Offline = warning (text-warning)
 *   Error   = error (text-error)
 *
 * When `enabled === false`, effective state is `paused` regardless of what
 * the engine reports (the engine may be in `idle` because it hasn't received
 * the SetEnabled command yet).
 */
export function SyncStatusChip() {
  const mode = useAuthStore((s) => s.mode);
  const status = useSyncStore((s) => s.status);
  const enabled = useSyncStore((s) => s.enabled);
  const queueDepth = useSyncStore((s) => s.queueDepth);
  const lastPulledAt = useSyncStore((s) => s.lastPulledAt);
  const lastError = useSyncStore((s) => s.lastError);

  if (mode !== 'authed') return null;

  const effective = !enabled ? 'paused' : status;
  const { Icon, spin, tone, label } = viewFor(effective, queueDepth);
  const tooltip = tooltipFor(effective, queueDepth, lastPulledAt, lastError);

  return (
    <Tooltip label={tooltip}>
      <button
        type="button"
        onClick={() => syncNow()}
        disabled={!enabled}
        aria-label={`Sync: ${label}`}
        className={`no-drag h-7 px-2 flex items-center gap-1.5 rounded-md hover:bg-fill-hover transition-colors ${tone}`}
      >
        <Icon size={13} className={spin ? 'animate-spin' : ''} />
        {queueDepth > 0 && enabled && (
          <span className="text-[10px] font-mono">{queueDepth}</span>
        )}
      </button>
    </Tooltip>
  );
}

function viewFor(status: string, queueDepth: number) {
  switch (status) {
    case 'syncing':
      return { Icon: RefreshCw, spin: true, tone: 'text-accent-primary', label: 'Syncing' };
    case 'paused':
      return { Icon: Pause, spin: false, tone: 'text-text-secondary', label: 'Paused' };
    case 'offline':
      return { Icon: CloudOff, spin: false, tone: 'text-warning', label: 'Offline' };
    case 'error':
      return { Icon: AlertCircle, spin: false, tone: 'text-error', label: 'Error' };
    case 'idle':
    default:
      return queueDepth > 0
        ? { Icon: RefreshCw, spin: false, tone: 'text-text-tertiary', label: 'Pending' }
        : { Icon: CheckCircle2, spin: false, tone: 'text-text-tertiary', label: 'Synced' };
  }
}

function tooltipFor(
  status: string,
  queueDepth: number,
  lastPulledAt: string | null,
  lastError: string | null,
): string {
  const pulled = lastPulledAt
    ? `Last pulled ${new Date(lastPulledAt).toLocaleTimeString()}`
    : 'Not yet pulled';
  switch (status) {
    case 'syncing':
      return 'Syncing…';
    case 'paused':
      return `Sync paused. ${queueDepth} change${queueDepth === 1 ? '' : 's'} pending.`;
    case 'offline':
      return 'Offline. Changes will sync when the connection returns.';
    case 'error':
      return lastError ? `Sync error: ${lastError}` : 'Sync error';
    default:
      return queueDepth > 0
        ? `${queueDepth} change${queueDepth === 1 ? '' : 's'} pending. ${pulled}`
        : `Synced. ${pulled}`;
  }
}
