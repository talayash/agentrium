// Tracks whether the app window currently has focus, used by the session-state
// notification rule to suppress alerts for a session the user is looking at.

import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    win.isFocused().then(setFocused).catch(() => { /* default true */ });
    win
      .onFocusChanged(({ payload }) => setFocused(payload))
      .then((fn) => { unlisten = fn; })
      .catch(() => { /* ignore */ });

    return () => { unlisten?.(); };
  }, []);

  return focused;
}
