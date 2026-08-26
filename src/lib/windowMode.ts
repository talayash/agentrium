import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export type WindowMode = 'main' | 'detached' | 'dragpreview';

export interface WindowModeInfo {
  mode: WindowMode;
  /** Terminal ids this detached window should adopt on boot. Empty for main. */
  initialIds: string[];
  /** This window's Tauri label, e.g. 'main' or 'detached-<uuid>'. */
  label: string;
}

let cached: WindowModeInfo | null = null;

/**
 * Determine whether this webview is the main window or a torn-off ("detached")
 * window. Detached windows are created by the tab-transfer engine with a URL
 * like `index.html?mode=detached&ids=<id,id,...>`. Resolved synchronously from
 * the URL + the current window label so it's available at first render (before
 * any of App.tsx's setup/restore effects run).
 */
export function getWindowMode(): WindowModeInfo {
  if (cached) return cached;

  const params = new URLSearchParams(window.location.search);
  const rawMode = params.get('mode');
  const mode: WindowMode =
    rawMode === 'detached' ? 'detached' : rawMode === 'dragpreview' ? 'dragpreview' : 'main';
  const idsParam = params.get('ids') ?? '';
  const initialIds = idsParam
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // The Tauri window label is the source of truth for the transfer engine
  // (routing targets a label). `.label` is a synchronous property in Tauri v2.
  let label = mode === 'detached' ? 'detached' : 'main';
  try {
    label = getCurrentWebviewWindow().label;
  } catch {
    // Outside a Tauri context (e.g. vitest/jsdom) - keep the derived fallback.
  }

  cached = { mode, initialIds, label };
  return cached;
}
