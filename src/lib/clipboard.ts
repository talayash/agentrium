// Clipboard write that survives WebView2's focus gating.
//
// The async Clipboard API (`navigator.clipboard.writeText`) rejects with
// `NotAllowedError: Document is not focused` when `document.hasFocus()` is
// false. In this frameless/transparent Tauri window that happens after the
// user drag-selects on the terminal canvas - the document reports unfocused at
// the instant Ctrl+C fires, so the copy silently failed.
//
// We try the modern API first (works from button clicks where focus is intact)
// and fall back to the legacy `execCommand('copy')` path, which is synchronous,
// runs inside the user gesture, and is NOT gated on document focus.
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return execCommandCopy(text);
  }
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
