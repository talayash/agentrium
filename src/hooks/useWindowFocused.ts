// Tracks whether the app window currently has focus, used by the session-state
// notification rule to suppress alerts for a session the user is looking at.

import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let receivedFocusEvent = false;

    win.isFocused().then((value) => {
      if (!cancelled && !receivedFocusEvent) setFocused(value);
    }).catch(() => { /* default true */ });
    win
      .onFocusChanged(({ payload }) => {
        receivedFocusEvent = true;
        if (!cancelled) setFocused(payload);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => { /* ignore */ });

    return () => { cancelled = true; unlisten?.(); };
  }, []);

  return focused;
}
