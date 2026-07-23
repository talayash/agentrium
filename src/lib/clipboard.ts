// Clipboard access that survives WebView2's focus gating.
//
// The async Clipboard API (`navigator.clipboard.writeText/readText`) rejects
// with `NotAllowedError: Document is not focused` when `document.hasFocus()` is
// false. In this frameless/transparent Tauri window that happens routinely -
// right after the user drag-selects on the terminal canvas, or whenever the app
// isn't the OS foreground window - so copy/paste failed intermittently.
//
// The robust path is the OS-native clipboard on the Rust side (via
// tauri-plugin-clipboard-manager). The actual read/write happens in the backend
// process, so it is completely immune to WebView2 document-focus and
// user-activation gating: it works regardless of focus state. We try it first,
// then fall back to the web APIs (for running the UI in a plain browser during
// dev, where the Tauri IPC bridge is absent).
import { writeText as tauriWriteText, readText as tauriReadText } from '@tauri-apps/plugin-clipboard-manager';
import { reportError } from './errorReporter';

export async function copyText(text: string): Promise<boolean> {
  // 1. Native OS clipboard via Tauri - the reliable path in this window.
  let nativeErr: unknown;
  try {
    await tauriWriteText(text);
    return true;
  } catch (e) {
    // Not running under Tauri (dev-in-browser) or the IPC call failed - fall
    // through to the web APIs.
    nativeErr = e;
  }
  // 2. Web Clipboard API - works from button clicks where the document is
  //    focused, and in a plain browser.
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 3. Legacy synchronous fallback - last resort.
    const ok = execCommandCopy(text);
    if (!ok) {
      // Every path failed: the user's copy did nothing. The clipboard plugin
      // is not a wrapped command, so this is the only place it gets reported.
      reportError(
        'clipboard_copy',
        `all clipboard paths failed; native: ${nativeErr instanceof Error ? nativeErr.message : String(nativeErr)}`,
      );
    }
    return ok;
  }
}

export async function readClipboardText(): Promise<string> {
  // Mirror of copyText: native first (immune to focus gating), web fallback.
  try {
    return (await tauriReadText()) ?? '';
  } catch {
    // Not under Tauri or IPC failed - fall through.
  }
  return navigator.clipboard.readText();
}

function execCommandCopy(text: string): boolean {
  // Focusing the hidden textarea steals focus from whatever was active (the
  // xterm helper textarea); restore it afterwards so typing keeps working.
  const prev = document.activeElement;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Keep it off-screen and out of layout, but still focusable/selectable.
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.opacity = '0';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  } finally {
    if (prev instanceof HTMLElement) prev.focus();
  }
}
