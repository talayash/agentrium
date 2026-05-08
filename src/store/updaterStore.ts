import { create } from 'zustand';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';

interface UpdateInfo {
  version: string;
  date: string;
  body: string;
}

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'up-to-date';

interface UpdaterState {
  status: UpdateStatus;
  updateInfo: UpdateInfo | null;
  downloadProgress: number;
  error: string | null;
  lastCheckAt: number | null;

  checkForUpdates: () => Promise<{ available: boolean }>;
  downloadAndInstall: (preFetched?: Update) => Promise<boolean>;
  restart: () => Promise<void>;
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: 'idle',
  updateInfo: null,
  downloadProgress: 0,
  error: null,
  lastCheckAt: null,

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
        // Analytics headers are optional — continue without them
      }

      const update = await check({ headers });

      if (update) {
        set({
          updateInfo: {
            version: update.version,
            date: update.date || '',
            body: update.body || '',
          },
          status: 'available',
        });
        return { available: true };
      } else {
        set({ status: 'up-to-date' });
        return { available: false };
      }
    } catch (err) {
      console.error('Update check failed:', err);
      set({
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to check for updates',
      });
      return { available: false };
    }
  },

  downloadAndInstall: async (preFetched?: Update) => {
    try {
      set({ status: 'downloading', downloadProgress: 0 });
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
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              set({ downloadProgress: Math.round((downloaded / contentLength) * 100) });
            }
            break;
          case 'Finished':
            set({ downloadProgress: 100 });
            break;
        }
      });

      set({ status: 'ready' });
      return true;
    } catch (err) {
      console.error('Update download failed:', err);
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
    }
    try {
      await relaunch();
    } catch (err) {
      console.error('Failed to restart:', err);
      set({ error: 'Failed to restart. Please restart manually.' });
    }
  },
}));
