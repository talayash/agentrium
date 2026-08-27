import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { reportInvokeFailure } from '../lib/errorReporter';

export function useNotification() {
  const notify = useCallback(async (title: string, body: string) => {
    try {
      await invoke('send_notification', { title, body });
    } catch (e) {
      reportInvokeFailure('send_notification', e);
    }
  }, []);

  return { notify };
}
