import { useEffect } from 'react';
import { useTerminalStore } from '../store/terminalStore';

// WebView2's default context menu includes a "Refresh" item that reloads the
// top-level document - which throws away every open terminal (they're not
// persisted). F5 / Ctrl+R are intercepted by useKeyboardShortcuts. This hook
// closes the remaining vectors:
//
//   1. Global `contextmenu` handler that suppresses the browser-native menu
//      everywhere, with no exceptions.
//   2. `beforeunload` handler that cancels any refresh attempt while
//      terminals are open (belt-and-suspenders against menu vectors we
//      haven't thought of).
//
// This used to exempt text inputs, xterm helper textareas, and Monaco editors
// so they kept native cut/copy/paste + spell-check - but that handed those
// fields the full native menu, Refresh included, re-opening the exact hole this
// hook exists to close. The editing commands are now supplied in-app instead:
// `InputContextMenu` for inputs and textareas, `TerminalView`'s own menu for
// the terminal, and Monaco's built-in menu (its own DOM widget, unaffected by
// preventDefault here) for the editor.
//
// Tauri closes windows via the OS `close_requested` event, not through
// `beforeunload`, so blocking beforeunload does NOT prevent the user from
// actually closing the app.

export function usePreventWebviewReload() {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const hasTerminals = useTerminalStore.getState().terminals.size > 0;
      if (!hasTerminals) return;
      e.preventDefault();
      // Some engines still require returnValue to be set.
      e.returnValue = '';
    };

    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);
}
