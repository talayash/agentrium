import { invoke } from '@tauri-apps/api/core';
import { reportInvokeFailure } from './errorReporter';

/**
 * Open a link clicked in a terminal in the system browser.
 *
 * Shared by both xterm link paths: WebLinksAddon (plain URL text) and the
 * `linkHandler` option (OSC 8 hyperlinks, which CLIs like Codex and Claude
 * Code emit for OAuth and docs links). Without `linkHandler`, xterm's
 * built-in OSC 8 fallback calls `window.confirm` + `window.open`, which the
 * ConfirmShim blocks, so the click silently did nothing. The Rust command
 * rejects anything that is not http(s).
 */
export function openTerminalLink(uri: string): void {
  invoke('open_external_url', { url: uri }).catch((err) => {
    reportInvokeFailure('open_external_url', err);
  });
}
