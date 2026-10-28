import { invoke } from '@tauri-apps/api/core';
import { reportInvokeFailure } from './errorReporter';
import { useBrowserStore } from '../store/browserStore';
import { openInNewTab } from './browser/controller';

const LOCAL_DEV_URL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i;

/**
 * Open a link clicked in a terminal in the system browser.
 *
 * Shared by both xterm link paths: WebLinksAddon (plain URL text) and the
 * `linkHandler` option (OSC 8 hyperlinks, which CLIs like Codex and Claude
 * Code emit for OAuth and docs links). Without `linkHandler`, xterm's
 * built-in OSC 8 fallback calls `window.confirm` + `window.open`, which the
 * ConfirmShim blocks, so the click silently did nothing. The Rust command
 * rejects anything that is not http(s).
 *
 * While the built-in browser is open, local dev-server links open there
 * instead. Everything else (OAuth, docs) keeps going to the system browser,
 * where the user is already signed in.
 */
export function openTerminalLink(uri: string): void {
  if (useBrowserStore.getState().open && LOCAL_DEV_URL.test(uri)) {
    void openInNewTab(uri);
    return;
  }
  invoke('open_external_url', { url: uri }).catch((err) => {
    reportInvokeFailure('open_external_url', err);
  });
}
