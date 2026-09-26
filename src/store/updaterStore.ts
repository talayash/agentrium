import { create } from 'zustand';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { reportInvokeFailure } from '../lib/errorReporter';

// Reqwest / Tauri updater surface a handful of message shapes when the network
// is flaky, the GitHub edge is briefly unreachable, or the latest.json hasn't
// been published yet. None of them are actionable bugs, so we keep the UI
// status='error' but skip telemetry - otherwise a single user behind a hotel
// wifi can dominate the error report (see fingerprint 6d37063a).
const TRANSIENT_NETWORK_PATTERNS: readonly RegExp[] = [
  /error sending request/i,
  /could not fetch a valid release json/i,
  /connection (?:refused|reset|closed|aborted)/i,
  /dns (?:error|lookup)/i,
  /failed to lookup address/i,
  /timed? ?out/i,
  /network is unreachable/i,
  /no such host/i,
  /unable to (?:resolve|connect)/i,
];

export function isTransientNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!msg) return false;
  return TRANSIENT_NETWORK_PATTERNS.some((re) => re.test(msg));
}

interface UpdateInfo {
  version: string;
  date: string;
  body: string;
}

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'up-to-date';

// "Skip This Version" has to outlive the process - otherwise it is just a
// slower "Later". Kept in localStorage rather than the app's persisted store
// so an updater decision can't be lost to an appStore migration.
const SKIPPED_VERSION_KEY = 'claude-terminal-skipped-update';

function loadSkippedVersion(): string | null {
  try {
    return localStorage.getItem(SKIPPED_VERSION_KEY);
  } catch {
    // Storage disabled (private mode / hardened webview) - skip stays
    // session-only, which degrades to "Later" rather than breaking.
    return null;
  }
}

function persistSkippedVersion(version: string | null): void {
  try {
    if (version === null) localStorage.removeItem(SKIPPED_VERSION_KEY);
    else localStorage.setItem(SKIPPED_VERSION_KEY, version);
  } catch {
    // See loadSkippedVersion - non-fatal.
  }
}

interface UpdaterState {
  status: UpdateStatus;
  updateInfo: UpdateInfo | null;
  downloadProgress: number;
  /** Bytes pulled so far in the active download. The sheet shows real size
   *  ("11.2 MB of 18.4 MB") because a bare percentage hides a stalled
   *  transfer on a slow link. */
  downloadedBytes: number;
  /** Total size of the active download, 0 until the server reports it. */
  totalBytes: number;
  error: string | null;
  lastCheckAt: number | null;
  // Banner gating - keep the user in control of when they're prompted.
  bannerDismissedVersion: string | null;  // "Later" - suppress banner for this version until next launch
  bannerSnoozedUntil: number | null;       // "Remind in 4h" - epoch ms after which the banner may show again
  notifiedVersion: string | null;          // version we've already sent a desktop toast for (avoid duplicate toasts)
  skippedVersion: string | null;           // "Skip This Version" - suppressed across restarts until a newer one ships

  checkForUpdates: () => Promise<{ available: boolean }>;
  downloadAndInstall: (preFetched?: Update) => Promise<boolean>;
  restart: () => Promise<void>;
  dismissBanner: () => void;
  snoozeBanner: (ms: number) => void;
  markNotified: (version: string) => void;
  skipVersion: () => void;
  /** Forget every reason the update sheet is being withheld - dismissal,
   *  snooze and a persisted skip. Called when the user asks for the update
   *  directly (the title-bar pill), which overrides any earlier "not now". */
  clearDeferrals: () => void;
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: 'idle',
  updateInfo: null,
  downloadProgress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  error: null,
  lastCheckAt: null,
  bannerDismissedVersion: null,
  bannerSnoozedUntil: null,
  notifiedVersion: null,
  skippedVersion: loadSkippedVersion(),

  checkForUpdates: async () => {
    // Don't re-check if already downloading or ready
    const current = get().status;
    if (current === 'downloading' || current === 'ready') {
      return { available: current === 'ready' };
    }

    try {
      set({ status: 'checking', error: null, lastCheckAt: Date.now() });

      let headers: Record<string, string> = {};
      try {
        const [installationId, appVersion] = await Promise.all([
          invoke<string>('get_installation_id'),
          getVersion(),
        ]);
        headers = {
          'X-Installation-Id': installationId,
          'X-App-Version': appVersion,
          'X-OS': navigator.platform,
        };
      } catch {
        // Analytics headers are optional - continue without them
      }

      const update = await check({ headers });

      if (update) {
        const prevVersion = get().updateInfo?.version;
        // If a *newer* update appeared, reset any dismissal/snooze for the
        // previous version so the user is re-prompted for the new one.
        const versionChanged = prevVersion !== update.version;
        // A skip survives restarts, so it can't be keyed off `versionChanged`
        // (updateInfo is null on every launch, which would clear it at once).
        // It lapses only when a version OTHER than the skipped one ships.
        const skipLapsed =
          get().skippedVersion !== null && get().skippedVersion !== update.version;
        if (skipLapsed) persistSkippedVersion(null);
        set({
          updateInfo: {
            version: update.version,
            date: update.date || '',
            body: update.body || '',
          },
          status: 'available',
          ...(versionChanged
            ? { bannerDismissedVersion: null, bannerSnoozedUntil: null, notifiedVersion: null }
            : {}),
          ...(skipLapsed ? { skippedVersion: null } : {}),
        });
        return { available: true };
      } else {
        set({ status: 'up-to-date' });
        return { available: false };
      }
    } catch (err) {
      console.error('Update check failed:', err);
      if (!isTransientNetworkError(err)) {
        reportInvokeFailure('updater_check', err);
      }
      set({
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to check for updates',
      });
      return { available: false };
    }
  },

  downloadAndInstall: async (preFetched?: Update) => {
    try {
      set({ status: 'downloading', downloadProgress: 0, downloadedBytes: 0, totalBytes: 0 });
      const update = preFetched ?? (await check());
      if (!update) {
        set({ status: 'error', error: 'Update no longer available' });
        return false;
      }

      let downloaded = 0;
      let contentLength = 0;

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength || 0;
            set({ totalBytes: contentLength });
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            set({
              downloadedBytes: downloaded,
              ...(contentLength > 0
                ? { downloadProgress: Math.round((downloaded / contentLength) * 100) }
                : {}),
            });
            break;
          case 'Finished':
            set({ downloadProgress: 100, downloadedBytes: contentLength || downloaded });
            break;
        }
      });

      set({ status: 'ready' });
      return true;
    } catch (err) {
      console.error('Update download failed:', err);
      if (!isTransientNetworkError(err)) {
        reportInvokeFailure('updater_download_install', err);
      }
      const msg = err instanceof Error ? err.message : String(err);
      set({ status: 'error', error: `Failed to auto-update: ${msg}. Please download manually.` });
      return false;
    }
  },

  restart: async () => {
    try {
      await invoke('save_session_for_restore');
    } catch (err) {
      console.error('Failed to save session before restart:', err);
      reportInvokeFailure('save_session_for_restore', err);
    }
    try {
      await relaunch();
    } catch (err) {
      console.error('Failed to restart:', err);
      reportInvokeFailure('updater_restart', err);
      set({ error: 'Failed to restart. Please restart manually.' });
    }
  },

  dismissBanner: () => {
    const version = get().updateInfo?.version ?? null;
    set({ bannerDismissedVersion: version, bannerSnoozedUntil: null });
  },

  snoozeBanner: (ms: number) => {
    set({ bannerSnoozedUntil: Date.now() + ms, bannerDismissedVersion: null });
  },

  markNotified: (version: string) => {
    set({ notifiedVersion: version });
  },

  skipVersion: () => {
    const version = get().updateInfo?.version ?? null;
    persistSkippedVersion(version);
    set({ skippedVersion: version, bannerSnoozedUntil: null });
  },

  clearDeferrals: () => {
    persistSkippedVersion(null);
    set({ bannerDismissedVersion: null, bannerSnoozedUntil: null, skippedVersion: null });
  },
}));
