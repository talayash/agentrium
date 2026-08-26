import { useEffect } from 'react';
import { useTerminalStore } from '../store/terminalStore';

// WebView2's default context menu includes a "Refresh" item that reloads the
// top-level document - which throws away every open terminal (they're not
// persisted). F5 / Ctrl+R are intercepted by useKeyboardShortcuts. This hook
// closes the remaining vectors:
//
//   1. Global `contextmenu` handler that suppresses the browser-native menu
//      everywhere EXCEPT text inputs, xterm helper textareas, and Monaco
//      editors - those retain native cut/copy/paste + spell-check.
//   2. `beforeunload` handler that cancels any refresh attempt while
//      terminals are open (belt-and-suspenders against menu vectors we
//      haven't thought of).
//
// Tauri closes windows via the OS `close_requested` event, not through
// `beforeunload`, so blocking beforeunload does NOT prevent the user from
// actually closing the app.
const NATIVE_MENU_SELECTORS = [
  'input',
  'textarea',
  '.monaco-editor',
  '.xterm-helper-textarea',
  '[contenteditable="true"]',
].join(', ');

export function usePreventWebviewReload() {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(NATIVE_MENU_SELECTORS)) return;
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
